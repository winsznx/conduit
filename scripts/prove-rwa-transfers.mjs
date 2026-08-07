#!/usr/bin/env node
/**
 * The phase 03 gate, against the registered CVA on live Base Sepolia.
 *
 *   eligible transfer succeeds
 *   ineligible transfer fails through CCP policy
 *   reservation prevents seller double-spend
 *
 * Every answer comes from the deployed CCP policy. `ConduitRWACVA` holds no
 * eligibility opinion of its own — it calls `policy.canTransfer` on every
 * transfer and a refusal is a refusal — so a proof that consulted anything else
 * would be proving the wrong thing.
 *
 * **How ineligibility is produced matters, and the obvious way is wrong.**
 * Sending to an address that holds no CVI does not fail. Mapping the live policy
 * for both our CVA and Cleanverse's own aUSDC gives the same shape:
 *
 *   me -> random1        allowed      (me is compliant)
 *   random1 -> me        allowed      (me is compliant)
 *   random1 -> random2   refused      (neither party is)
 *
 * So the policy is not a per-recipient allowlist. Building the "ineligible"
 * case out of an unknown counterparty would have produced a passing transfer and
 * an evidence file claiming a gate that had not been met.
 *
 * What the policy does enforce is the RuleV2 tier floor against a party's CVI.
 * This run therefore moves the floor across the holder's real tier and asks the
 * same question either side of it: same token, same parties, same amount, one
 * rule change. The refusal is the live policy applying our configured rule, not
 * a contrived address.
 *
 *   node --env-file=.env scripts/prove-rwa-transfers.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, createWalletClient, http, parseAbi, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ROOT } from './lib/run.mjs';

const TOKEN = process.env['RWA_CVA_ADDRESS'];
const POLICY = process.env['CCP_POLICY_BASE_SEPOLIA'];
const RULE_TUPLE = '(bytes2,bytes2,uint8,uint8,bool,uint256)';
const COUNTERPARTY = '0x000000000000000000000000000000000000dEaD';

const TOKEN_ABI = parseAbi([
  'function mint(address to, uint256 amount)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function reserveForSettlement(bytes32 settlementId, uint256 amount)',
  'function reservedBalanceOf(address owner) view returns (uint256)',
  'function availableBalanceOf(address owner) view returns (uint256)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function grantRole(bytes32,address)',
  `function setRuleV2(${RULE_TUPLE} rule)`,
  `function getRulesV2() view returns (${RULE_TUPLE}[])`,
]);

const account = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const transport = http(process.env['BASE_SEPOLIA_RPC_URL']);
const pub = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport, chain: { id: 84532 } });

const chainId = await pub.getChainId();
if (chainId !== 84532) throw new Error(`RPC reports chain ${chainId}, expected 84532`);

const send = async (functionName, args) => {
  const hash = await wallet.writeContract({ address: TOKEN, abi: TOKEN_ABI, functionName, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status, blockNumber: receipt.blockNumber };
};

const read = (functionName, args = []) =>
  pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName, args });

/**
 * Waits until a read reflects a write that has already been mined.
 *
 * The public Base Sepolia endpoint served every read here one step behind:
 * after a confirmed `setRuleV2(30)` the policy still returned the previous
 * rule, and a balance read straight after a confirmed transfer still showed the
 * pre-transfer figure. Evidence assembled from those reads describes a state
 * that never existed.
 *
 * Pinning the read to the receipt's block is the more precise fix and the
 * endpoint refuses it — it is not archival, and a historical `eth_call` answers
 * "Requested resource not found". So this polls `latest` instead, and asserts
 * what it is waiting for rather than sleeping and hoping: a run where the write
 * never lands fails here instead of quietly recording the stale value.
 */
async function readUntil(label, fetch, matches, budgetMs = 60_000) {
  const deadline = Date.now() + budgetMs;
  let last;
  while (Date.now() < deadline) {
    last = await fetch();
    if (matches(last)) return last;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(
    `${label}: never observed the expected state; last read ${JSON.stringify(last, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
  );
}

const decode = (error) => {
  const text = error instanceof Error ? error.message : String(error);
  return {
    revertedWith: text.match(/Error:\s*([A-Za-z_][A-Za-z0-9_]*\([^)]*\))/)?.[1] ?? 'revert',
    revertedAccount: text.match(/\b(0x[0-9a-fA-F]{40})\b/)?.[1] ?? null,
  };
};

/** Real transfers, not simulations: the gate says succeeds and fails. */
const attemptTransfer = async (to, amount) => {
  try {
    const hash = await wallet.writeContract({
      address: TOKEN,
      abi: TOKEN_ABI,
      functionName: 'transfer',
      args: [to, amount],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    return { sent: true, status: receipt.status, hash, blockNumber: receipt.blockNumber };
  } catch (error) {
    return { sent: false, ...decode(error) };
  }
};

const setFloor = async (minTier) => {
  const tx = await send('setRuleV2', [['0x0000', '0x0000', minTier, 0, false, 0n]]);
  // Read back from the policy, which is the contract a third party would query,
  // at the block that contains the write.
  const rules = await readUntil(
    `setRuleV2(${minTier})`,
    () =>
      pub.readContract({
        address: POLICY,
        abi: parseAbi([`function getRulesV2(address) view returns (${RULE_TUPLE}[])`]),
        functionName: 'getRulesV2',
        args: [TOKEN],
      }),
    (r) => r.length === 1 && Number(r[0][2]) === minTier,
  );
  return { tx: { hash: tx.hash, status: tx.status }, rules: rules.map((r) => r.map(String)) };
};

console.log(`Base Sepolia ${chainId}`);
console.log(`token   ${TOKEN}`);
console.log(`policy  ${POLICY}`);
console.log(`holder  ${account.address}\n`);

const MINTER_ROLE = await read('MINTER_ROLE');
if (!(await read('hasRole', [MINTER_ROLE, account.address]))) {
  await send('grantRole', [MINTER_ROLE, account.address]);
}
if ((await read('balanceOf', [account.address])) < 1_000_000n) {
  await send('mint', [account.address, 1_000_000n]);
}

// ── Ineligible: the holder's CVI is below the configured floor ──────────────

console.log("── ineligible: rule floor raised above the holder's tier ──");
const raised = await setFloor(30);
console.log(`  setRuleV2 minTier=30  ${raised.tx.status}  rules ${JSON.stringify(raised.rules)}`);

const ineligible = await attemptTransfer(COUNTERPARTY, 1000n);
console.log(
  `  transfer  ${ineligible.sent ? `SENT (${ineligible.status})` : `refused ${ineligible.revertedWith} ${ineligible.revertedAccount ?? ''}`}`,
);

// ── Eligible: the same transfer, with the floor at or below that tier ───────

console.log('\n── eligible: same token, same parties, floor lowered ──');
const lowered = await setFloor(20);
console.log(`  setRuleV2 minTier=20  ${lowered.tx.status}  rules ${JSON.stringify(lowered.rules)}`);

const balanceBefore = await read('balanceOf', [account.address]);
const eligible = await attemptTransfer(COUNTERPARTY, 1000n);
const balanceAfter = eligible.sent
  ? await readUntil(
      'holder balance after the eligible transfer',
      () => read('balanceOf', [account.address]),
      (b) => b === balanceBefore - 1000n,
    )
  : balanceBefore;
console.log(
  `  transfer  ${eligible.sent ? `${eligible.status}  ${eligible.hash}` : `refused ${eligible.revertedWith}`}`,
);
console.log(`  holder balance ${balanceBefore} → ${balanceAfter}`);

// ── Reservation protection (invariant R1) ──────────────────────────────────
//
// The seller reserves, then tries to move more than the unreserved remainder.
// The token refuses without any settlement contract being involved, which is
// what makes the reservation a property of the asset rather than of the escrow.

console.log('\n── reservation prevents double-spend ──');
const settlementId = toHex('conduit-phase-03-reservation', { size: 32 });
const heldBefore = await read('balanceOf', [account.address]);
const alreadyReserved = await read('reservedBalanceOf', [account.address]);

let reserveTx = null;
if (alreadyReserved === 0n) {
  reserveTx = await send('reserveForSettlement', [settlementId, heldBefore / 2n]);
  console.log(`  reserve  ${reserveTx.status}  ${reserveTx.hash}`);
} else {
  console.log(`  reserve  already held: ${alreadyReserved}`);
}

const expectedReserve = alreadyReserved === 0n ? heldBefore / 2n : alreadyReserved;
const reserved = await readUntil(
  'reserved balance',
  () => read('reservedBalanceOf', [account.address]),
  (r) => r === expectedReserve,
);
const available = await read('availableBalanceOf', [account.address]);
console.log(`  balance ${heldBefore}  reserved ${reserved}  available ${available}`);

const overspend = await attemptTransfer(COUNTERPARTY, available + 1n);
console.log(
  `  spend available+1  ${overspend.sent ? `SENT (${overspend.status}) — R1 VIOLATED` : `refused ${overspend.revertedWith}`}`,
);

const withinAvailable = await attemptTransfer(COUNTERPARTY, available);
console.log(
  `  spend available    ${withinAvailable.sent ? withinAvailable.status : `refused ${withinAvailable.revertedWith}`}`,
);
// The reservation must survive spending everything outside it. That is the
// property: reserved units are not merely accounted for, they are unspendable.
const reservedAfter = await readUntil(
  'reserved balance after spending everything available',
  () => read('reservedBalanceOf', [account.address]),
  () => true,
);
console.log(`  reserved after spending everything available: ${reservedAfter}`);

const gateMet =
  !ineligible.sent &&
  eligible.sent &&
  eligible.status === 'success' &&
  balanceAfter === balanceBefore - 1000n &&
  !overspend.sent &&
  withinAvailable.sent &&
  withinAvailable.status === 'success' &&
  reservedAfter === reserved;

const evidence = {
  capturedAt: new Date().toISOString(),
  chain: { key: 'baseSepolia', nativeChainId: chainId },
  token: TOKEN,
  policy: POLICY,
  holder: account.address,
  counterparty: COUNTERPARTY,
  holderCvi: {
    source: 'registerApass through the Base ConduitVaultRegistrar; ASM-031 route',
    tierOnBase: 20,
    note: 'A-Pass is chain-scoped. The same wallet is tier 28 on Monad and was absent on Base until registerApass issued CVI there.',
  },
  policyEnforcementModel: {
    observed: {
      'me -> unknown EOA': 'allowed',
      'unknown EOA -> me': 'allowed',
      'unknown EOA -> unknown EOA': 'refused',
    },
    conclusion:
      "The policy is not a per-recipient allowlist, and the same shape holds for Cleanverse's own aUSDC. Ineligibility is produced by the RuleV2 tier floor against a party's CVI, so that is what this run exercises.",
  },
  ineligible: { rule: raised.rules, setRuleTx: raised.tx, transfer: ineligible },
  eligible: {
    rule: lowered.rules,
    setRuleTx: lowered.tx,
    transfer: eligible,
    balanceBefore: balanceBefore.toString(),
    balanceAfter: balanceAfter.toString(),
  },
  reservation: {
    settlementId,
    reserveTx: reserveTx === null ? null : { hash: reserveTx.hash, status: reserveTx.status },
    reserved: reserved.toString(),
    available: available.toString(),
    spendBeyondAvailable: overspend,
    spendWithinAvailable: withinAvailable,
    reservedAfter: reservedAfter.toString(),
  },
  gateMet,
};

const path = join(ROOT, 'docs', 'evidence', 'phase-03-rwa-transfers.json');
writeFileSync(
  path,
  `${JSON.stringify(evidence, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`,
);
console.log(`\n${gateMet ? 'phase 03 transfer gate met' : 'GATE NOT MET'}`);
console.log(`written ${path}`);
process.exitCode = gateMet ? 0 : 1;

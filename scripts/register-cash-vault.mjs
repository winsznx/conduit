#!/usr/bin/env node
/**
 * Gives `CashEscrow` the CVI it needs to hold the Monad cash A-Token. ADR-0001.
 *
 * Before this runs the Monad policy refuses the escrow outright:
 *
 *   canTransfer(aUSDC, eligibleEOA, escrow,      1)  →  NoAPass(0x1645BA08…)
 *   canTransfer(aUSDC, escrow,      eligibleEOA, 1)  →  NoAPass(0x1645BA08…)
 *   canTransfer(aUSDC, eligibleEOA, eligibleEOA, 1)  →  true
 *
 * The last line is the control. The refusal is about the escrow, not about the
 * token, the sender, or the sandbox.
 *
 * Two calls fix it, in the order the validator enforces rather than the order we
 * would prefer — `registerApass` reverts `PoolNotRegistered()` (0x739f4185) until
 * `registerV2` has run:
 *
 *   1. registrar.registerPool(escrow, rule)
 *   2. registrar.registerVaultCvi(escrow, aUSDC, address(0))
 *
 * The rule is all-zero, which the guide defines as unrestricted, and that is a
 * deliberate starting point rather than a final policy: it is the pool's own
 * `complianceVerify` policy, nothing in Conduit calls it, and phase 05 replaces
 * it with the real rule read back from `validator/rules`. Recorded as ASM-034 so
 * it cannot quietly become permanent.
 *
 * The proof is the same `canTransfer` call, before and after, against the same
 * contract. Anything less would be this script reporting on itself.
 *
 *   node --env-file=.env scripts/register-cash-vault.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ROOT } from './lib/run.mjs';

const REGISTRAR = process.env['CONDUIT_VAULT_REGISTRAR'];
const ESCROW = process.env['CASH_ESCROW_ADDRESS'];
const A_TOKEN = process.env['MONAD_CASH_ATOKEN'];
const VALIDATOR = process.env['CCP_VALIDATOR_MONAD_TESTNET'];
const POLICY = '0x36489bE45fa84f70a0c2BDB11D824Be608CB12Dd';

const REGISTRAR_ABI = parseAbi([
  'function hasRegisterRole() view returns (bool)',
  'function registerPool(address pool, (bytes2,bytes2,uint8,uint8,bool,uint256) rule)',
  'function registerVaultCvi(address pool, address aToken, address feeAddress)',
]);

const VALIDATOR_ABI = parseAbi(['function isRegistered(address) view returns (bool)']);

const POLICY_ABI = parseAbi([
  'function canTransfer(address token, address from, address to, uint256 amount) view returns (bool)',
  'error NoAPass(address account)',
  'error TransferNotAllowed()',
]);

const UNRESTRICTED = ['0x0000', '0x0000', 0, 0, false, 0n];

const account = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const transport = http(process.env['MONAD_TESTNET_RPC_URL']);
const pub = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport, chain: { id: 10143 } });

/** Both directions plus the control, so a change can be attributed to one address. */
async function custodyState() {
  const ask = async (from, to) => {
    try {
      return {
        allowed: await pub.readContract({
          address: POLICY,
          abi: POLICY_ABI,
          functionName: 'canTransfer',
          args: [A_TOKEN, from, to, 1n],
        }),
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        allowed: false,
        refusedWith: text.match(/Error:\s*([A-Za-z_][A-Za-z0-9_]*\([^)]*\))/)?.[1] ?? 'revert',
        refusedAccount: text.match(/\b(0x[0-9a-fA-F]{40})\b/)?.[1] ?? null,
      };
    }
  };
  return {
    eligibleToEscrow: await ask(account.address, ESCROW),
    escrowToEligible: await ask(ESCROW, account.address),
    eligibleToEligible: await ask(account.address, account.address),
  };
}

const show = (label, state) => {
  console.log(`  ${label}`);
  for (const [k, v] of Object.entries(state)) {
    console.log(
      `    ${k.padEnd(19)} ${v.allowed ? 'allowed' : `refused ${v.refusedWith}${v.refusedAccount ? ` ${v.refusedAccount}` : ''}`}`,
    );
  }
};

const chainId = await pub.getChainId();
if (chainId !== 10143) throw new Error(`RPC reports chain ${chainId}, expected 10143`);

const hasRole = await pub.readContract({
  address: REGISTRAR,
  abi: REGISTRAR_ABI,
  functionName: 'hasRegisterRole',
});
if (!hasRole) {
  console.error(
    `registrar ${REGISTRAR} does not hold REGISTER_ROLE; run scripts/validator-grant.mjs first`,
  );
  process.exit(1);
}

console.log(`Monad Testnet ${chainId}`);
console.log(`registrar ${REGISTRAR}   validator ${VALIDATOR}`);
console.log(`escrow    ${ESCROW}   aToken    ${A_TOKEN}\n`);

const before = await custodyState();
show('before', before);

const send = async (functionName, args) => {
  const hash = await wallet.writeContract({
    address: REGISTRAR,
    abi: REGISTRAR_ABI,
    functionName,
    args,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`  ${functionName.padEnd(17)} ${receipt.status}  ${hash}`);
  return { hash, status: receipt.status, gasUsed: receipt.gasUsed.toString() };
};

console.log('\n  registering');
const poolTx = await send('registerPool', [ESCROW, UNRESTRICTED]);
const cviTx = await send('registerVaultCvi', [
  ESCROW,
  A_TOKEN,
  '0x0000000000000000000000000000000000000000',
]);

const registered = await pub.readContract({
  address: VALIDATOR,
  abi: VALIDATOR_ABI,
  functionName: 'isRegistered',
  args: [ESCROW],
});
console.log(`  validator.isRegistered(escrow)  ${registered}\n`);

const after = await custodyState();
show('after', after);

const custodyUnlocked = after.eligibleToEscrow.allowed && after.escrowToEligible.allowed;
console.log(
  `\n  ${custodyUnlocked ? 'the escrow may now hold and release the CVA' : 'still refused — custody remains blocked'}`,
);

const evidence = {
  capturedAt: new Date().toISOString(),
  question: 'Can CashEscrow hold the Monad cash A-Token after CVI registration? (ADR-0001)',
  chain: { key: 'monadTestnet', nativeChainId: chainId },
  addresses: {
    registrar: REGISTRAR,
    validator: VALIDATOR,
    policy: POLICY,
    escrow: ESCROW,
    aToken: A_TOKEN,
  },
  rule: {
    fields: 'allowedGroup, allowedSubGroup, minTier, minSubTier, isBlackList, poolCountryBitmap',
    value: 'all zero = unrestricted',
    note: "Deliberate starting point, not a final policy. This is the pool's own complianceVerify rule; nothing in Conduit calls it. Phase 05 replaces it with the rule read back from validator/rules. Tracked as ASM-034.",
  },
  transactions: { registerPool: poolTx, registerVaultCvi: cviTx },
  validatorIsRegistered: registered,
  canTransfer: { before, after },
  custodyUnlocked,
};

const path = join(ROOT, 'docs', 'evidence', 'phase-01-monad-cva-custody.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nwritten ${path}`);
process.exitCode = custodyUnlocked ? 0 : 1;

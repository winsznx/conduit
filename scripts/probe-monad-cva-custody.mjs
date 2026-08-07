#!/usr/bin/env node
/**
 * Can `CashEscrow` hold the Monad cash A-Token? ADR-0001, PRD 19 phase 01.
 *
 * The phase 01 gate is "real A-Token enters and exits the selected custody mode
 * with exact conservation". Everything upstream of that gate is a guess until
 * this runs: a CVA refuses transfers to an address without CVI, and `CashEscrow`
 * is a contract that nobody has issued CVI to.
 *
 * The CCP Integration Guide for CVI Compliance V2 says a CVA vault gets CVI
 * through `registerApass(pool, aToken, fee)` on `IAPassComplianceValidator`, that
 * the call needs `REGISTER_ROLE`, and that the role is granted to a Factory
 * address through `POST /api/cooperate/validator/grant`. So the question splits
 * in three, and this script answers the first two without spending anything:
 *
 *   1. which deployed contract on Monad is the validator?
 *   2. does it consider `CashEscrow` compliant today?
 *   3. does an actual transfer succeed?  ← needs (2), or needs the grant first
 *
 * Every selector probed here is transcribed from the guide's interface listing.
 * None is guessed. A contract that answers a documented selector is identified;
 * a contract that reverts on all of them is not the validator, which is a result
 * rather than a failure.
 *
 *   node --env-file=.env scripts/probe-monad-cva-custody.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, encodeFunctionData, http, isAddress, parseAbi } from 'viem';

import { ROOT } from './lib/run.mjs';

const RPC = process.env['MONAD_TESTNET_RPC_URL'];
const A_TOKEN = process.env['MONAD_CASH_ATOKEN'];
const CASH_ESCROW = process.env['CASH_ESCROW_ADDRESS'];

/** From the phase 01 discovery snapshot, not from a literal in this file. */
const ACCESS_CORE = '0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC';
const A_PASS = '0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9';

const client = createPublicClient({ transport: http(RPC) });

/**
 * The documented `IAPassComplianceValidator` surface, verbatim from the guide's
 * section 3.2. `registerApass` is overloaded there; both arities are listed.
 */
const VALIDATOR_ABI = parseAbi([
  'function complianceVerify(address poolAddress, address userAddress) view returns (bool)',
  'function isRegistered(address poolAddress) view returns (bool)',
  'function getRulesV2(address poolAddress) view returns ((bytes2,bytes2,uint8,uint8,bool,uint256)[])',
  'function registerApass(address poolAddress, address aTokenAddress)',
  'function registerApass(address poolAddress, address aTokenAddress, address feeAddress)',
  'function registerV2(address poolAddress, (bytes2,bytes2,uint8,uint8,bool,uint256) rule)',
]);

const TOKEN_ABI = parseAbi([
  'function policy() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/**
 * The A-Token's own policy, which is a different contract from the guide's
 * `IAPassComplianceValidator`. The CVA calls `canTransfer` on every transfer, so
 * this is the function that decides custody, and calling it is the whole answer
 * to ADR-0001. A simulated ERC-20 transfer would answer the same question and
 * needs a funded sender; this needs nothing.
 */
const POLICY_ABI = parseAbi([
  'function canTransfer(address token, address from, address to, uint256 amount) view returns (bool)',
  // Declared so viem decodes the refusal rather than handing back raw calldata.
  // Which party the policy names is the finding: a refusal carrying the escrow's
  // own address is the escrow being rejected, not the counterparty.
  'error NoAPass(address account)',
  'error TransferNotAllowed()',
]);

/**
 * A read that answers is identification. A read that reverts is not an error to
 * be retried, it is the answer that this contract does not expose that function.
 */
async function probe(address, abi, functionName, args) {
  try {
    const result = await client.readContract({ address, abi, functionName, args });
    return { present: true, result };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // The custom-error signature is the answer, not the prose around it.
    // `NoAPass(address)` and `TransferNotAllowed()` mean different things and a
    // one-line summary throws away exactly the part that distinguishes them.
    const signature = text.match(/Error:\s*([A-Za-z_][A-Za-z0-9_]*\([^)]*\))/)?.[1] ?? null;
    const data = text.match(/\b(0x[0-9a-fA-F]{8,})\b/)?.[1] ?? null;
    return {
      present: false,
      reason: text.split('\n')[0],
      revertSignature: signature,
      revertData: data,
    };
  }
}

/** Serializes `bigint` and the ABI tuples `getRulesV2` returns. */
const plain = (value) =>
  typeof value === 'bigint'
    ? value.toString()
    : Array.isArray(value)
      ? value.map(plain)
      : (value ?? null);

async function identifyValidator(label, address) {
  const registered = await probe(address, VALIDATOR_ABI, 'isRegistered', [CASH_ESCROW]);
  const verified = await probe(address, VALIDATOR_ABI, 'complianceVerify', [address, CASH_ESCROW]);
  const rules = await probe(address, VALIDATOR_ABI, 'getRulesV2', [address]);

  const answers = [registered, verified, rules].filter((p) => p.present).length;

  console.log(`\n── ${label}  ${address}`);
  console.log(`   isRegistered(escrow)        ${registered.present ? registered.result : '—'}`);
  console.log(`   complianceVerify(., escrow) ${verified.present ? verified.result : '—'}`);
  console.log(
    `   getRulesV2(self)            ${rules.present ? `${rules.result.length} rules` : '—'}`,
  );
  console.log(`   → answers ${answers}/3 documented validator selectors`);

  return {
    label,
    address,
    documentedSelectorsAnswered: answers,
    isRegistered: registered.present ? registered.result : null,
    complianceVerify: verified.present ? verified.result : null,
    ruleCount: rules.present ? rules.result.length : null,
    notPresent: [registered, verified, rules].filter((p) => !p.present).map((p) => p.reason),
  };
}

if (!isAddress(CASH_ESCROW ?? '')) {
  console.error('CASH_ESCROW_ADDRESS must be set to the deployed Monad escrow.');
  process.exit(1);
}

const chainId = await client.getChainId();
if (chainId !== 10143) {
  console.error(`RPC reports chain ${chainId}, expected Monad Testnet 10143`);
  process.exit(1);
}

console.log(`Monad Testnet ${chainId}`);
console.log(`cash A-Token  ${A_TOKEN}`);
console.log(`CashEscrow    ${CASH_ESCROW}`);

const tokenPolicy = await probe(A_TOKEN, TOKEN_ABI, 'policy', []);
console.log(
  `\ntoken.policy() ${tokenPolicy.present ? tokenPolicy.result : `absent: ${tokenPolicy.reason}`}`,
);

const candidates = [
  ['accesscore (discovery)', ACCESS_CORE],
  ['apass (discovery)', A_PASS],
];
if (
  tokenPolicy.present &&
  !candidates.some(([, a]) => a.toLowerCase() === tokenPolicy.result.toLowerCase())
) {
  candidates.push(['token.policy()', tokenPolicy.result]);
}

const identified = [];
for (const [label, address] of candidates) {
  identified.push(await identifyValidator(label, address));
}

/**
 * The custody question itself, asked of the contract that actually decides it.
 *
 * The deployer holds an ACTIVE A-Pass on Monad (ASM-031), so a `false` here is
 * the recipient being refused rather than the sender, and the two directions
 * separate cleanly: eligible → escrow versus escrow → eligible.
 */
const DEPLOYER = process.env['DEPLOYER_ADDRESS'] ?? '0x83C130ed9fb92830F09ea2b30E49009EF03065Bb';
const policyAddress = tokenPolicy.present ? tokenPolicy.result : null;

const canTransfer = policyAddress
  ? {
      eligibleToEscrow: await probe(policyAddress, POLICY_ABI, 'canTransfer', [
        A_TOKEN,
        DEPLOYER,
        CASH_ESCROW,
        1n,
      ]),
      escrowToEligible: await probe(policyAddress, POLICY_ABI, 'canTransfer', [
        A_TOKEN,
        CASH_ESCROW,
        DEPLOYER,
        1n,
      ]),
      eligibleToEligible: await probe(policyAddress, POLICY_ABI, 'canTransfer', [
        A_TOKEN,
        DEPLOYER,
        DEPLOYER,
        1n,
      ]),
    }
  : null;

if (canTransfer !== null) {
  console.log('\n── policy.canTransfer  (the contract that decides custody)');
  for (const [label, outcome] of Object.entries(canTransfer)) {
    console.log(
      `   ${label.padEnd(19)} ${
        outcome.present ? outcome.result : `reverted: ${outcome.reason?.slice(0, 90) ?? ''}`
      }`,
    );
  }
}

const deployerBalance = await probe(A_TOKEN, TOKEN_ABI, 'balanceOf', [DEPLOYER]);
const escrowBalance = await probe(A_TOKEN, TOKEN_ABI, 'balanceOf', [CASH_ESCROW]);

console.log(`\ndeployer aUSDC balance ${deployerBalance.present ? deployerBalance.result : '—'}`);
console.log(`escrow   aUSDC balance ${escrowBalance.present ? escrowBalance.result : '—'}`);

/**
 * The custody question, answered without spending: `eth_call` a transfer from the
 * deployer to the escrow. If the CVA refuses the recipient it reverts here in
 * exactly the way it would revert in a transaction.
 */
const transferProbe = await (async () => {
  if (!deployerBalance.present || deployerBalance.result === 0n) {
    return { attempted: false, reason: 'deployer holds no aUSDC to simulate a transfer with' };
  }
  const from = process.env['DEPLOYER_ADDRESS'] ?? '0x83C130ed9fb92830F09ea2b30E49009EF03065Bb';
  try {
    await client.call({
      account: from,
      to: A_TOKEN,
      data: encodeFunctionData({
        abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
        args: [CASH_ESCROW, 1n],
      }),
    });
    return { attempted: true, wouldSucceed: true };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    return {
      attempted: true,
      wouldSucceed: false,
      // The selector matters more than the prose: NoAPass(address) is the CVA
      // refusing a recipient without CVI, which is the answer ADR-0001 needs.
      revert:
        raw.split('\n').find((line) => line.includes('0x') || line.includes('revert')) ??
        raw.split('\n')[0],
    };
  }
})();

console.log(
  `\ntransfer 1 unit → escrow: ${
    transferProbe.attempted
      ? transferProbe.wouldSucceed
        ? 'WOULD SUCCEED'
        : `WOULD REVERT — ${transferProbe.revert}`
      : `not attempted (${transferProbe.reason})`
  }`,
);

const evidence = {
  capturedAt: new Date().toISOString(),
  question: 'Can CashEscrow hold the Monad cash A-Token without CVI? (ADR-0001)',
  chain: { key: 'monadTestnet', nativeChainId: chainId },
  aToken: A_TOKEN,
  cashEscrow: CASH_ESCROW,
  tokenPolicy: tokenPolicy.present ? tokenPolicy.result : null,
  canTransfer:
    canTransfer === null
      ? null
      : Object.fromEntries(
          Object.entries(canTransfer).map(([k, v]) => [
            k,
            v.present
              ? v.result
              : {
                  reverted: true,
                  signature: v.revertSignature,
                  data: v.revertData,
                  message: v.reason,
                },
          ]),
        ),
  validatorCandidates: identified.map((c) => ({ ...c, ruleCount: plain(c.ruleCount) })),
  balances: {
    deployer: deployerBalance.present ? deployerBalance.result.toString() : null,
    escrow: escrowBalance.present ? escrowBalance.result.toString() : null,
  },
  transferSimulation: transferProbe,
  documentedRemedy: {
    source: 'CCP Integration Guide (For CVI Compliance Validator) V2, sections 3.2 and 4.5',
    onChain: 'registerApass(poolAddress, aTokenAddress, feeAddress) on IAPassComplianceValidator',
    constraint:
      'callable only by a Factory holding REGISTER_ROLE, and only for CVA vault registration',
    grantEndpoint: 'POST /api/cooperate/validator/grant',
    registerEndpoint: 'POST /api/cooperate/validator/register',
    registerSignatureRule: 'keccak256(chain + contract_address), lowercase hex concatenation',
  },
};

const path = join(ROOT, 'docs', 'evidence', 'phase-01-monad-cva-custody.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nwritten ${path}`);

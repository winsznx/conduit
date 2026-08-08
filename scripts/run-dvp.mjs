#!/usr/bin/env node
/**
 * The full delivery-versus-payment run, across two chains. PRD 19 phase 06.
 *
 *   Base Sepolia    seller reserves the RWA CVA, adapter publishes ASSET_PREPARED
 *   Monad Testnet   buyer's cash enters CashEscrow
 *   Monad Testnet   coordinator consumes ASSET_PREPARED, reaches READY
 *   Monad Testnet   both parties sign, the quorum attests, COMMIT is issued
 *   Base Sepolia    adapter consumes COMMIT, delivers the reserved units
 *   Monad Testnet   escrow reads the decision and releases the cash
 *
 * The waits are the point, not an inconvenience. Settlement finality is
 * FINALIZED on every transport (ADR-0013), so the Base to Monad leg is roughly
 * eighteen minutes and no amount of impatience makes an instant VAA acceptable
 * — that is exactly the substitution the finality check refuses.
 *
 *   node --env-file=.env scripts/run-dvp.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  encodePacked,
  encodeAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverAddress } from 'viem';

import { ROOT } from './lib/run.mjs';

const RWA = process.env['RWA_CVA_ADDRESS'];
const ADAPTER = process.env['RWA_CVA_ADAPTER_ADDRESS'];
const COORDINATOR = process.env['SETTLEMENT_COORDINATOR_ADDRESS'];
const ESCROW = process.env['CASH_ESCROW_ADDRESS'];
const CASH = process.env['SETTLEMENT_CVA_ADDRESS'];

const CASH_AMOUNT = 25_000_000n;
const ASSET_AMOUNT = 500_000n;
const NONCE = BigInt(process.env['DVP_NONCE'] ?? '1');

const RULE = '(bytes2,bytes2,uint8,uint8,bool,uint256)';

const deployer = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const complianceSigner = privateKeyToAccount(process.env['COMPLIANCE_SIGNER_PRIVATE_KEY']);

const base = {
  pub: createPublicClient({ transport: http(process.env['BASE_SEPOLIA_RPC_URL']) }),
  wallet: createWalletClient({
    account: deployer,
    transport: http(process.env['BASE_SEPOLIA_RPC_URL']),
    chain: { id: 84532 },
  }),
  wormholeChainId: 10004,
};
const monad = {
  pub: createPublicClient({ transport: http(process.env['MONAD_TESTNET_RPC_URL']) }),
  wallet: createWalletClient({
    account: deployer,
    transport: http(process.env['MONAD_TESTNET_RPC_URL']),
    chain: { id: 10143 },
  }),
  wormholeChainId: 10009,
};

const COORDINATOR_ABI = parseAbi([
  'function domainSeparator() view returns (bytes32)',
  'function attestationDomainSeparator() view returns (bytes32)',
  'function recordCashPrepared(bytes32 settlementId, bytes32 intentHash)',
  'function recordAssetPrepared(bytes calldata preparedVaa)',
  'function recordAssetResolved(bytes calldata resolutionVaa, uint8 outcome)',
  'function settlementOf(bytes32) view returns ((uint8,uint8,bool,bool,uint8,uint8,bytes32,uint64))',
  `function issueCommit((uint32,uint256,address,address,uint256,address,address,uint256,address,address,uint256,address,address,bytes32,bytes32,uint64,uint64,uint64,uint256) intent, bytes32 settlementId, bytes buyerSignature, bytes sellerSignature, ((bytes32,bytes32,address,bool,uint64,uint64,bytes32)[],bytes[]) compliance, uint8 consistencyLevel) payable returns (uint64)`,
]);

const ESCROW_ABI = parseAbi([
  'function attestationDomainSeparator() view returns (bytes32)',
  'function prepareCash(bytes32 settlementId, bytes32 intentHash, address receiver, uint256 amount, uint256 destinationChainId, uint8 consistencyLevel) payable returns (uint64)',
  'function releaseCash(bytes32 settlementId, ((bytes32,bytes32,address,bool,uint64,uint64,bytes32)[],bytes[]) compliance)',
  'function legOf(bytes32) view returns ((address,address,uint256,bytes32,uint8))',
  'function totalEscrowed() view returns (uint256)',
]);

const ADAPTER_ABI = parseAbi([
  'function attestationDomainSeparator() view returns (bytes32)',
  'function prepareAsset(bytes32 settlementId, bytes32 intentHash, address receiver, uint256 destinationChainId, uint8 consistencyLevel) payable returns (uint64)',
  'function releaseAsset(bytes calldata commitVaa, ((bytes32,bytes32,address,bool,uint64,uint64,bytes32)[],bytes[]) compliance)',
  'function intendedReceiver(bytes32) view returns (address)',
]);

const RWA_ABI = parseAbi([
  'function reserveForSettlement(bytes32 settlementId, uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function reservedBalanceOf(address) view returns (uint256)',
  'function mint(address to, uint256 amount)',
  `function setRuleV2(${RULE} rule)`,
]);

const CASH_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

const CORE_ABI = parseAbi([
  'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)',
]);

const step = (m) => console.log(`\n── ${m}`);
const note = (m) => console.log(`   ${m}`);

/** Waits for guardians to sign. Finalized Base messages take roughly 18 minutes. */
async function fetchVaa(emitterChainId, emitter, sequence, budgetMs = 2_400_000) {
  const url = `https://api.testnet.wormholescan.io/v1/signed_vaa/${emitterChainId}/${emitter.slice(2).toLowerCase()}/${sequence}`;
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (r.ok) {
        const body = await r.json();
        if (typeof body.vaaBytes === 'string') {
          note(`VAA available after ${Math.round((Date.now() - started) / 1000)}s`);
          return `0x${Buffer.from(body.vaaBytes, 'base64').toString('hex')}`;
        }
      }
    } catch {
      // Still waiting; a transport hiccup mid-wait is not an answer.
    }
    await new Promise((r) => setTimeout(r, 15_000));
    process.stdout.write('.');
  }
  throw new Error(`VAA ${emitterChainId}/${sequence} never became available`);
}

/**
 * Waits until a read reflects a write that is already mined.
 *
 * Base Sepolia's public endpoint serves reads behind the head, and it is not
 * archival so pinning to the receipt's block is refused. That cost a run: the
 * reservation was confirmed, `prepareAsset` was submitted against it, and gas
 * estimation ran on a node that had not seen the reservation yet — a revert
 * that looks like a missing reservation and is a stale read. Asserting the
 * state rather than sleeping means a write that genuinely never landed fails
 * here instead of one step later wearing the wrong error.
 */
async function until(label, read, matches, budgetMs = 120_000) {
  const deadline = Date.now() + budgetMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (matches(last)) return last;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`${label}: never observed; last read ${String(last)}`);
}

const padEmitter = (address) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

async function sequenceFrom(chain, hash) {
  const receipt = await chain.pub.waitForTransactionReceipt({ hash });
  const [log] = parseEventLogs({
    abi: CORE_ABI,
    eventName: 'LogMessagePublished',
    logs: receipt.logs,
  });
  if (log === undefined) throw new Error(`no LogMessagePublished in ${hash}`);
  return { sequence: log.args.sequence, status: receipt.status, hash };
}

// ── The intent ─────────────────────────────────────────────────────────────

const BUYER = deployer.address;
const SELLER = deployer.address;

const intent = {
  version: 1,
  cashChainId: 10143n,
  cashEscrow: ESCROW,
  cashAsset: CASH,
  cashAmount: CASH_AMOUNT,
  cashPayer: BUYER,
  cashReceiver: SELLER,
  assetChainId: 84532n,
  assetEscrow: RWA,
  assetToken: RWA,
  assetAmount: ASSET_AMOUNT,
  assetSeller: SELLER,
  assetReceiver: BUYER,
  cashPolicyHash: keccak256('0x01'),
  assetPolicyHash: keccak256('0x02'),
  prepareDeadline: BigInt(Math.floor(Date.now() / 1000) + 86_400),
  commitDeadline: BigInt(Math.floor(Date.now() / 1000) + 172_800),
  releaseDeadline: BigInt(Math.floor(Date.now() / 1000) + 259_200),
  nonce: NONCE,
};

const INTENT_TYPEHASH = keccak256(
  new TextEncoder().encode(
    'SettlementIntent(uint32 version,uint256 cashChainId,address cashEscrow,address cashAsset,uint256 cashAmount,address cashPayer,address cashReceiver,uint256 assetChainId,address assetEscrow,address assetToken,uint256 assetAmount,address assetSeller,address assetReceiver,bytes32 cashPolicyHash,bytes32 assetPolicyHash,uint64 prepareDeadline,uint64 commitDeadline,uint64 releaseDeadline,uint256 nonce)',
  ),
);

function intentStructHash() {
  const a = encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint32' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'address' },
      { type: 'uint256' },
      { type: 'address' },
      { type: 'address' },
    ],
    [
      INTENT_TYPEHASH,
      intent.version,
      intent.cashChainId,
      intent.cashEscrow,
      intent.cashAsset,
      intent.cashAmount,
      intent.cashPayer,
      intent.cashReceiver,
      intent.assetChainId,
      intent.assetEscrow,
      intent.assetToken,
    ],
  );
  const b = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'address' },
      { type: 'address' },
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint64' },
      { type: 'uint64' },
      { type: 'uint64' },
      { type: 'uint256' },
    ],
    [
      intent.assetAmount,
      intent.assetSeller,
      intent.assetReceiver,
      intent.cashPolicyHash,
      intent.assetPolicyHash,
      intent.prepareDeadline,
      intent.commitDeadline,
      intent.releaseDeadline,
      intent.nonce,
    ],
  );
  return keccak256(`0x${a.slice(2)}${b.slice(2)}`);
}

const intentTuple = [
  intent.version,
  intent.cashChainId,
  intent.cashEscrow,
  intent.cashAsset,
  intent.cashAmount,
  intent.cashPayer,
  intent.cashReceiver,
  intent.assetChainId,
  intent.assetEscrow,
  intent.assetToken,
  intent.assetAmount,
  intent.assetSeller,
  intent.assetReceiver,
  intent.cashPolicyHash,
  intent.assetPolicyHash,
  intent.prepareDeadline,
  intent.commitDeadline,
  intent.releaseDeadline,
  intent.nonce,
];

const coordinatorDomain = await monad.pub.readContract({
  address: COORDINATOR,
  abi: COORDINATOR_ABI,
  functionName: 'domainSeparator',
});
const settlementId = keccak256(
  encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', coordinatorDomain, intentStructHash()]),
);

console.log(`settlementId ${settlementId}`);
console.log(`buyer/seller ${BUYER}`);
console.log(`cash  ${CASH_AMOUNT} cSETTLE     asset ${ASSET_AMOUNT} cBOND`);

/**
 * An eligible attestation for one subject, bound to the verifying contract.
 *
 * The digest is built explicitly from that contract's own domain separator and
 * signed raw. An earlier version tried `signTypedData` first and fell back to
 * this in a `catch`, which is how it produced a signature over a domain the
 * contract never uses: the first path did not throw, it succeeded incorrectly,
 * and the fallback never ran. The coordinator recovered an address nobody
 * authorised and answered `AttestationSignerNotAuthorized` — a correct refusal
 * of a malformed proof, twenty-five minutes into a live settlement.
 */
const ATTESTATION_TYPEHASH = keccak256(
  new TextEncoder().encode(
    'ComplianceAttestation(bytes32 settlementId,bytes32 intentHash,address subject,bool eligible,uint64 issuedAt,uint64 expiresAt,bytes32 evidenceHash)',
  ),
);

async function proofFor(chain, verifying, subject) {
  const domain = await chain.pub.readContract({
    address: verifying,
    abi: ESCROW_ABI,
    functionName: 'attestationDomainSeparator',
  });

  const issuedAt = BigInt(Math.floor(Date.now() / 1000) - 60);
  const expiresAt = issuedAt + 800n;
  const evidenceHash = keccak256('0x03');

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes32' },
      ],
      [
        ATTESTATION_TYPEHASH,
        settlementId,
        settlementId,
        subject,
        true,
        issuedAt,
        expiresAt,
        evidenceHash,
      ],
    ),
  );
  const digest = keccak256(
    encodePacked(['bytes2', 'bytes32', 'bytes32'], ['0x1901', domain, structHash]),
  );
  const signature = await complianceSigner.sign({ hash: digest });

  // The contract will recover this; recovering it here first means a wrong
  // signer is caught in the second before the transaction rather than in the
  // revert after it.
  const recovered = await recoverAddress({ hash: digest, signature });
  if (recovered.toLowerCase() !== complianceSigner.address.toLowerCase()) {
    throw new Error(`attestation recovers to ${recovered}, expected ${complianceSigner.address}`);
  }

  return {
    attestations: [[settlementId, settlementId, subject, true, issuedAt, expiresAt, evidenceHash]],
    signatures: [signature],
  };
}

const evidence = { settlementId, startedAt: new Date().toISOString(), steps: {} };

// ── 1. Asset leg prepares on Base ──────────────────────────────────────────

step('Base Sepolia: reserve the RWA and publish ASSET_PREPARED');
// Minted only when the seller cannot cover the reservation, and confirmed
// before reserving against it. A swallowed failure here surfaces later as
// InsufficientAvailableBalance, which reads as a balance problem rather than
// as a mint that never landed.
{
  const held = await base.pub.readContract({
    address: RWA,
    abi: RWA_ABI,
    functionName: 'balanceOf',
    args: [SELLER],
  });
  const reserved = await base.pub.readContract({
    address: RWA,
    abi: RWA_ABI,
    functionName: 'reservedBalanceOf',
    args: [SELLER],
  });
  if (held - reserved < ASSET_AMOUNT) {
    const h = await base.wallet.writeContract({
      address: RWA,
      abi: RWA_ABI,
      functionName: 'mint',
      args: [SELLER, ASSET_AMOUNT * 4n],
    });
    const r = await base.pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error(`mint failed: ${h}`);
    note(`minted ${ASSET_AMOUNT * 4n}`);
  }
  note(`seller available ${held - reserved}`);
}
const reservedBefore = await base.pub.readContract({
  address: RWA,
  abi: RWA_ABI,
  functionName: 'reservedBalanceOf',
  args: [SELLER],
});
const reserveHash = await base.wallet.writeContract({
  address: RWA,
  abi: RWA_ABI,
  functionName: 'reserveForSettlement',
  args: [settlementId, ASSET_AMOUNT],
});
const reserveReceipt = await base.pub.waitForTransactionReceipt({ hash: reserveHash });
if (reserveReceipt.status !== 'success') throw new Error(`reserve failed: ${reserveHash}`);

// Confirmed is not the same as observable. Base Sepolia's public endpoint serves
// reads behind the head and is not archival, so the next call's gas estimation
// can run on a node that has not seen this reservation — a revert that looks
// like a missing reservation and is a stale read.
await until(
  'the reservation to be observable',
  () =>
    base.pub.readContract({
      address: RWA,
      abi: RWA_ABI,
      functionName: 'reservedBalanceOf',
      args: [SELLER],
    }),
  (r) => r >= reservedBefore + ASSET_AMOUNT,
);
note(`reserved ${ASSET_AMOUNT}  ${reserveHash}`);

const prepareAssetHash = await base.wallet.writeContract({
  address: ADAPTER,
  abi: ADAPTER_ABI,
  functionName: 'prepareAsset',
  args: [settlementId, settlementId, BUYER, 10143n, 1],
});
const assetPrepared = await sequenceFrom(base, prepareAssetHash);
note(`ASSET_PREPARED sequence ${assetPrepared.sequence}  ${prepareAssetHash}`);
evidence.steps.assetPrepared = { hash: prepareAssetHash, sequence: String(assetPrepared.sequence) };

// ── 2. Cash leg prepares on Monad ──────────────────────────────────────────

step('Monad Testnet: cash enters the escrow');
const prepareCashHash = await monad.wallet.writeContract({
  address: ESCROW,
  abi: ESCROW_ABI,
  functionName: 'prepareCash',
  args: [settlementId, settlementId, SELLER, CASH_AMOUNT, 84532n, 1],
});
await monad.pub.waitForTransactionReceipt({ hash: prepareCashHash });
note(`prepared ${CASH_AMOUNT}  ${prepareCashHash}`);
evidence.steps.cashPrepared = { hash: prepareCashHash };

await monad.wallet
  .writeContract({
    address: COORDINATOR,
    abi: COORDINATOR_ABI,
    functionName: 'recordCashPrepared',
    args: [settlementId, settlementId],
  })
  .then((h) => monad.pub.waitForTransactionReceipt({ hash: h }))
  .then(() => note('coordinator: cash leg recorded'));

// ── 3. The wait ────────────────────────────────────────────────────────────

step('waiting for the finalized ASSET_PREPARED VAA (Base finality, ~18 min)');
const assetVaa = await fetchVaa(base.wormholeChainId, padEmitter(ADAPTER), assetPrepared.sequence);

const recordAssetHash = await monad.wallet.writeContract({
  address: COORDINATOR,
  abi: COORDINATOR_ABI,
  functionName: 'recordAssetPrepared',
  args: [assetVaa],
});
await monad.pub.waitForTransactionReceipt({ hash: recordAssetHash });
note(`coordinator: asset leg recorded  ${recordAssetHash}`);
evidence.steps.assetRecorded = { hash: recordAssetHash };

// ── 4. Commit ──────────────────────────────────────────────────────────────

step('Monad Testnet: both parties sign, the quorum attests, COMMIT is issued');
const buyerSig = await deployer.sign({ hash: settlementId });
const sellerSig = buyerSig;

const payerProof = await proofFor(monad, COORDINATOR, intent.cashPayer);
const receiverProof = await proofFor(monad, COORDINATOR, intent.cashReceiver);
const commitProof = {
  attestations: [...payerProof.attestations, ...receiverProof.attestations],
  signatures: [...payerProof.signatures, ...receiverProof.signatures],
};

const commitHash = await monad.wallet.writeContract({
  address: COORDINATOR,
  abi: COORDINATOR_ABI,
  functionName: 'issueCommit',
  args: [
    intentTuple,
    settlementId,
    buyerSig,
    sellerSig,
    [commitProof.attestations, commitProof.signatures],
    1,
  ],
});
const commit = await sequenceFrom(monad, commitHash);
note(`COMMIT sequence ${commit.sequence}  ${commitHash}`);
evidence.steps.commit = { hash: commitHash, sequence: String(commit.sequence) };

// ── 5. Both legs release ───────────────────────────────────────────────────

step('Monad Testnet: the escrow reads the decision and releases');
const cashBefore = await monad.pub.readContract({
  address: CASH,
  abi: CASH_ABI,
  functionName: 'balanceOf',
  args: [SELLER],
});
const releaseProof = await proofFor(monad, ESCROW, intent.cashReceiver);
const releaseCashHash = await monad.wallet.writeContract({
  address: ESCROW,
  abi: ESCROW_ABI,
  functionName: 'releaseCash',
  args: [settlementId, [releaseProof.attestations, releaseProof.signatures]],
});
await monad.pub.waitForTransactionReceipt({ hash: releaseCashHash });
const cashAfter = await monad.pub.readContract({
  address: CASH,
  abi: CASH_ABI,
  functionName: 'balanceOf',
  args: [SELLER],
});
note(`cash released  ${releaseCashHash}`);
note(`receiver ${cashBefore} → ${cashAfter}`);
evidence.steps.cashReleased = {
  hash: releaseCashHash,
  before: String(cashBefore),
  after: String(cashAfter),
};

step('waiting for the finalized COMMIT VAA (Monad finality, ~1 block)');
const commitVaa = await fetchVaa(monad.wormholeChainId, padEmitter(COORDINATOR), commit.sequence);

const releaseAssetProof = await proofFor(base, ADAPTER, intent.assetReceiver);
const releaseAssetHash = await base.wallet.writeContract({
  address: ADAPTER,
  abi: ADAPTER_ABI,
  functionName: 'releaseAsset',
  args: [commitVaa, [releaseAssetProof.attestations, releaseAssetProof.signatures]],
});
await base.pub.waitForTransactionReceipt({ hash: releaseAssetHash });
const assetHeld = await base.pub.readContract({
  address: RWA,
  abi: RWA_ABI,
  functionName: 'balanceOf',
  args: [BUYER],
});
note(`asset released  ${releaseAssetHash}`);
note(`buyer holds ${assetHeld} cBOND`);
evidence.steps.assetReleased = { hash: releaseAssetHash, buyerBalance: String(assetHeld) };

evidence.finishedAt = new Date().toISOString();
const path = join(ROOT, 'docs', 'evidence', 'phase-06-dvp.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nwritten ${path}`);

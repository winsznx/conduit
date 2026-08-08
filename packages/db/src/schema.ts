import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * The typed mirror of `migrations/0001_initial.sql`.
 *
 * The SQL is the source of truth — it is what runs against Supabase, forward
 * only, and it carries the reasoning in its comments. This file exists so the
 * API, worker and indexer get column names checked at compile time rather than
 * at the first request against production.
 *
 * `schema.test.ts` parses the SQL and asserts the two agree on every table and
 * column. Two hand-written descriptions of one schema drift, and the drift is
 * invisible until a query returns undefined for a column that was renamed in
 * one of them.
 *
 * ## Identity is a pair, everywhere
 *
 * There is no unique key on a bare address in this file. The deployed system
 * has one address that is the SettlementCoordinator on Monad Testnet and the
 * RWACVASettlementAdapter on Base Sepolia (ADR-0018), so `address` alone
 * identifies two different contracts with two different roles. Contracts are
 * `(chainId, address)`, events are `(chainId, txHash, logIndex)`, and Wormhole
 * emitters are `(wormholeChainId, emitter)` in their own namespace.
 */

/** Numeric wide enough for a uint256, which no JS number type holds. */
const uint256 = (name: string) => numeric(name, { precision: 78, scale: 0 });

export const deployments = pgTable('deployments', {
  deploymentId: text('deployment_id').primaryKey(),
  protocolVersion: integer('protocol_version').notNull(),
  gitCommit: text('git_commit').notNull(),
  solcVersion: text('solc_version').notNull(),
  generation: integer('generation').notNull().unique(),
  supersededBy: text('superseded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const deploymentContracts = pgTable(
  'deployment_contracts',
  {
    deploymentId: text('deployment_id').notNull(),
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    role: text('role').notNull(),
    address: text('address').notNull(),
    bytecodeHash: text('bytecode_hash').notNull(),
    wormholeChainId: integer('wormhole_chain_id'),
  },
  (table) => [
    primaryKey({ columns: [table.deploymentId, table.chainId, table.role] }),
    unique('deployment_contracts_identity_unique').on(
      table.deploymentId,
      table.chainId,
      table.address,
      table.role,
    ),
    index('deployment_contracts_by_identity').on(table.chainId, table.address),
  ],
);

export const intents = pgTable('intents', {
  intentHash: text('intent_hash').primaryKey(),
  version: integer('version').notNull(),
  cashChainId: bigint('cash_chain_id', { mode: 'number' }).notNull(),
  cashEscrow: text('cash_escrow').notNull(),
  cashAsset: text('cash_asset').notNull(),
  cashAmount: uint256('cash_amount').notNull(),
  cashPayer: text('cash_payer').notNull(),
  cashReceiver: text('cash_receiver').notNull(),
  assetChainId: bigint('asset_chain_id', { mode: 'number' }).notNull(),
  assetEscrow: text('asset_escrow').notNull(),
  assetToken: text('asset_token').notNull(),
  assetAmount: uint256('asset_amount').notNull(),
  assetSeller: text('asset_seller').notNull(),
  assetReceiver: text('asset_receiver').notNull(),
  cashPolicyHash: text('cash_policy_hash').notNull(),
  assetPolicyHash: text('asset_policy_hash').notNull(),
  prepareDeadline: bigint('prepare_deadline', { mode: 'number' }).notNull(),
  commitDeadline: bigint('commit_deadline', { mode: 'number' }).notNull(),
  releaseDeadline: bigint('release_deadline', { mode: 'number' }).notNull(),
  nonce: uint256('nonce').notNull(),
  buyerSignature: text('buyer_signature'),
  sellerSignature: text('seller_signature'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const settlements = pgTable(
  'settlements',
  {
    settlementId: text('settlement_id').primaryKey(),
    deploymentId: text('deployment_id').notNull(),
    intentHash: text('intent_hash').notNull(),
    /** The coordinator's own enum, read from chain. Never advanced locally. */
    canonicalState: text('canonical_state').notNull().default('NONE'),
    decision: text('decision').notNull().default('NONE'),
    stateVersion: bigint('state_version', { mode: 'number' }).notNull().default(0),
    /** This verifier's classification. A different thing, stored apart. */
    verifierClass: text('verifier_class'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    chainReadAt: timestamp('chain_read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('settlements_by_deployment').on(table.deploymentId),
    index('settlements_by_state').on(table.canonicalState),
    check(
      'settlements_canonical_state_known',
      sql`${table.canonicalState} IN ('NONE','CASH_PREPARED','ASSET_PREPARED','READY','COMMIT_ISSUED','ABORT_ISSUED','SETTLED','ABORTED','HELD','CONTESTED')`,
    ),
  ],
);

export const settlementLegs = pgTable(
  'settlement_legs',
  {
    settlementId: text('settlement_id').notNull(),
    leg: text('leg').notNull(),
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    escrowAddress: text('escrow_address').notNull(),
    assetAddress: text('asset_address').notNull(),
    amount: uint256('amount').notNull(),
    outcome: text('outcome').notNull().default('NONE'),
    localState: text('local_state'),
    currentReceiver: text('current_receiver'),
    originalSender: text('original_sender'),
    chainReadAt: timestamp('chain_read_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.settlementId, table.leg] })],
);

export const messages = pgTable(
  'messages',
  {
    wormholeChainId: integer('wormhole_chain_id').notNull(),
    emitter: text('emitter').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    settlementId: text('settlement_id').notNull(),
    deploymentId: text('deployment_id').notNull(),
    messageType: text('message_type').notNull(),
    intentHash: text('intent_hash').notNull(),
    sourceChainId: bigint('source_chain_id', { mode: 'number' }).notNull(),
    destinationChainId: bigint('destination_chain_id', { mode: 'number' }).notNull(),
    stateVersion: bigint('state_version', { mode: 'number' }).notNull(),
    consistencyLevel: integer('consistency_level').notNull(),
    /** Classified, never compared as a magnitude. ADR-0013. */
    finality: text('finality').notNull(),
    publishedAtBlock: bigint('published_at_block', { mode: 'number' }).notNull(),
    publishedTxHash: text('published_tx_hash').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.wormholeChainId, table.emitter, table.sequence] }),
    index('messages_by_settlement').on(table.settlementId),
  ],
);

export const vaas = pgTable(
  'vaas',
  {
    vaaHash: text('vaa_hash').primaryKey(),
    wormholeChainId: integer('wormhole_chain_id').notNull(),
    emitter: text('emitter').notNull(),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    guardianSetIndex: integer('guardian_set_index').notNull(),
    signatureCount: integer('signature_count').notNull(),
    signedVaa: text('signed_vaa').notNull(),
    consumedChainId: bigint('consumed_chain_id', { mode: 'number' }),
    consumedBy: text('consumed_by'),
    consumedTxHash: text('consumed_tx_hash'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Per observation. Never averaged: the spread is the finding. */
    finalitySeconds: integer('finality_seconds'),
  },
  (table) => [index('vaas_by_message').on(table.wormholeChainId, table.emitter, table.sequence)],
);

export const complianceAttestations = pgTable(
  'compliance_attestations',
  {
    attestationId: text('attestation_id').primaryKey(),
    settlementId: text('settlement_id').notNull(),
    intentHash: text('intent_hash').notNull(),
    subject: text('subject').notNull(),
    subjectChainId: bigint('subject_chain_id', { mode: 'number' }).notNull(),
    eligible: boolean('eligible').notNull(),
    issuedAt: bigint('issued_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    /** keccak of the normalized response. Never the response: no raw PII. */
    evidenceHash: text('evidence_hash').notNull(),
    signer: text('signer').notNull(),
    signature: text('signature').notNull(),
    verifyingChainId: bigint('verifying_chain_id', { mode: 'number' }).notNull(),
    verifyingContract: text('verifying_contract').notNull(),
    cleanverseEndpoint: text('cleanverse_endpoint'),
    cleanverseCode: text('cleanverse_code'),
    cleanverseRequestId: text('cleanverse_request_id'),
    cleanverseResponseHash: text('cleanverse_response_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('compliance_attestations_by_settlement').on(table.settlementId),
    index('compliance_attestations_by_subject').on(table.subjectChainId, table.subject),
  ],
);

export const authorityPolicies = pgTable(
  'authority_policies',
  {
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    registryAddress: text('registry_address').notNull(),
    policyId: text('policy_id').notNull(),
    policyHash: text('policy_hash').notNull(),
    contestWindowSeconds: integer('contest_window_seconds').notNull(),
    allowedAuthorityTypes: integer('allowed_authority_types').notNull(),
    resolverAuthorityTypes: integer('resolver_authority_types').notNull(),
    resolverSignatures: integer('resolver_signatures').notNull(),
    requiredSignatures: integer('required_signatures').array().notNull(),
    active: boolean('active').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.chainId, table.registryAddress, table.policyId, table.policyHash],
    }),
  ],
);

export const dispositionOrders = pgTable(
  'disposition_orders',
  {
    orderHash: text('order_hash').primaryKey(),
    caseId: text('case_id').notNull(),
    settlementId: text('settlement_id').notNull(),
    deploymentId: text('deployment_id').notNull(),
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    controllerAddress: text('controller_address').notNull(),
    leg: text('leg').notNull(),
    dispositionType: text('disposition_type').notNull(),
    sourceEscrow: text('source_escrow').notNull(),
    asset: text('asset').notNull(),
    amount: uint256('amount').notNull(),
    currentReceiver: text('current_receiver').notNull(),
    destination: text('destination').notNull(),
    destinationIdentityCommitment: text('destination_identity_commitment').notNull(),
    authority: text('authority').notNull(),
    authorityType: text('authority_type').notNull(),
    authorityPolicyId: text('authority_policy_id').notNull(),
    authorityPolicyHash: text('authority_policy_hash').notNull(),
    evidenceCommitment: text('evidence_commitment').notNull(),
    complianceAttestationIds: text('compliance_attestation_ids').notNull(),
    notBefore: bigint('not_before', { mode: 'number' }).notNull(),
    expiry: bigint('expiry', { mode: 'number' }).notNull(),
    nonce: uint256('nonce').notNull(),
    hostStateVersion: bigint('host_state_version', { mode: 'number' }).notNull(),
    signature: text('signature').notNull(),
    filedTxHash: text('filed_tx_hash'),
    filedAt: timestamp('filed_at', { withTimezone: true }),
  },
  (table) => [
    unique('disposition_orders_nonce_unique').on(
      table.chainId,
      table.controllerAddress,
      table.authority,
      table.nonce,
    ),
    index('disposition_orders_by_case').on(table.chainId, table.controllerAddress, table.caseId),
    index('disposition_orders_by_settlement').on(table.settlementId),
  ],
);

export const dispositionCases = pgTable(
  'disposition_cases',
  {
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    controllerAddress: text('controller_address').notNull(),
    caseId: text('case_id').notNull(),
    settlementId: text('settlement_id').notNull(),
    leg: text('leg').notNull(),
    /** `DispositionController.CaseState`. This one *is* an on-chain enum. */
    caseState: text('case_state').notNull(),
    policyId: text('policy_id').notNull(),
    policyHash: text('policy_hash').notNull(),
    filedAt: bigint('filed_at', { mode: 'number' }),
    signatures: integer('signatures').notNull().default(0),
    leadOrderHash: text('lead_order_hash'),
    executedOrderHash: text('executed_order_hash'),
    executedType: text('executed_type'),
    executedDestination: text('executed_destination'),
    executedAmount: uint256('executed_amount'),
    executedComplianceDigest: text('executed_compliance_digest'),
    chainReadAt: timestamp('chain_read_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.chainId, table.controllerAddress, table.caseId] }),
    index('disposition_cases_by_settlement').on(table.settlementId),
  ],
);

export const indexedEvents = pgTable(
  'indexed_events',
  {
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    txHash: text('tx_hash').notNull(),
    logIndex: integer('log_index').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockHash: text('block_hash').notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }),
    address: text('address').notNull(),
    eventName: text('event_name').notNull(),
    settlementId: text('settlement_id'),
    payload: jsonb('payload').notNull(),
    /** Set when a reorg orphans the block. Rows are never deleted. */
    orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** The idempotency key. `txHash` alone is not one across two chains. */
    primaryKey({ columns: [table.chainId, table.txHash, table.logIndex] }),
    index('indexed_events_by_block').on(table.chainId, table.blockNumber),
  ],
);

export const indexerCursors = pgTable('indexer_cursors', {
  chainId: bigint('chain_id', { mode: 'number' }).primaryKey(),
  /** Everything at or below this height is scanned with no gaps. */
  lastScannedBlock: bigint('last_scanned_block', { mode: 'number' }).notNull(),
  lastScannedHash: text('last_scanned_hash').notNull(),
  confirmations: integer('confirmations').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const indexerGaps = pgTable(
  'indexer_gaps',
  {
    gapId: bigserial('gap_id', { mode: 'number' }).primaryKey(),
    chainId: bigint('chain_id', { mode: 'number' }).notNull(),
    fromBlock: bigint('from_block', { mode: 'number' }).notNull(),
    toBlock: bigint('to_block', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    /** A gap is a failure, not a warning. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('indexer_gaps_open').on(table.chainId)],
);

export const evidenceArtifacts = pgTable(
  'evidence_artifacts',
  {
    artifactId: text('artifact_id').primaryKey(),
    settlementId: text('settlement_id'),
    kind: text('kind').notNull(),
    /** The content hash is the identity. A URI can rot; the hash cannot lie. */
    contentSha256: text('content_sha256').notNull(),
    contentType: text('content_type').notNull(),
    byteLength: bigint('byte_length', { mode: 'number' }).notNull(),
    storageUri: text('storage_uri'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('evidence_artifacts_by_settlement').on(table.settlementId)],
);

export const verificationRuns = pgTable(
  'verification_runs',
  {
    runId: bigserial('run_id', { mode: 'number' }).primaryKey(),
    settlementId: text('settlement_id').notNull(),
    deploymentId: text('deployment_id').notNull(),
    classification: text('classification').notNull(),
    findings: jsonb('findings').notNull(),
    /** What was actually scanned. "Not found" and "does not exist" differ. */
    searchedRanges: jsonb('searched_ranges').notNull(),
    hadScanGap: boolean('had_scan_gap').notNull(),
    trustRoot: text('trust_root').notNull(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('verification_runs_by_settlement').on(table.settlementId, table.ranAt)],
);

export const outbox = pgTable(
  'outbox',
  {
    outboxId: bigserial('outbox_id', { mode: 'number' }).primaryKey(),
    topic: text('topic').notNull(),
    /** The guarantee, not the caller's care. */
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (table) => [
    unique('outbox_idempotency_unique').on(table.topic, table.idempotencyKey),
    index('outbox_pending').on(table.createdAt),
  ],
);

export const workerJobs = pgTable(
  'worker_jobs',
  {
    jobId: bigserial('job_id', { mode: 'number' }).primaryKey(),
    topic: text('topic').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** What makes a duplicate delivery a no-op rather than a second execution. */
    unique('worker_jobs_idempotency_unique').on(table.topic, table.idempotencyKey),
    uniqueIndex('worker_jobs_claimable').on(table.jobId, table.runAfter),
  ],
);

export const schema = {
  deployments,
  deploymentContracts,
  intents,
  settlements,
  settlementLegs,
  messages,
  vaas,
  complianceAttestations,
  authorityPolicies,
  dispositionOrders,
  dispositionCases,
  indexedEvents,
  indexerCursors,
  indexerGaps,
  evidenceArtifacts,
  verificationRuns,
  outbox,
  workerJobs,
} as const;

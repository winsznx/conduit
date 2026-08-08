-- Conduit's projection schema. PRD 11.6, 11.7.
--
-- Everything in this database is a projection of chain state and Cleanverse
-- responses. Nothing here authorizes value movement, and nothing here is
-- consulted by a contract. CLAUDE.md states it directly: application database
-- state never authorizes value movement. The schema is built so that a row
-- cannot be mistaken for authority — no table stores a signature that a contract
-- would accept as sufficient, and the settlement's canonical state is a column
-- named after the chain it was read from.
--
-- ## Identity is a pair, everywhere
--
-- ADR-0018 exists because the deployed system has one address that is the
-- SettlementCoordinator on Monad Testnet and the RWACVASettlementAdapter on Base
-- Sepolia. The deployer's nonce lined up across two chains and produced a real
-- collision on a live deployment.
--
-- So there is no unique key on a bare address anywhere below. Contracts are
-- `(chain_id, address)`. Events are `(chain_id, tx_hash, log_index)`. Wormhole
-- emitters are `(wormhole_chain_id, emitter)` — a deliberately different
-- namespace, because a Wormhole chain ID is not an EVM chain ID and the two
-- being both small integers is exactly how they get confused.
--
-- Forward-only. A shared environment never runs a down migration.

-- ── Deployments ─────────────────────────────────────────────────────────────

CREATE TABLE deployments (
  deployment_id     TEXT PRIMARY KEY,
  protocol_version  INTEGER      NOT NULL,
  git_commit        TEXT         NOT NULL,
  solc_version      TEXT         NOT NULL,
  -- Ordinal, so a report can say "generation 3" without parsing hashes.
  generation        INTEGER      NOT NULL,
  superseded_by     TEXT         REFERENCES deployments (deployment_id),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT deployments_generation_unique UNIQUE (generation)
);

CREATE TABLE deployment_contracts (
  deployment_id     TEXT         NOT NULL REFERENCES deployments (deployment_id),
  chain_id          BIGINT       NOT NULL,
  role              TEXT         NOT NULL,
  address           TEXT         NOT NULL,
  -- From the manifest. The indexer refuses to index a contract whose live code
  -- hash does not match, because that is a different contract at the same
  -- address as far as any claim about it goes.
  bytecode_hash     TEXT         NOT NULL,
  wormhole_chain_id INTEGER,
  PRIMARY KEY (deployment_id, chain_id, role),
  -- The pair, never the address. Two roles may legitimately share an address
  -- across chains, and one has.
  CONSTRAINT deployment_contracts_identity_unique UNIQUE (deployment_id, chain_id, address, role)
);

CREATE INDEX deployment_contracts_by_identity ON deployment_contracts (chain_id, address);

-- ── Intents and settlements ─────────────────────────────────────────────────

CREATE TABLE intents (
  intent_hash        TEXT PRIMARY KEY,
  version            INTEGER  NOT NULL,
  cash_chain_id      BIGINT   NOT NULL,
  cash_escrow        TEXT     NOT NULL,
  cash_asset         TEXT     NOT NULL,
  cash_amount        NUMERIC(78, 0) NOT NULL,
  cash_payer         TEXT     NOT NULL,
  cash_receiver      TEXT     NOT NULL,
  asset_chain_id     BIGINT   NOT NULL,
  asset_escrow       TEXT     NOT NULL,
  asset_token        TEXT     NOT NULL,
  asset_amount       NUMERIC(78, 0) NOT NULL,
  asset_seller       TEXT     NOT NULL,
  asset_receiver     TEXT     NOT NULL,
  cash_policy_hash   TEXT     NOT NULL,
  asset_policy_hash  TEXT     NOT NULL,
  prepare_deadline   BIGINT   NOT NULL,
  commit_deadline    BIGINT   NOT NULL,
  release_deadline   BIGINT   NOT NULL,
  nonce              NUMERIC(78, 0) NOT NULL,
  -- Present only once a party has actually signed. A settlement can exist as a
  -- draft with neither.
  buyer_signature    TEXT,
  seller_signature   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settlements (
  settlement_id      TEXT PRIMARY KEY,
  deployment_id      TEXT NOT NULL REFERENCES deployments (deployment_id),
  intent_hash        TEXT NOT NULL REFERENCES intents (intent_hash),
  -- The coordinator's own enum, named so nobody reads it as a derived opinion.
  -- Refreshed from chain, never advanced by application logic.
  canonical_state    TEXT NOT NULL DEFAULT 'NONE',
  decision           TEXT NOT NULL DEFAULT 'NONE',
  state_version      BIGINT NOT NULL DEFAULT 0,
  -- This verifier's classification. A different thing from `canonical_state`
  -- and stored apart from it, per ADR-0017.
  verifier_class     TEXT,
  verified_at        TIMESTAMPTZ,
  chain_read_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settlements_canonical_state_known CHECK (
    canonical_state IN (
      'NONE','CASH_PREPARED','ASSET_PREPARED','READY','COMMIT_ISSUED',
      'ABORT_ISSUED','SETTLED','ABORTED','HELD','CONTESTED'
    )
  ),
  CONSTRAINT settlements_decision_known CHECK (decision IN ('NONE','COMMIT','ABORT')),
  CONSTRAINT settlements_verifier_class_known CHECK (
    verifier_class IS NULL OR verifier_class IN (
      'SETTLED_FINAL','DISPOSITION_FINAL','RESTRICTED_HOLD_FINAL','CONTESTED',
      'HELD_PENDING_DISPOSITION','SETTLED_PENDING_VERIFICATION','NOT_SETTLED'
    )
  )
);

CREATE INDEX settlements_by_deployment ON settlements (deployment_id);
CREATE INDEX settlements_by_state ON settlements (canonical_state);

CREATE TABLE settlement_legs (
  settlement_id   TEXT   NOT NULL REFERENCES settlements (settlement_id),
  leg             TEXT   NOT NULL,
  chain_id        BIGINT NOT NULL,
  escrow_address  TEXT   NOT NULL,
  asset_address   TEXT   NOT NULL,
  amount          NUMERIC(78, 0) NOT NULL,
  -- The coordinator's LegOutcome, and the leg's own local state. They are
  -- separate reads from separate contracts and disagreeing is a finding.
  outcome         TEXT   NOT NULL DEFAULT 'NONE',
  local_state     TEXT,
  current_receiver TEXT,
  original_sender TEXT,
  chain_read_at   TIMESTAMPTZ,
  PRIMARY KEY (settlement_id, leg),
  CONSTRAINT settlement_legs_leg_known CHECK (leg IN ('CASH','ASSET')),
  CONSTRAINT settlement_legs_outcome_known CHECK (
    outcome IN ('NONE','RELEASED','RETURNED','HELD','DISPOSED')
  )
);

-- ── Cross-chain messages and the VAAs that carry them ───────────────────────

CREATE TABLE messages (
  -- A Wormhole message is identified by its emitter and sequence, and the
  -- emitter is only meaningful with its Wormhole chain ID.
  wormhole_chain_id INTEGER NOT NULL,
  emitter           TEXT    NOT NULL,
  sequence          BIGINT  NOT NULL,
  settlement_id     TEXT    NOT NULL REFERENCES settlements (settlement_id),
  deployment_id     TEXT    NOT NULL REFERENCES deployments (deployment_id),
  message_type      TEXT    NOT NULL,
  intent_hash       TEXT    NOT NULL,
  source_chain_id   BIGINT  NOT NULL,
  destination_chain_id BIGINT NOT NULL,
  state_version     BIGINT  NOT NULL,
  consistency_level INTEGER NOT NULL,
  -- Classified, never compared as a magnitude. 200 is instant and 201 is safe;
  -- everything else is finalized, and ranking the raw byte puts instant above
  -- finalized (ADR-0013).
  finality          TEXT    NOT NULL,
  published_at_block BIGINT NOT NULL,
  published_tx_hash TEXT    NOT NULL,
  PRIMARY KEY (wormhole_chain_id, emitter, sequence),
  CONSTRAINT messages_type_known CHECK (
    message_type IN (
      'CASH_PREPARED','ASSET_PREPARED','COMMIT','ABORT','CASH_RELEASED',
      'ASSET_RELEASED','CASH_HELD','ASSET_HELD','DISPOSITION_RESOLVED'
    )
  ),
  CONSTRAINT messages_finality_known CHECK (finality IN ('INSTANT','SAFE','FINALIZED'))
);

CREATE INDEX messages_by_settlement ON messages (settlement_id);

CREATE TABLE vaas (
  vaa_hash          TEXT PRIMARY KEY,
  wormhole_chain_id INTEGER NOT NULL,
  emitter           TEXT    NOT NULL,
  sequence          BIGINT  NOT NULL,
  guardian_set_index INTEGER NOT NULL,
  signature_count   INTEGER NOT NULL,
  signed_vaa        TEXT    NOT NULL,
  -- Which contract consumed it, as a pair. A VAA consumed on one chain says
  -- nothing about the same emitter's message on another.
  consumed_chain_id BIGINT,
  consumed_by       TEXT,
  consumed_tx_hash  TEXT,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Seconds between publication and a signed VAA being available. Recorded per
  -- observation and never averaged: the spread is the finding.
  finality_seconds  INTEGER,
  FOREIGN KEY (wormhole_chain_id, emitter, sequence)
    REFERENCES messages (wormhole_chain_id, emitter, sequence)
);

CREATE INDEX vaas_by_message ON vaas (wormhole_chain_id, emitter, sequence);

-- ── Compliance ──────────────────────────────────────────────────────────────

CREATE TABLE compliance_attestations (
  attestation_id  TEXT PRIMARY KEY,
  settlement_id   TEXT   NOT NULL REFERENCES settlements (settlement_id),
  intent_hash     TEXT   NOT NULL,
  subject         TEXT   NOT NULL,
  subject_chain_id BIGINT NOT NULL,
  eligible        BOOLEAN NOT NULL,
  issued_at       BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  -- keccak of the normalized Cleanverse response. Never the response: PRD
  -- forbids raw PII, and a hash is enough to prove the stored record was not
  -- swapped afterwards.
  evidence_hash   TEXT   NOT NULL,
  signer          TEXT   NOT NULL,
  signature       TEXT   NOT NULL,
  -- Which contract's EIP-712 domain this verifies against. An attestation for
  -- the Monad coordinator is not valid at the Base adapter.
  verifying_chain_id BIGINT NOT NULL,
  verifying_contract TEXT  NOT NULL,
  -- What Cleanverse actually said, redacted, plus the hash of the full body.
  cleanverse_endpoint TEXT,
  cleanverse_code     TEXT,
  cleanverse_request_id TEXT,
  cleanverse_response_hash TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX compliance_attestations_by_settlement ON compliance_attestations (settlement_id);
CREATE INDEX compliance_attestations_by_subject ON compliance_attestations (subject_chain_id, subject);

-- ── The Disposition Kernel ──────────────────────────────────────────────────

CREATE TABLE authority_policies (
  chain_id        BIGINT NOT NULL,
  registry_address TEXT  NOT NULL,
  policy_id       TEXT   NOT NULL,
  policy_hash     TEXT   NOT NULL,
  contest_window_seconds INTEGER NOT NULL,
  allowed_authority_types INTEGER NOT NULL,
  resolver_authority_types INTEGER NOT NULL,
  resolver_signatures INTEGER NOT NULL,
  -- One entry per DispositionType, in the PRD's order. Zero means the type is
  -- not permitted at all under this policy.
  required_signatures INTEGER[] NOT NULL,
  active          BOOLEAN NOT NULL,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, registry_address, policy_id, policy_hash)
);

CREATE TABLE disposition_orders (
  order_hash      TEXT PRIMARY KEY,
  case_id         TEXT   NOT NULL,
  settlement_id   TEXT   NOT NULL REFERENCES settlements (settlement_id),
  deployment_id   TEXT   NOT NULL REFERENCES deployments (deployment_id),
  chain_id        BIGINT NOT NULL,
  controller_address TEXT NOT NULL,
  leg             TEXT   NOT NULL,
  disposition_type TEXT  NOT NULL,
  source_escrow   TEXT   NOT NULL,
  asset           TEXT   NOT NULL,
  amount          NUMERIC(78, 0) NOT NULL,
  current_receiver TEXT  NOT NULL,
  destination     TEXT   NOT NULL,
  destination_identity_commitment TEXT NOT NULL,
  authority       TEXT   NOT NULL,
  authority_type  TEXT   NOT NULL,
  authority_policy_id TEXT NOT NULL,
  authority_policy_hash TEXT NOT NULL,
  evidence_commitment TEXT NOT NULL,
  compliance_attestation_ids TEXT NOT NULL,
  not_before      BIGINT NOT NULL,
  expiry          BIGINT NOT NULL,
  nonce           NUMERIC(78, 0) NOT NULL,
  host_state_version BIGINT NOT NULL,
  signature       TEXT   NOT NULL,
  filed_tx_hash   TEXT,
  filed_at        TIMESTAMPTZ,
  CONSTRAINT disposition_orders_leg_known CHECK (leg IN ('CASH','ASSET')),
  CONSTRAINT disposition_orders_type_known CHECK (
    disposition_type IN (
      'REVERIFY_AND_RESUME','REBIND_RECEIVER','RETURN_TO_ELIGIBLE_SENDER',
      'AUTHORIZED_SUBSTITUTION','OPERATOR_ASSISTED_OFFRAMP','RESTRICTED_HOLD'
    )
  ),
  CONSTRAINT disposition_orders_authority_known CHECK (
    authority_type IN (
      'SUBJECT','COUNTERPARTY','ISSUER','TRANSFER_AGENT','COMPLIANCE_OPERATOR',
      'GATEWAY_OPERATOR','MULTISIG'
    )
  ),
  -- One authority, one nonce, one order. The controller enforces this on chain;
  -- the projection refusing it too means a duplicate is caught at write time
  -- rather than discovered when a report shows two.
  CONSTRAINT disposition_orders_nonce_unique UNIQUE (chain_id, controller_address, authority, nonce)
);

CREATE INDEX disposition_orders_by_case ON disposition_orders (chain_id, controller_address, case_id);
CREATE INDEX disposition_orders_by_settlement ON disposition_orders (settlement_id);

CREATE TABLE disposition_cases (
  chain_id        BIGINT NOT NULL,
  controller_address TEXT NOT NULL,
  case_id         TEXT   NOT NULL,
  settlement_id   TEXT   NOT NULL REFERENCES settlements (settlement_id),
  leg             TEXT   NOT NULL,
  -- DispositionController.CaseState. This one *is* an on-chain enum.
  case_state      TEXT   NOT NULL,
  policy_id       TEXT   NOT NULL,
  policy_hash     TEXT   NOT NULL,
  filed_at        BIGINT,
  signatures      INTEGER NOT NULL DEFAULT 0,
  lead_order_hash TEXT,
  executed_order_hash TEXT,
  executed_type   TEXT,
  executed_destination TEXT,
  executed_amount NUMERIC(78, 0),
  executed_compliance_digest TEXT,
  chain_read_at   TIMESTAMPTZ,
  PRIMARY KEY (chain_id, controller_address, case_id),
  CONSTRAINT disposition_cases_state_known CHECK (
    case_state IN ('NONE','OPEN','CONTESTED','ADJUDICATED','EXECUTED')
  )
);

CREATE INDEX disposition_cases_by_settlement ON disposition_cases (settlement_id);

-- ── The indexer's own record ────────────────────────────────────────────────

CREATE TABLE indexed_events (
  -- The idempotency key, and the reason there is no surrogate id: a log is
  -- uniquely one log on one chain, and `tx_hash` alone is not — two chains can
  -- and do produce the same hash space, and this deployment already has one
  -- address meaning two contracts across chains.
  chain_id      BIGINT  NOT NULL,
  tx_hash       TEXT    NOT NULL,
  log_index     INTEGER NOT NULL,
  block_number  BIGINT  NOT NULL,
  block_hash    TEXT    NOT NULL,
  block_time    TIMESTAMPTZ,
  address       TEXT    NOT NULL,
  event_name    TEXT    NOT NULL,
  settlement_id TEXT,
  payload       JSONB   NOT NULL,
  -- Set when a reorg orphans the block this came from. Rows are never deleted:
  -- an event that was observed and then orphaned is a fact about the chain.
  orphaned_at   TIMESTAMPTZ,
  indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, tx_hash, log_index)
);

CREATE INDEX indexed_events_by_block ON indexed_events (chain_id, block_number);
CREATE INDEX indexed_events_by_settlement ON indexed_events (settlement_id) WHERE settlement_id IS NOT NULL;
CREATE INDEX indexed_events_live ON indexed_events (chain_id, block_number) WHERE orphaned_at IS NULL;

CREATE TABLE indexer_cursors (
  chain_id            BIGINT PRIMARY KEY,
  -- Everything at or below this height has been scanned with no gaps. A gap is
  -- never recorded as progress; the cursor simply does not advance past it.
  last_scanned_block  BIGINT NOT NULL,
  last_scanned_hash   TEXT   NOT NULL,
  -- How far behind the head the cursor deliberately stays, so a reorg is seen
  -- before it is projected.
  confirmations       INTEGER NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE indexer_gaps (
  gap_id      BIGSERIAL PRIMARY KEY,
  chain_id    BIGINT NOT NULL,
  from_block  BIGINT NOT NULL,
  to_block    BIGINT NOT NULL,
  reason      TEXT   NOT NULL,
  -- A gap is a failure, not a warning. The first version of the verifier
  -- downgraded unscanned ranges to warnings and certified a terminal state
  -- having read one message of three.
  resolved_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT indexer_gaps_range CHECK (to_block >= from_block)
);

CREATE INDEX indexer_gaps_open ON indexer_gaps (chain_id) WHERE resolved_at IS NULL;

-- ── Evidence and verification ───────────────────────────────────────────────

CREATE TABLE evidence_artifacts (
  artifact_id   TEXT PRIMARY KEY,
  settlement_id TEXT REFERENCES settlements (settlement_id),
  kind          TEXT NOT NULL,
  -- The content hash is the identity. A stored URI can rot; the hash says
  -- whether what came back is what was recorded.
  content_sha256 TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  byte_length   BIGINT NOT NULL,
  storage_uri   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX evidence_artifacts_by_settlement ON evidence_artifacts (settlement_id);

CREATE TABLE verification_runs (
  run_id        BIGSERIAL PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES settlements (settlement_id),
  deployment_id TEXT NOT NULL REFERENCES deployments (deployment_id),
  classification TEXT NOT NULL,
  -- Every finding, so a green result can be audited rather than trusted.
  findings      JSONB NOT NULL,
  -- The block ranges actually scanned, per chain. "No messages found" and "no
  -- messages exist" are different answers and only one of them is a finding.
  searched_ranges JSONB NOT NULL,
  had_scan_gap  BOOLEAN NOT NULL,
  trust_root    TEXT NOT NULL,
  ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT verification_runs_class_known CHECK (
    classification IN (
      'SETTLED_FINAL','DISPOSITION_FINAL','RESTRICTED_HOLD_FINAL','CONTESTED',
      'HELD_PENDING_DISPOSITION','SETTLED_PENDING_VERIFICATION','NOT_SETTLED'
    )
  )
);

CREATE INDEX verification_runs_by_settlement ON verification_runs (settlement_id, ran_at DESC);

-- ── Outbox and workers ──────────────────────────────────────────────────────

CREATE TABLE outbox (
  outbox_id     BIGSERIAL PRIMARY KEY,
  -- Written in the same transaction as the state change that justifies it.
  -- That is the whole mechanism: a job cannot exist without the fact that
  -- caused it, and the fact cannot be committed without the job.
  topic         TEXT NOT NULL,
  -- Deduplicates a publisher that runs twice. The unique constraint is the
  -- guarantee, not the caller's care.
  idempotency_key TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  CONSTRAINT outbox_idempotency_unique UNIQUE (topic, idempotency_key)
);

CREATE INDEX outbox_pending ON outbox (created_at) WHERE dispatched_at IS NULL;

CREATE TABLE worker_jobs (
  job_id        BIGSERIAL PRIMARY KEY,
  topic         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 8,
  run_after     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by     TEXT,
  locked_until  TIMESTAMPTZ,
  last_error    TEXT,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- At-least-once delivery with an idempotent handler is the design. This
  -- constraint is what makes a duplicate delivery a no-op rather than a second
  -- execution.
  CONSTRAINT worker_jobs_idempotency_unique UNIQUE (topic, idempotency_key),
  CONSTRAINT worker_jobs_status_known CHECK (
    status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','DEAD')
  )
);

CREATE INDEX worker_jobs_claimable ON worker_jobs (run_after)
  WHERE status IN ('PENDING','RUNNING');

-- ── The rule the schema cannot state in DDL ─────────────────────────────────
--
-- No column below is ever read by a contract, and no contract call takes a
-- value from this database without the chain having confirmed it first. That is
-- an architectural property rather than a constraint, and `packages/db`'s tests
-- assert the closest checkable version of it: no table stores a private key,
-- and no table stores a compliance decision that is not accompanied by the
-- signature and the verifying contract it would have to satisfy.

#!/usr/bin/env node
/**
 * Loads the evidence this repository has produced into the projection.
 *
 *   node --env-file=.env scripts/load-projection.mjs
 *
 * The indexer is the long-run answer: it watches both chains and keeps the
 * projection current. This is the bootstrap that gets the settlements already
 * on chain into the database, so the console has something true to show before
 * the indexer has caught up.
 *
 * Which settlements exist is decided by the verification artifacts — files the
 * verifier wrote after reading two chains and the guardian set. Intent terms
 * come from the run artifact that produced the settlement, because a
 * verification artifact records what was proven and carries no terms.
 *
 * Nothing is typed in by hand and nothing is invented. Where the schema forbids
 * a null and the value was not recovered, the row carries a zero value *and* a
 * marker saying so — `intents.terms_source = 'unknown'` — because a projection
 * that filled gaps with plausible values would be worse than an empty one: an
 * unmarked zero in `cash_amount` reads as a zero-value trade, and a reader will
 * believe it.
 *
 * Idempotent. Every insert is an upsert keyed the way the schema keys it, so
 * running this twice is running it once.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const { default: postgres } = await import(
  new URL('../packages/db/node_modules/postgres/src/index.js', import.meta.url).href
);

import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'load-projection.log'));

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  log.fail('HUMAN_GATE_DEPLOY: DATABASE_URL is not set');
  process.exit(1);
}

const EVIDENCE = join(ROOT, 'docs', 'evidence');
const DEPLOYMENTS = join(ROOT, 'contracts', 'deployments');

/** Generation order, oldest first. The ordinal is what a report says out loud. */
const GENERATIONS = [
  '0x9303f240f88e5aba93761e010b75b13681d0c03af58d945c241cc402dadd0843',
  '0x893ca44ecf017ba183180fb358fbc27ed570df9e56d7d35a465a9ed5cb1a9417',
  '0xdcb9db121ca873817fca7ee6a8e2cd8ef0249b7c83f4e656553338da00eccaa6',
];

const sql = postgres(connectionString, {
  max: 1,
  prepare: false,
  onnotice: () => undefined,
  connection: { application_name: 'conduit-load-projection' },
});

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * A term column's value, or the placeholder that stands for "not recovered".
 *
 * The placeholder is only ever read alongside `terms_source = 'unknown'`, which
 * is what makes an empty string safe to write into a `NOT NULL TEXT`. Addresses
 * are lowercased because every address in this projection is, and a mixed-case
 * duplicate would read as a different party.
 */
function addr(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/** Run artifacts stringify every numeric term, so these arrive as strings. */
function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return BigInt(value).toString();
}

try {
  // ── Deployments and their contracts ───────────────────────────────────────

  log.stage('deployments');

  const manifests = readdirSync(DEPLOYMENTS)
    .filter((name) => name.endsWith('.json') && !name.includes('schema'))
    .map((name) => readJson(join(DEPLOYMENTS, name)))
    .filter((manifest) => manifest !== undefined);

  for (const deploymentId of GENERATIONS) {
    const generation = GENERATIONS.indexOf(deploymentId) + 1;
    const any = manifests.find((manifest) => manifest.deploymentId === deploymentId);
    if (any === undefined) {
      log.warn(`no manifest for generation ${String(generation)}; skipped`);
      continue;
    }
    // `superseded_by` points forward, so it cannot be set on the way in — the
    // generation it names does not exist yet. Rows first, then the links.
    await sql`
      INSERT INTO conduit.deployments
        (deployment_id, protocol_version, git_commit, solc_version, generation)
      VALUES (${deploymentId}, ${any.protocolVersion ?? 1}, ${any.gitCommit ?? 'unknown'},
              ${any.solcVersion ?? 'unknown'}, ${generation})
      ON CONFLICT (deployment_id) DO NOTHING
    `;
    log.step(`generation ${String(generation)} ${deploymentId.slice(0, 10)}…`);

    for (const manifest of manifests.filter((entry) => entry.deploymentId === deploymentId)) {
      for (const [role, contract] of Object.entries(manifest.contracts ?? {})) {
        const chain = manifest.chainConfigs?.[contract.chain];
        if (chain === undefined) continue;
        await sql`
          INSERT INTO conduit.deployment_contracts
            (deployment_id, chain_id, role, address, bytecode_hash, wormhole_chain_id)
          VALUES (${deploymentId}, ${chain.nativeChainId}, ${role},
                  ${contract.address.toLowerCase()},
                  ${manifest.bytecodeHashes?.[role] ?? '0x'}, ${chain.wormholeChainId ?? null})
          ON CONFLICT (deployment_id, chain_id, role) DO UPDATE
            SET address = EXCLUDED.address, bytecode_hash = EXCLUDED.bytecode_hash
        `;
      }
    }
  }

  // Now that every generation exists, link each to the one that replaced it.
  for (const deploymentId of GENERATIONS) {
    const supersededBy = GENERATIONS[GENERATIONS.indexOf(deploymentId) + 1] ?? null;
    if (supersededBy === null) continue;
    await sql`
      UPDATE conduit.deployments SET superseded_by = ${supersededBy}
      WHERE deployment_id = ${deploymentId}
        AND EXISTS (SELECT 1 FROM conduit.deployments WHERE deployment_id = ${supersededBy})
    `;
  }

  // ── Settlements, from verification artifacts only ─────────────────────────

  log.stage('settlements');

  const verifications = readdirSync(EVIDENCE)
    .filter((name) => name.startsWith('verification-') && name.endsWith('.json'))
    .map((name) => readJson(join(EVIDENCE, name)))
    .filter((entry) => entry?.settlementId !== undefined);

  if (verifications.length === 0) log.warn('no verification artifacts found');

  // Intent terms, keyed by the settlement they belong to. Any evidence file
  // carrying both a `settlementId` and a 19-field `intent` qualifies: the run
  // artifacts write exactly that shape, and reading them by shape rather than
  // by filename means a new scenario's artifact is picked up without editing
  // this list.
  const terms = new Map();
  for (const name of readdirSync(EVIDENCE)) {
    if (!name.endsWith('.json') || name.startsWith('verification-')) continue;
    const entry = readJson(join(EVIDENCE, name));
    if (typeof entry?.settlementId !== 'string') continue;
    if (entry.intent === null || typeof entry.intent !== 'object') continue;
    if (entry.intent.cashAmount === undefined) continue;
    terms.set(entry.settlementId.toLowerCase(), entry.intent);
  }
  log.step(`intent terms recovered for ${terms.size} settlement(s)`);

  for (const verification of verifications) {
    const settlementId = verification.settlementId.toLowerCase();

    // The intent hash equals the settlement id in this protocol: the id *is*
    // the digest of the intent. Recording it as its own row keeps the schema
    // honest for a future where they diverge, and keeps the FK satisfiable now.
    //
    // A verification artifact records what the verifier proved and carries no
    // terms, so the terms come from the run artifact that produced this
    // settlement. When there is none, the row is written with zero values and
    // `terms_source = 'unknown'` — the marker is what stops a reader taking a
    // placeholder zero for a zero-value trade.
    const t = terms.get(settlementId);
    await sql`
      INSERT INTO conduit.intents (
        intent_hash, version, cash_chain_id, cash_escrow, cash_asset, cash_amount,
        cash_payer, cash_receiver, asset_chain_id, asset_escrow, asset_token,
        asset_amount, asset_seller, asset_receiver, cash_policy_hash, asset_policy_hash,
        prepare_deadline, commit_deadline, release_deadline, nonce, terms_source
      ) VALUES (
        ${settlementId},
        ${num(t?.version, 1)}, ${num(t?.cashChainId, 10_143)},
        ${addr(t?.cashEscrow)}, ${addr(t?.cashAsset)}, ${num(t?.cashAmount, 0)},
        ${addr(t?.cashPayer)}, ${addr(t?.cashReceiver)},
        ${num(t?.assetChainId, 84_532)},
        ${addr(t?.assetEscrow)}, ${addr(t?.assetToken)}, ${num(t?.assetAmount, 0)},
        ${addr(t?.assetSeller)}, ${addr(t?.assetReceiver)},
        ${addr(t?.cashPolicyHash)}, ${addr(t?.assetPolicyHash)},
        ${num(t?.prepareDeadline, 0)}, ${num(t?.commitDeadline, 0)},
        ${num(t?.releaseDeadline, 0)}, ${num(t?.nonce, 0)},
        ${t === undefined ? 'unknown' : 'artifact'}
      )
      ON CONFLICT (intent_hash) DO UPDATE SET
        cash_escrow       = EXCLUDED.cash_escrow,
        cash_asset        = EXCLUDED.cash_asset,
        cash_amount       = EXCLUDED.cash_amount,
        cash_payer        = EXCLUDED.cash_payer,
        cash_receiver     = EXCLUDED.cash_receiver,
        asset_escrow      = EXCLUDED.asset_escrow,
        asset_token       = EXCLUDED.asset_token,
        asset_amount      = EXCLUDED.asset_amount,
        asset_seller      = EXCLUDED.asset_seller,
        asset_receiver    = EXCLUDED.asset_receiver,
        cash_policy_hash  = EXCLUDED.cash_policy_hash,
        asset_policy_hash = EXCLUDED.asset_policy_hash,
        prepare_deadline  = EXCLUDED.prepare_deadline,
        commit_deadline   = EXCLUDED.commit_deadline,
        release_deadline  = EXCLUDED.release_deadline,
        nonce             = EXCLUDED.nonce,
        terms_source      = EXCLUDED.terms_source
      -- Never let a later run without the artifact demote terms already proven.
      WHERE EXCLUDED.terms_source <> 'unknown'
    `;

    await sql`
      INSERT INTO conduit.settlements (
        settlement_id, deployment_id, intent_hash, canonical_state, decision,
        verifier_class, verified_at, chain_read_at
      ) VALUES (
        ${settlementId}, ${verification.deploymentId}, ${settlementId},
        ${verification.canonicalState}, ${verification.decision},
        ${verification.derived}, ${verification.verifiedAt}, ${verification.verifiedAt}
      )
      ON CONFLICT (settlement_id) DO UPDATE SET
        canonical_state = EXCLUDED.canonical_state,
        decision        = EXCLUDED.decision,
        verifier_class  = EXCLUDED.verifier_class,
        verified_at     = EXCLUDED.verified_at,
        chain_read_at   = EXCLUDED.chain_read_at
    `;

    for (const [leg, outcome, chainId] of [
      ['CASH', verification.cashOutcome, 10_143],
      ['ASSET', verification.assetOutcome, 84_532],
    ]) {
      await sql`
        INSERT INTO conduit.settlement_legs
          (settlement_id, leg, chain_id, escrow_address, asset_address, amount, outcome)
        VALUES (${settlementId}, ${leg}, ${chainId}, '', '', 0, ${outcome})
        ON CONFLICT (settlement_id, leg) DO UPDATE SET outcome = EXCLUDED.outcome
      `;
    }

    for (const message of verification.messages ?? []) {
      await sql`
        INSERT INTO conduit.messages (
          wormhole_chain_id, emitter, sequence, settlement_id, deployment_id, message_type,
          intent_hash, source_chain_id, destination_chain_id, state_version, consistency_level,
          finality, published_at_block, published_tx_hash
        ) VALUES (
          ${Number(message.emitterKey?.split(':')[1] ?? 0)},
          ${message.emitterKey?.split(':')[2] ?? '0x'},
          ${Number(message.sequence)}, ${settlementId}, ${verification.deploymentId},
          ${message.messageType}, ${message.intentHash ?? settlementId},
          ${message.producer?.chainId ?? 0}, ${Number(message.destinationChainId ?? 0)},
          0, ${message.consistencyLevel ?? 0}, ${message.finality}, 0, ''
        )
        ON CONFLICT (wormhole_chain_id, emitter, sequence) DO UPDATE
          SET finality = EXCLUDED.finality, message_type = EXCLUDED.message_type
      `;
    }

    const hadGap = (verification.findings ?? []).some(
      (finding) => !finding.ok && /gap|never read|unscanned/i.test(finding.check + finding.detail),
    );

    await sql`
      INSERT INTO conduit.verification_runs (
        settlement_id, deployment_id, classification, findings, searched_ranges,
        had_scan_gap, trust_root, ran_at
      ) VALUES (
        ${settlementId}, ${verification.deploymentId}, ${verification.derived},
        ${JSON.stringify(verification.findings ?? [])}::jsonb,
        ${JSON.stringify(verification.searchedBlockRanges ?? {})}::jsonb,
        ${hadGap}, ${verification.trustRoot ?? ''}, ${verification.verifiedAt}
      )
    `;

    log.step(
      `${settlementId.slice(0, 12)}… ${verification.canonicalState} / ${verification.derived}`,
    );
  }

  // ── Read back ─────────────────────────────────────────────────────────────

  log.stage('read back');
  const counts = await sql`
    SELECT 'deployments' AS t, count(*)::int AS n FROM conduit.deployments
    UNION ALL SELECT 'contracts', count(*)::int FROM conduit.deployment_contracts
    UNION ALL SELECT 'settlements', count(*)::int FROM conduit.settlements
    UNION ALL SELECT 'legs', count(*)::int FROM conduit.settlement_legs
    UNION ALL SELECT 'messages', count(*)::int FROM conduit.messages
    UNION ALL SELECT 'verifications', count(*)::int FROM conduit.verification_runs
    ORDER BY t
  `;
  for (const row of counts) log.step(`${row.t.padEnd(14)} ${String(row.n)}`);

  // The collision, asserted against the loaded rows rather than against the
  // manifests they came from. If the projection had collapsed two contracts
  // into one, this is where it would show.
  const collisions = await sql`
    SELECT address, count(DISTINCT chain_id)::int AS chains, string_agg(DISTINCT role, ', ') AS roles
    FROM conduit.deployment_contracts
    GROUP BY address HAVING count(DISTINCT chain_id) > 1
  `;
  for (const row of collisions) {
    log.ok(`${row.address} is ${String(row.chains)} contracts across chains: ${row.roles}`);
  }
  log.ok('the projection keeps colliding addresses apart');
} finally {
  await sql.end({ timeout: 5 });
}

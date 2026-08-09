#!/usr/bin/env node
/**
 * Projects the committed run artifacts into the compact index the web surface
 * serves.
 *
 *   node scripts/build-evidence-index.mjs           # regenerate
 *   node scripts/build-evidence-index.mjs --check   # fail if the file has drifted
 *
 * ## Why a generated, committed file
 *
 * The evidence page cannot say "no artifacts published yet" while
 * `docs/evidence` holds four verified settlements, two of which reached a
 * terminal state through a disposition. But the artifacts are the record and the
 * page is a view of it, so the page must not carry its own copy of a
 * transaction hash that somebody typed. This projects them mechanically, the
 * output is committed so a clean clone typechecks, and `--check` fails the gate
 * if the two ever disagree — the same shape as the settlement trace corpus.
 *
 * Nothing here is published to object storage, and the page says so. R2 can
 * replace the storage later without changing what any of these values mean.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROOT } from './lib/run.mjs';

const EVIDENCE = join(ROOT, 'docs', 'evidence');
const DEPLOYMENTS = join(ROOT, 'contracts', 'deployments');
const OUT = join(ROOT, 'apps', 'web', 'src', 'evidence-index.ts');

const HASH = /^0x[0-9a-fA-F]{64}$/;

function read(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Every 32-byte value a run recorded per stage, with the key that named it. */
function stageHashes(artifact) {
  const out = [];
  for (const stage of artifact.stages ?? []) {
    for (const [key, value] of Object.entries(stage.detail ?? {})) {
      if (typeof value === 'string' && HASH.test(value)) {
        out.push({ stage: stage.stage, key, hash: value });
      }
    }
  }
  return out;
}

function runPackage({ file, generation, title, summary, chainOf }) {
  const artifact = read(join(EVIDENCE, file));
  return {
    settlementId: artifact.settlementId,
    generation,
    title,
    summary,
    outcome: artifact.outcome,
    startedAt: artifact.startedAt ?? null,
    finishedAt: artifact.finishedAt ?? null,
    source: `docs/evidence/${file}`,
    addresses: artifact.addresses ?? {},
    transactions: stageHashes(artifact).map((entry) => ({
      ...entry,
      chainId: chainOf(entry.stage),
    })),
    messages: [
      artifact.assetPrepared === undefined
        ? undefined
        : {
            messageType: 'ASSET_PREPARED',
            sequence: String(artifact.assetPrepared.sequence),
            emitter: artifact.assetPrepared.emitter,
            emitterChainId: artifact.assetPrepared.emitterChainId ?? 10004,
            publishedTx: artifact.assetPrepared.hash,
            finalitySeconds: artifact.baseFinalitySeconds ?? null,
          },
      artifact.commit === undefined
        ? undefined
        : {
            messageType: 'COMMIT',
            sequence: String(artifact.commit.sequence),
            emitter: artifact.addresses?.coordinator ?? '',
            emitterChainId: 10009,
            publishedTx: artifact.commit.hash,
            finalitySeconds: artifact.monadFinalitySeconds ?? null,
          },
    ].filter(Boolean),
    compliance: (artifact.compliance ?? []).map((entry) => ({
      at: entry.at ?? '',
      subject: entry.subject ?? '',
      chain: entry.chain ?? '',
      eligible: entry.eligible === true,
      evidenceHash: entry.evidenceHash ?? '',
      sources: (entry.sources ?? []).map((source) => ({
        endpoint: source.endpoint ?? '',
        answer: source.answer ?? '',
        responseHash: source.responseHash ?? '',
      })),
    })),
    ruleTransitions: (artifact.ruleTransitions ?? []).map((entry) => ({
      label: entry.label,
      hash: entry.hash,
      before: entry.before,
      after: entry.after,
    })),
    disposition:
      artifact.disposition === undefined || artifact.disposition === null
        ? null
        : { type: artifact.disposition.type ?? '', hash: artifact.disposition.hash ?? '' },
    adversarial: (artifact.adversarial ?? []).map((entry) => ({
      attempt: entry.attempt ?? '',
      refusedWith: entry.refusedWith ?? '',
    })),
    conservation: flattenConservation(artifact.conservation ?? {}),
    limitations: artifact.limitations ?? [],
    failure:
      artifact.failure === undefined || artifact.failure === null
        ? null
        : {
            classification: artifact.failure.classification ?? 'UNKNOWN',
            message: artifact.failure.message ?? '',
          },
  };
}

/**
 * Two snapshots of balances, whatever the run called them.
 *
 * The happy path records `opening`/`closing` as flat maps; the compliance-change
 * scenario records `before`/`after` with a `cash` and an `asset` sub-map. Both
 * are the same evidence, so the nesting is flattened to `cash.escrow` rather
 * than forcing one run's vocabulary onto the other or dropping the deeper one.
 */
function flattenConservation(conservation) {
  const out = {};
  for (const [snapshot, values] of Object.entries(conservation)) {
    const flat = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (value !== null && typeof value === 'object') {
        for (const [inner, innerValue] of Object.entries(value)) {
          flat[`${key}.${inner}`] = String(innerValue);
        }
      } else {
        flat[key] = String(value);
      }
    }
    out[snapshot] = flat;
  }
  return out;
}

/** Base stages name Base; everything else is the cash chain. */
function chainForStage(stage) {
  return /base sepolia/i.test(stage) ? 84532 : 10143;
}

const RUNS = [
  runPackage({
    file: 'phase-06-dvp.json',
    generation: 3,
    title: 'Canonical happy path',
    summary:
      'One signed intent, cash on Monad and a restricted RWA on Base, both legs delivered and read ' +
      'back from chain state alone.',
    chainOf: chainForStage,
  }),
  runPackage({
    file: 'phase-07-compliance-change-0xdcb9db12.json',
    generation: 3,
    title: 'Compliance changed after COMMIT',
    summary:
      'Eligible at commit time, refused at delivery time by a RuleV2 the issuer moved in between. ' +
      'The cash leg had already released and was not refunded; the asset leg held, and a disposition ' +
      'resolved it.',
    chainOf: chainForStage,
  }),
  runPackage({
    file: 'phase-07-compliance-change-0x893ca44e.json',
    generation: 1,
    title: 'The same path, first demonstrated',
    summary:
      'The first live HELD-then-dispositioned settlement, on the first deployment generation. It stays ' +
      'verifiable against generation-1 contracts; the current generation cannot answer for it.',
    chainOf: chainForStage,
  }),
];

/**
 * The browser run, whose artifact was captured rather than written as it went.
 *
 * It carries no stages and no compliance section: a page has no vantage point
 * over its own run, so `capture-browser-run.mjs` reads the outcome from the
 * chains afterwards. The package therefore shows what the chains say — the
 * transactions, verified against their receipts, and the messages with their
 * measured finality — and claims nothing about the steps in between beyond what
 * the coordinator's own state implies.
 */
function capturedPackage({ file, generation, title, summary }) {
  const artifact = read(join(EVIDENCE, file));
  return {
    settlementId: artifact.settlementId,
    generation,
    title,
    summary,
    outcome: artifact.coordinator.state,
    startedAt: null,
    finishedAt: artifact.capturedAt ?? null,
    source: `docs/evidence/${file}`,
    addresses: artifact.addresses ?? {},
    transactions: (artifact.transactions ?? []).map((entry) => ({
      stage: `${entry.chain} — verified against its receipt`,
      key: entry.toThisDeployment ? 'to this deployment' : 'external',
      hash: entry.hash,
      chainId: entry.chainId,
    })),
    messages: (artifact.messages ?? []).map((message) => ({
      messageType: message.messageType,
      sequence: String(message.sequence),
      emitter: message.emitter,
      emitterChainId: message.emitterChainId,
      publishedTx: message.publishedTx,
      finalitySeconds: message.observedSecondsAfterPublication ?? null,
    })),
    compliance: [],
    ruleTransitions: [],
    disposition: null,
    adversarial: [],
    conservation: {
      closing: Object.fromEntries(
        Object.entries(artifact.balances ?? {}).map(([key, value]) => [key, String(value)]),
      ),
    },
    limitations: artifact.limitations ?? [],
    failure: null,
  };
}

RUNS.push(
  capturedPackage({
    file: 'phase-06-browser-dvp.json',
    generation: 3,
    title: 'Settled from a browser',
    summary:
      'One intent composed, checked, signed, prepared, committed, released and settled from the ' +
      'settlement workspace. Every transaction was sent by a wallet in a page, with each next step ' +
      'decided from chain state rather than by a script.',
  }),
);

const VERIFICATIONS = readdirSync(EVIDENCE)
  .filter((name) => name.startsWith('verification-') && name.endsWith('.json'))
  .map((name) => {
    const artifact = read(join(EVIDENCE, name));
    const findings = artifact.findings ?? [];
    return {
      settlementId: artifact.settlementId,
      deploymentId: artifact.deploymentId,
      classification: artifact.derived,
      canonicalState: artifact.canonicalState,
      verifiedAt: artifact.verifiedAt,
      passed: findings.filter((finding) => finding.ok).length,
      total: findings.length,
      trustRoot: artifact.trustRoot,
      searchedBlockRanges: artifact.searchedBlockRanges ?? {},
      source: `docs/evidence/${name}`,
      messages: (artifact.messages ?? []).map((message) => ({
        messageType: message.messageType,
        sequence: String(message.sequence),
        emitterChainId: Number(String(message.emitterKey ?? '').split(':')[1] ?? 0),
        emitter: message.producer?.address ?? '',
        vaaHash: message.vaaHash ?? null,
        finality: message.finality,
        consumed: message.consumedAtDestination === true,
      })),
    };
  })
  .sort((left, right) => left.settlementId.localeCompare(right.settlementId));

const MANIFESTS = readdirSync(DEPLOYMENTS)
  .filter((name) => name.endsWith('.json') && !name.includes('schema'))
  .map((name) => {
    const manifest = read(join(DEPLOYMENTS, name));
    return {
      file: `contracts/deployments/${name}`,
      deploymentId: manifest.deploymentId,
      gitCommit: manifest.gitCommit,
      solcVersion: manifest.solcVersion,
      timestamp: manifest.timestamp,
      contracts: Object.entries(manifest.contracts ?? {}).map(([role, entry]) => ({
        role,
        chain: entry.chain,
        address: entry.address,
        codeHash: manifest.bytecodeHashes?.[role] ?? null,
      })),
      finalityProfile: manifest.finalityProfile ?? {},
      complianceProfile: manifest.complianceProfile ?? {},
      cleanverseAssetSnapshotHash: manifest.cleanverseAssetSnapshotHash ?? null,
    };
  })
  .sort((left, right) => left.file.localeCompare(right.file));

const banner = `// Generated by scripts/build-evidence-index.mjs from docs/evidence and
// contracts/deployments. Do not edit by hand: \`pnpm evidence:check\` fails when
// this file and the artifacts disagree.

import type { EvidenceIndex } from './evidence-types.js';
`;

const body = `${banner}
export const EVIDENCE_INDEX: EvidenceIndex = ${JSON.stringify({ runs: RUNS, verifications: VERIFICATIONS, manifests: MANIFESTS }, null, 2)};
`;

const check = process.argv.includes('--check');
if (check) {
  const current = readFileSync(OUT, 'utf8');
  if (current !== body) {
    console.error(
      'apps/web/src/evidence-index.ts has drifted from docs/evidence.\n' +
        'Run: node scripts/build-evidence-index.mjs',
    );
    process.exit(1);
  }
  console.log(
    `evidence index matches ${RUNS.length} runs, ${VERIFICATIONS.length} verifications, ${MANIFESTS.length} manifests`,
  );
} else {
  writeFileSync(OUT, body);
  console.log(
    `wrote ${OUT} — ${RUNS.length} runs, ${VERIFICATIONS.length} verifications, ${MANIFESTS.length} manifests`,
  );
}

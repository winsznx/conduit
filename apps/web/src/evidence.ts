/**
 * The evidence explorer's data.
 *
 * Built from `apps/web/src/evidence-index.ts`, which is projected mechanically
 * from the committed run artifacts by `scripts/build-evidence-index.mjs`. The
 * page holds no transcribed hash of its own.
 *
 * ## What "published" means here, and what it does not
 *
 * These artifacts are served from the repository this Worker was built from.
 * They are not content-addressed in object storage and this page does not claim
 * they are: the source of every package is named as a repository path, and the
 * only content addresses on the page are the ones the protocol itself produced —
 * transaction hashes, VAA hashes, Cleanverse response hashes, code hashes,
 * policy hashes. Those are verifiable against two chains and a guardian set with
 * no help from this server, which is the property that matters. R2 can replace
 * the storage later without changing the meaning of a single value below.
 * ASM-039 stays open until it does.
 */

import { EVIDENCE_INDEX } from './evidence-index.js';
import type { EvidenceRun } from './evidence-types.js';

export type ArtifactKind =
  | 'transaction'
  | 'message'
  | 'compliance'
  | 'policy'
  | 'refusal'
  | 'conservation'
  | 'verifier'
  | 'contract';

export interface ProofArtifact {
  readonly kind: ArtifactKind;
  readonly label: string;
  readonly value: string;
  readonly chainId?: number;
  readonly note?: string;
  readonly at?: string;
}

export interface ProofPackage {
  readonly settlementId: string;
  readonly title: string;
  readonly summary: string;
  readonly generation: number;
  readonly outcome: string;
  readonly source: string;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  readonly note: string | undefined;
  readonly artifacts: readonly ProofArtifact[];
  readonly verification:
    | {
        classification: string;
        canonicalState: string;
        passed: number;
        total: number;
        verifiedAt: string;
        trustRoot: string;
        source: string;
      }
    | undefined;
}

const WORMHOLE_TO_EVM: Readonly<Record<number, number>> = Object.freeze({
  10_009: 10_143,
  10_004: 84_532,
});

/**
 * A run whose own assertion was wrong is still a run.
 *
 * `phase-06-dvp.json` records `outcome: FAILED` because the conservation check
 * it applied was written for a single-pass run and the run had resumed. The
 * settlement itself reached SETTLED on chain and an independent verification
 * classifies it SETTLED_FINAL. Hiding the recorded failure would be the more
 * flattering choice and the dishonest one, so it is carried through with the
 * reason attached.
 */
function noteFor(run: EvidenceRun): string | undefined {
  const failure = run.failure;
  if (failure === null) return undefined;
  return (
    `The run recorded ${failure.classification}: “${failure.message}”. ` +
    'That is the runner’s own assertion, not a chain outcome — it compared a resumed run’s closing ' +
    'balances against a mid-flight opening snapshot. The settlement’s chain state and the ' +
    'independent verification below are what say what happened.'
  );
}

function artifactsFor(run: EvidenceRun): readonly ProofArtifact[] {
  const out: ProofArtifact[] = [];

  for (const transaction of run.transactions) {
    out.push({
      kind: 'transaction',
      label: `${transaction.key} — ${transaction.stage}`,
      value: transaction.hash,
      chainId: transaction.chainId,
    });
  }

  for (const message of run.messages) {
    out.push({
      kind: 'message',
      label: `${message.messageType} sequence ${message.sequence}`,
      value: message.publishedTx,
      chainId: WORMHOLE_TO_EVM[message.emitterChainId] ?? 0,
      note:
        message.finalitySeconds === null
          ? 'finality not measured on this run'
          : `signed at FINALIZED after ${String(message.finalitySeconds)} seconds`,
    });
  }

  for (const entry of run.compliance) {
    out.push({
      kind: 'compliance',
      label: `${entry.chain} — ${entry.subject} ${entry.eligible ? 'eligible' : 'refused'}`,
      value: entry.evidenceHash,
      at: entry.at,
      note: entry.sources.map((source) => `${source.endpoint} ${source.answer}`).join(', '),
    });
  }

  for (const transition of run.ruleTransitions) {
    out.push({
      kind: 'policy',
      label: `RuleV2 ${transition.label}`,
      value: transition.hash,
      chainId: 84_532,
      note: `${transition.before} → ${transition.after}`,
    });
  }

  if (run.disposition !== null) {
    out.push({
      kind: 'transaction',
      label: `disposition — ${run.disposition.type}`,
      value: run.disposition.hash,
      chainId: 84_532,
    });
  }

  for (const refusal of run.adversarial) {
    out.push({
      kind: 'refusal',
      label: refusal.attempt,
      value: refusal.refusedWith,
      note: 'simulated against the deployed contract and refused',
    });
  }

  // Whatever the run called its two snapshots. The happy path says
  // opening/closing and the compliance-change run says before/after; both are
  // the same evidence and neither vocabulary is imposed on the other.
  const snapshots = Object.entries(run.conservation);
  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  if (first !== undefined && last !== undefined) {
    for (const [key, value] of Object.entries(last[1])) {
      out.push({
        kind: 'conservation',
        label: `${last[0]} ${key}`,
        value,
        note: `${first[0]} ${first[1][key] ?? 'not recorded'}`,
      });
    }
  }

  return out;
}

function verificationFor(settlementId: string): ProofPackage['verification'] {
  const found = EVIDENCE_INDEX.verifications.find(
    (verification) => verification.settlementId.toLowerCase() === settlementId.toLowerCase(),
  );
  if (found === undefined) return undefined;
  return {
    classification: found.classification,
    canonicalState: found.canonicalState,
    passed: found.passed,
    total: found.total,
    verifiedAt: found.verifiedAt,
    trustRoot: found.trustRoot,
    source: found.source,
  };
}

/** Every proof package this build carries, newest generation first. */
export const PROOF_PACKAGES: readonly ProofPackage[] = EVIDENCE_INDEX.runs
  .map((run) => ({
    settlementId: run.settlementId,
    title: run.title,
    summary: run.summary,
    generation: run.generation,
    outcome: run.outcome,
    source: run.source,
    startedAt: run.startedAt ?? undefined,
    finishedAt: run.finishedAt ?? undefined,
    note: noteFor(run),
    artifacts: artifactsFor(run),
    verification: verificationFor(run.settlementId),
  }))
  .sort((left, right) => right.generation - left.generation);

export function proofPackage(settlementId: string): ProofPackage | undefined {
  return PROOF_PACKAGES.find(
    (proof) => proof.settlementId.toLowerCase() === settlementId.toLowerCase(),
  );
}

/** Verifications with no run artifact still count: they are their own evidence. */
export const VERIFICATIONS = EVIDENCE_INDEX.verifications;

export const MANIFESTS = EVIDENCE_INDEX.manifests;

/**
 * The disposition that actually happened, as a sequence anyone can re-walk.
 *
 * Read out of the artifacts rather than written here, so a page cannot describe
 * a path the evidence does not contain.
 */
export interface DispositionHistory {
  readonly settlementId: string;
  readonly generation: number;
  readonly dispositionType: string;
  readonly executedTx: string;
  readonly steps: readonly { label: string; detail: string }[];
}

export const DISPOSITION_HISTORY: readonly DispositionHistory[] = EVIDENCE_INDEX.runs
  .filter((run) => run.disposition !== null)
  .map((run) => {
    const disposition = run.disposition ?? { type: '', hash: '' };
    const [restrict, restore] = run.ruleTransitions;
    const refusal = run.compliance.find((entry) => !entry.eligible);
    return {
      settlementId: run.settlementId,
      generation: run.generation,
      dispositionType: disposition.type,
      executedTx: disposition.hash,
      steps: [
        {
          label: 'Eligible at commit time',
          detail:
            run.compliance.find((entry) => entry.eligible)?.evidenceHash ??
            'no commit-time answer recorded',
        },
        { label: 'COMMIT issued', detail: run.messages[1]?.publishedTx ?? 'no COMMIT recorded' },
        {
          label: 'RuleV2 changed',
          detail:
            restrict === undefined
              ? 'no policy transition recorded'
              : `${restrict.label} — ${restrict.hash}`,
        },
        {
          label: 'Delivery refused, leg HELD',
          detail:
            refusal === undefined
              ? 'no refusal recorded'
              : `${refusal.sources.map((source) => source.answer).join(', ')} — ${refusal.evidenceHash}`,
        },
        {
          label: 'RuleV2 restored',
          detail:
            restore === undefined
              ? 'no restoring transition recorded'
              : `${restore.label} — ${restore.hash}`,
        },
        { label: `${disposition.type} executed`, detail: disposition.hash },
      ],
    };
  })
  .sort((left, right) => right.generation - left.generation);

/**
 * What a Conduit worker is allowed to do, and what makes that safe.
 *
 * PRD 4.5: the relayer has no authority to create settlement truth. Every job
 * below is a *permissionless* protocol action — one that anybody may take, that
 * the contracts authorize from signatures and VAAs rather than from the caller,
 * and that reverts harmlessly if it has already happened.
 *
 * That is the entire safety argument for at-least-once delivery. Exactly-once
 * is not available across a database and two chains, so the design does not
 * pretend to have it: jobs are idempotent, duplicates collide on a unique key
 * before they run, and a duplicate that somehow ran anyway would revert on
 * chain. A worker that held real authority could not be built this way, which
 * is why it does not hold any.
 *
 * The jobs a worker must never have:
 *
 *   - deciding a settlement's outcome. The coordinator does that.
 *   - deciding eligibility. A signed quorum does that.
 *   - authorizing a disposition. A registered authority signs that.
 *   - timing out into a refund. PRD FR-008 forbids it outright.
 */

export const TOPICS = {
  /** Submit an ASSET_PREPARED VAA to the coordinator. Anyone may. FR-009. */
  RELAY_PREPARED: 'relay.prepared',
  /** Submit a COMMIT VAA to an escrow. Anyone may. FR-009. */
  RELAY_COMMIT: 'relay.commit',
  /** Carry a leg's resolution report home. Anyone may. */
  RELAY_RESOLUTION: 'relay.resolution',
  /** Re-read chain state into the projection. Touches nothing on chain. */
  REFRESH_SETTLEMENT: 'projection.refresh',
  /** Run the independent verifier and store the result. Read-only. */
  VERIFY_SETTLEMENT: 'verify.settlement',
  /** Fetch and hash an evidence artifact. Read-only. */
  CAPTURE_EVIDENCE: 'evidence.capture',
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

/**
 * Every topic, and whether it may send a transaction.
 *
 * Enumerated rather than inferred, so adding a job that moves value is a
 * deliberate edit to this table and shows up in a diff as one.
 */
export const TOPIC_SENDS_TRANSACTION: Readonly<Record<Topic, boolean>> = Object.freeze({
  [TOPICS.RELAY_PREPARED]: true,
  [TOPICS.RELAY_COMMIT]: true,
  [TOPICS.RELAY_RESOLUTION]: true,
  [TOPICS.REFRESH_SETTLEMENT]: false,
  [TOPICS.VERIFY_SETTLEMENT]: false,
  [TOPICS.CAPTURE_EVIDENCE]: false,
});

export type JobOutcome =
  | { readonly status: 'DONE'; readonly detail: string }
  /** The work was already done by somebody else. Success, not failure. */
  | { readonly status: 'ALREADY_DONE'; readonly detail: string }
  /** A precondition is not met yet. Retry later; nothing is wrong. */
  | { readonly status: 'NOT_YET'; readonly detail: string }
  | { readonly status: 'FAILED'; readonly detail: string };

export interface JobContext {
  readonly topic: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempt: number;
}

export type Handler = (context: JobContext) => Promise<JobOutcome>;

/**
 * Turns a chain revert into the right kind of outcome.
 *
 * The distinction that matters: a VAA that is already consumed is the system
 * working, and a job that reported it as a failure would retry until it went
 * dead and page somebody about a settlement that completed. A revert nobody
 * recognises is a real failure and must not be swallowed into "already done" —
 * that would hide a genuine protocol refusal behind a shrug.
 */
const ALREADY_DONE_ERRORS = [
  'VaaAlreadyConsumed',
  'LegAlreadyPrepared',
  'LegAlreadyResolved',
  'AlreadyDecided',
  'ReservationAlreadyCommitted',
  'CaseIsTerminal',
  'NonceAlreadyUsed',
];

const NOT_YET_ERRORS = [
  'NotReady',
  'ContestWindowOpen',
  'SignaturesBelowThreshold',
  'LegNotPrepared',
  'GrantNotMatured',
];

export function classifyRevert(error: unknown): JobOutcome {
  const message = error instanceof Error ? error.message : String(error);

  for (const name of ALREADY_DONE_ERRORS) {
    if (message.includes(name)) {
      return { status: 'ALREADY_DONE', detail: `${name}: the work was already done` };
    }
  }
  for (const name of NOT_YET_ERRORS) {
    if (message.includes(name)) {
      return { status: 'NOT_YET', detail: `${name}: a precondition is not met yet` };
    }
  }
  return { status: 'FAILED', detail: message.split('\n')[0]?.slice(0, 500) ?? 'unknown' };
}

/**
 * The key that makes two deliveries of one fact a single job.
 *
 * Derived from the fact, never from a clock or a counter. A UUID here would
 * make every retry a new job and the unique constraint decorative — which is
 * the usual way an outbox stops protecting anything.
 */
export function idempotencyKeyFor(
  topic: Topic,
  parts: Readonly<Record<string, string | number>>,
): string {
  const ordered = Object.keys(parts)
    .sort()
    .map((key) => `${key}=${String(parts[key])}`)
    .join(':');
  return `${topic}|${ordered}`;
}

/**
 * A job whose transaction would move value must name the settlement it belongs
 * to, so an operator reading a dead-letter queue can tell what is stuck.
 */
export function requireSettlementScope(context: JobContext): string {
  const settlementId = context.payload['settlementId'];
  if (typeof settlementId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(settlementId)) {
    throw new Error(`${context.topic}: payload has no settlementId`);
  }
  return settlementId;
}

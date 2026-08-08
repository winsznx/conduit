import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';

import { outbox, workerJobs } from './schema.js';

import type { Database } from './client.js';

/**
 * The transactional outbox, and the job queue it feeds.
 *
 * PRD 11.7. The property this exists for: a side effect is never scheduled
 * without the state change that justifies it, and the state change never
 * commits without the side effect being scheduled. Both live in one Postgres
 * transaction, so there is no window where one exists and the other does not —
 * which is exactly the window an in-memory queue is.
 *
 * CLAUDE.md's rule is the same one from the other direction: no critical action
 * may exist solely in an in-memory queue. A process that dies between "I wrote
 * the settlement" and "I enqueued the relay" must lose neither.
 *
 * ## Delivery is at-least-once and handlers are idempotent
 *
 * Exactly-once delivery is not available across a database and a chain, and
 * pretending otherwise produces a system that loses work when it is wrong.
 * Every job carries an idempotency key with a unique constraint, so a duplicate
 * delivery collides at insert rather than executing twice.
 *
 * That is safe here because every protocol action a worker takes is
 * permissionless and idempotent by construction: submitting a VAA that is
 * already consumed reverts, issuing a COMMIT that already exists reverts, and
 * neither loses anything. The worker never holds authority the protocol does
 * not already grant to anyone.
 */

export interface OutboxRecord {
  readonly topic: string;
  /**
   * What makes two publishes of the same fact one job.
   *
   * Derived from the fact, never from a clock or a counter: `settlement:relay:
   * <chainId>:<txHash>:<logIndex>` deduplicates a re-indexed log, and
   * `settlement:verify:<settlementId>:<stateVersion>` deduplicates a re-read of
   * unchanged state. A UUID here would make every retry a new job.
   */
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Writes outbox rows inside the caller's transaction.
 *
 * Takes the transaction rather than the database on purpose: a signature that
 * accepted a pool would let a caller publish outside the transaction that
 * justified it, which is the failure this module exists to make impossible.
 */
export async function publish(tx: Database, records: readonly OutboxRecord[]): Promise<void> {
  if (records.length === 0) return;
  await tx
    .insert(outbox)
    .values(
      records.map((record) => ({
        topic: record.topic,
        idempotencyKey: record.idempotencyKey,
        payload: record.payload,
      })),
    )
    // A second publish of the same fact is the same job. Not an error: the
    // caller may legitimately re-derive it after a crash.
    .onConflictDoNothing({ target: [outbox.topic, outbox.idempotencyKey] });
}

/**
 * Moves undispatched outbox rows into the job queue.
 *
 * Separate from `publish` because the two have different failure modes. A
 * publish that fails must fail its transaction; a dispatch that fails must be
 * retried without touching the state that produced it. Running the dispatch in
 * its own transaction is what keeps those apart.
 */
export async function dispatch(db: Database, limit = 100): Promise<number> {
  return await db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(outbox)
      .where(isNull(outbox.dispatchedAt))
      .orderBy(outbox.outboxId)
      .limit(limit)
      // Another dispatcher holding these rows should move on rather than block.
      .for('update', { skipLocked: true });

    if (pending.length === 0) return 0;

    await tx
      .insert(workerJobs)
      .values(
        pending.map((row) => ({
          topic: row.topic,
          idempotencyKey: row.idempotencyKey,
          payload: row.payload as Record<string, unknown>,
        })),
      )
      .onConflictDoNothing({ target: [workerJobs.topic, workerJobs.idempotencyKey] });

    await tx
      .update(outbox)
      .set({ dispatchedAt: new Date() })
      .where(
        sql`${outbox.outboxId} in ${sql.raw(`(${pending.map((row) => row.outboxId).join(',')})`)}`,
      );

    return pending.length;
  });
}

export interface ClaimedJob {
  readonly jobId: number;
  readonly topic: string;
  readonly idempotencyKey: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

/**
 * Claims jobs for one worker, with a lease.
 *
 * The lease rather than a lock: a worker that dies mid-job holds nothing, and
 * the job becomes claimable again when `lockedUntil` passes. A held lock would
 * need the connection to survive the work, which across a chain call it may not.
 *
 * `skipLocked` means two workers never wait on each other, and the unique
 * idempotency key means it would not matter if they did.
 */
export async function claim(
  db: Database,
  worker: string,
  options: { limit?: number; leaseSeconds?: number; now?: Date } = {},
): Promise<ClaimedJob[]> {
  const limit = options.limit ?? 10;
  const leaseSeconds = options.leaseSeconds ?? 120;
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000);

  return await db.transaction(async (tx) => {
    const claimable = await tx
      .select()
      .from(workerJobs)
      .where(
        and(
          lte(workerJobs.runAfter, now),
          or(
            eq(workerJobs.status, 'PENDING'),
            // A RUNNING job whose lease expired is a worker that died.
            and(eq(workerJobs.status, 'RUNNING'), lte(workerJobs.lockedUntil, now)),
          ),
        ),
      )
      .orderBy(workerJobs.runAfter, workerJobs.jobId)
      .limit(limit)
      .for('update', { skipLocked: true });

    if (claimable.length === 0) return [];

    const ids = claimable.map((row) => row.jobId);
    await tx
      .update(workerJobs)
      .set({
        status: 'RUNNING',
        lockedBy: worker,
        lockedUntil: leaseUntil,
        attempts: sql`${workerJobs.attempts} + 1`,
      })
      .where(sql`${workerJobs.jobId} in ${sql.raw(`(${ids.join(',')})`)}`);

    return claimable.map((row) => ({
      jobId: row.jobId,
      topic: row.topic,
      idempotencyKey: row.idempotencyKey,
      payload: row.payload as Record<string, unknown>,
      attempts: row.attempts + 1,
    }));
  });
}

export async function succeed(db: Database, jobId: number): Promise<void> {
  await db
    .update(workerJobs)
    .set({ status: 'SUCCEEDED', completedAt: new Date(), lockedBy: null, lockedUntil: null })
    .where(eq(workerJobs.jobId, jobId));
}

/**
 * Exponential backoff with a hard stop.
 *
 * A job that has exhausted its attempts becomes `DEAD` rather than looping
 * forever. Dead is a state an operator has to look at, and a queue that hides
 * its failures behind infinite retry is a queue that reports itself healthy
 * while nothing is happening.
 */
export function backoffSeconds(attempts: number): number {
  const base = Math.min(2 ** attempts, 512);
  // Deterministic jitter from the attempt count, so a thundering herd of
  // simultaneous failures does not retry in lockstep — and so a test can
  // predict the delay.
  const jitter = ((attempts * 2_654_435_761) % 1000) / 1000;
  return Math.round(base * (0.75 + jitter * 0.5));
}

export async function fail(
  db: Database,
  jobId: number,
  error: string,
  options: { now?: Date } = {},
): Promise<'RETRY' | 'DEAD'> {
  const now = options.now ?? new Date();
  const [row] = await db.select().from(workerJobs).where(eq(workerJobs.jobId, jobId)).limit(1);
  if (row === undefined) throw new Error(`no job ${String(jobId)}`);

  if (row.attempts >= row.maxAttempts) {
    await db
      .update(workerJobs)
      .set({
        status: 'DEAD',
        lastError: error.slice(0, 2000),
        lockedBy: null,
        lockedUntil: null,
      })
      .where(eq(workerJobs.jobId, jobId));
    return 'DEAD';
  }

  await db
    .update(workerJobs)
    .set({
      status: 'PENDING',
      lastError: error.slice(0, 2000),
      lockedBy: null,
      lockedUntil: null,
      runAfter: new Date(now.getTime() + backoffSeconds(row.attempts) * 1000),
    })
    .where(eq(workerJobs.jobId, jobId));
  return 'RETRY';
}

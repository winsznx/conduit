import { test } from '@playwright/test';

/**
 * Some specs sign an intent, and the console under test stores it.
 *
 * That console is usually the local one, and the local one shares a database with
 * production, so every run left rows that look like real unsettled intents: 434 of
 * them by the time this guard was written. A spec that writes there has to be asked
 * for, which is what this is. Apart from the opt-in live spec, which settles for real on purpose, the rest of the suite only reads.
 *
 * Run them on purpose, ideally against a console whose DATABASE_URL points at a
 * scratch database:
 *
 *   CONDUIT_ALLOW_DB_WRITES=1 pnpm exec playwright test apps/web/qa/settlement.spec.ts
 *
 * and remove what they left with `pnpm test-data:purge`.
 */
export const DATABASE_WRITES_ALLOWED = process.env['CONDUIT_ALLOW_DB_WRITES'] === '1';

/** Call this first in any test, or helper a test calls, that signs an intent. */
export function skipUnlessDatabaseWritesAllowed(): void {
  test.skip(
    !DATABASE_WRITES_ALLOWED,
    'it signs an intent and the console stores it in its database; set CONDUIT_ALLOW_DB_WRITES=1 to run it',
  );
}

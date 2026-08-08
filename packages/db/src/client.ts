import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { schema } from './schema.js';

/**
 * The one place a connection is opened.
 *
 * Two rules are enforced here rather than left to callers, because both have a
 * failure mode that is silent until production.
 *
 * **The service-role credential never reaches a browser.** Supabase issues two
 * keys and only one of them is safe to ship. This module throws if it is
 * imported into a context that has a `window`, which is not a substitute for
 * bundler configuration but does turn a mistake into a build failure instead of
 * a data breach.
 *
 * **A pooled connection needs `prepare: false`.** Supabase's transaction-mode
 * pooler does not support prepared statements, and the failure is not at
 * startup — it is the first query after the pool reassigns a backend, which in
 * practice means the first burst of real traffic.
 */

export interface DatabaseOptions {
  readonly connectionString: string;
  /** Supabase's pooler on port 6543. Prepared statements are unsupported there. */
  readonly pooled?: boolean;
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(options: DatabaseOptions) {
  if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
    throw new Error(
      'refusing to open a database connection in a browser context: the connection string ' +
        'carries a service-role credential and must never be bundled for the client',
    );
  }
  if (options.connectionString.length === 0) {
    throw new Error('DATABASE_URL is empty');
  }

  const pooled = options.pooled ?? options.connectionString.includes(':6543');

  const sql = postgres(options.connectionString, {
    max: options.maxConnections ?? (pooled ? 1 : 10),
    // Not a preference. The transaction pooler rejects them, and the rejection
    // arrives at the first reassigned backend rather than at connect time.
    prepare: !pooled,
    connection: { application_name: options.applicationName ?? 'conduit' },
    onnotice: () => {},
  });

  return { sql, db: drizzle(sql, { schema }) };
}

/**
 * Reads the connection string without ever printing it.
 *
 * The error names the variable and not its value, because a connection string
 * in a log is a credential in a log.
 */
export function connectionStringFrom(env: Record<string, string | undefined>): string {
  const value = env['DATABASE_URL'] ?? env['SUPABASE_DB_URL'];
  if (value === undefined || value === '') {
    throw new Error('neither DATABASE_URL nor SUPABASE_DB_URL is set');
  }
  return value;
}

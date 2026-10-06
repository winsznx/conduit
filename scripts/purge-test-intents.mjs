#!/usr/bin/env node
/**
 * Removes the intents the browser specs leave in the console's database.
 *
 *   node scripts/purge-test-intents.mjs           # dry run: counts, changes nothing
 *   node scripts/purge-test-intents.mjs --apply   # backs the rows up, then deletes them
 *
 * The specs that sign an intent sign it with a throwaway key that is checked in and holds
 * nothing. An unsettled intent whose four parties are all that key's address is test data, and
 * that is the only thing this removes. The rows are copied to `~/.conduit/backups/` first
 * (or to CONDUIT_BACKUP_DIR), outside the repository because a repository-wide secrets scan
 * flags full rows, and the delete runs in one transaction that rolls back unless it removes
 * exactly the rows it backed up. A settlement's intent is never touched, because the delete skips
 * any intent a settlement references.
 *
 * The connection string comes from DATABASE_URL in the environment or the root `.env`. The
 * script prints the database host and where the string came from, and never the password.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The address of the key the specs sign with (Hardhat's second well-known account).
 * `tests/test-data.test.ts` keeps this equal to the key in the specs.
 */
const SPEC_WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

const apply = process.argv.includes('--apply');
const unknown = process.argv.slice(2).filter((argument) => argument !== '--apply');
if (unknown.length > 0) {
  console.error(
    `unknown argument: ${unknown.join(' ')}\nusage: node scripts/purge-test-intents.mjs [--apply]`,
  );
  process.exit(2);
}

function connectionString() {
  const fromEnvironment = process.env['DATABASE_URL'];
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return { url: fromEnvironment, source: 'the environment' };
  }
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return undefined;
  const line = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/m.exec(
    readFileSync(envFile, 'utf8'),
  );
  const url = line?.[1]?.replace(/^['"]|['"]$/g, '');
  return url === undefined || url === '' ? undefined : { url, source: '.env' };
}

const found = connectionString();
if (found === undefined) {
  console.error('DATABASE_URL is not set in the environment or in .env');
  process.exit(1);
}

// A string that does not parse makes the driver throw an error that carries the whole string,
// password included, and Node prints that property when the error escapes. So it is parsed here,
// the error is dropped, and only a fixed message and the host are ever shown.
let host;
try {
  host = new URL(found.url).hostname;
} catch {
  console.error('DATABASE_URL is not a valid connection string. Nothing was changed.');
  process.exit(1);
}

// `postgres` is a dependency of the db package, not of the repository root.
const postgres = createRequire(join(ROOT, 'packages', 'db', 'package.json'))('postgres');
const sql = postgres(found.url, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 20,
  onnotice: () => undefined,
});

/** An unsettled intent in which the specs' wallet is every party. */
const testIntents = (tx) => tx`
  SELECT * FROM conduit.intents i
   WHERE NOT EXISTS (SELECT 1 FROM conduit.settlements s WHERE s.intent_hash = i.intent_hash)
     AND lower(i.cash_payer) = ${SPEC_WALLET} AND lower(i.asset_seller) = ${SPEC_WALLET}
     AND lower(i.cash_receiver) = ${SPEC_WALLET} AND lower(i.asset_receiver) = ${SPEC_WALLET}
   ORDER BY i.created_at, i.intent_hash`;

const totals = (tx) => tx`
  SELECT (SELECT count(*)::int FROM conduit.intents)     AS intents,
         (SELECT count(*)::int FROM conduit.settlements) AS settlements`;

try {
  const [before, rows] = await sql.begin('read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '30s'`;
    return [(await totals(tx))[0], await testIntents(tx)];
  });

  console.log(`database ${host}, from ${found.source}`);
  console.log(`intents ${before.intents}, settlements ${before.settlements}`);
  console.log(`test intents (unsettled, the specs' wallet is every party): ${rows.length}`);

  const perDay = new Map();
  for (const row of rows) {
    const day = new Date(row.created_at).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  for (const [day, count] of perDay) console.log(`  ${day}  ${String(count).padStart(5)}`);

  if (rows.length === 0) {
    console.log('nothing to remove');
  } else if (!apply) {
    console.log(
      'dry run, nothing changed. Run with --apply to back these up to ~/.conduit/backups/ and delete them.',
    );
  } else {
    const directory = process.env['CONDUIT_BACKUP_DIR'] ?? join(homedir(), '.conduit', 'backups');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const backup = join(
      directory,
      `test-intents-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    // 'wx' so a name collision can never overwrite an earlier backup.
    writeFileSync(
      backup,
      JSON.stringify({ table: 'conduit.intents', count: rows.length, rows }, null, 1),
      { mode: 0o600, flag: 'wx' },
    );
    console.log(`backed up ${rows.length} rows to ${backup}`);

    const hashes = rows.map((row) => row.intent_hash);
    const removed = await sql.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      const deleted = await tx`
        DELETE FROM conduit.intents i
         WHERE i.intent_hash = ANY(${hashes})
           AND NOT EXISTS (SELECT 1 FROM conduit.settlements s WHERE s.intent_hash = i.intent_hash)
           AND lower(i.cash_payer) = ${SPEC_WALLET} AND lower(i.asset_seller) = ${SPEC_WALLET}
           AND lower(i.cash_receiver) = ${SPEC_WALLET} AND lower(i.asset_receiver) = ${SPEC_WALLET}
        RETURNING i.intent_hash`;
      const gone = new Set(deleted.map((row) => row.intent_hash));
      if (gone.size !== hashes.length || !hashes.every((hash) => gone.has(hash))) {
        throw new Error(
          `refusing to commit: removed ${gone.size} rows, backed up ${hashes.length}`,
        );
      }
      return gone.size;
    });

    const after = (await totals(sql))[0];
    console.log(`removed ${removed}. intents ${after.intents}, settlements ${after.settlements}`);
  }
} catch (error) {
  console.error(`purge failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

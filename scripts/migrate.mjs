#!/usr/bin/env node
/**
 * Applies the forward-only migrations. PRD 11.6.
 *
 *   node --env-file=.env scripts/migrate.mjs [--check]
 *
 * There is no down migration and there never will be: CLAUDE.md makes database
 * migrations forward-only in shared environments, and a rollback that drops a
 * table holding indexed chain history destroys evidence rather than state.
 *
 * Each file runs inside a transaction and is recorded in `schema_migrations` by
 * name *and* by content hash. The hash is what makes this safe to re-run: a
 * file edited after it was applied is a different migration wearing an applied
 * name, and this refuses rather than skipping it silently. That refusal has to
 * exist because the failure it prevents is invisible — the migration appears
 * applied, the column it adds is missing, and the first query to need it fails
 * in production.
 *
 * The connection string is read from the environment and never printed. An
 * error names the variable, never its value.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// pnpm keeps `postgres` under the workspace that declares it, so this resolves
// through that package rather than assuming a hoisted root install.
const { default: postgres } = await import(
  new URL('../packages/db/node_modules/postgres/src/index.js', import.meta.url).href
);

import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'migrate.log'));
const checkOnly = process.argv.includes('--check');

const MIGRATIONS_DIR = join(ROOT, 'packages', 'db', 'migrations');

const connectionString = process.env['DATABASE_URL'] ?? process.env['SUPABASE_DB_URL'];
if (connectionString === undefined || connectionString === '') {
  log.fail('HUMAN_GATE_DEPLOY: neither DATABASE_URL nor SUPABASE_DB_URL is set');
  process.exit(1);
}

/** Host and database only. Enough to prove which server was touched, and no credential. */
function describeTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  log.fail(`no migrations in ${MIGRATIONS_DIR}`);
  process.exit(1);
}

log.stage('target');
log.step(describeTarget(connectionString));
log.step(`${String(files.length)} migration file(s)`);

const sql = postgres(connectionString, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  connection: { application_name: 'conduit-migrate' },
});

const applied = [];
const pending = [];

try {
  // The ledger lives in `conduit` alongside everything it tracks, and outside
  // the schema PostgREST serves. Creating it here rather than in a migration
  // avoids the circularity that killed the first attempt at 0002: a migration
  // cannot safely relocate the table that records whether it ran.
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS conduit;
    CREATE TABLE IF NOT EXISTS conduit.schema_migrations (
      name        TEXT PRIMARY KEY,
      sha256      TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE conduit.schema_migrations ENABLE ROW LEVEL SECURITY;
  `);

  // Carry over anything an earlier run recorded in `public`, then remove it.
  // Losing this would re-apply 0001 against tables that already exist.
  await sql.unsafe(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'schema_migrations'
      ) THEN
        INSERT INTO conduit.schema_migrations (name, sha256, applied_at)
        SELECT name, sha256, applied_at FROM public.schema_migrations
        ON CONFLICT (name) DO NOTHING;
        DROP TABLE public.schema_migrations;
      END IF;
    END $$;
  `);

  const rows = await sql`SELECT name, sha256 FROM conduit.schema_migrations`;
  const seen = new Map(rows.map((row) => [row.name, row.sha256]));

  for (const name of files) {
    const body = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    const hash = createHash('sha256').update(body).digest('hex');
    const previous = seen.get(name);

    if (previous === hash) {
      log.step(`${name} — already applied`);
      applied.push({ name, sha256: hash, state: 'already-applied' });
      continue;
    }

    if (previous !== undefined) {
      // The dangerous case, and the reason the hash is stored at all.
      log.fail(
        `${name} was applied with a different content hash. A migration is immutable once ` +
          'it has run in a shared environment: add a new file rather than editing this one.',
      );
      process.exit(1);
    }

    pending.push({ name, body, sha256: hash });
  }

  if (pending.length === 0) {
    log.ok('the database is up to date');
  } else if (checkOnly) {
    for (const migration of pending) log.step(`${migration.name} — pending`);
    log.fail(`${String(pending.length)} migration(s) pending; run without --check to apply`);
    process.exit(1);
  } else {
    for (const migration of pending) {
      log.stage(migration.name);
      // One transaction per file. A migration that fails half-applied is worse
      // than one that fails, because the next run sees a schema that matches
      // neither state.
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.body);
        await tx`
          INSERT INTO conduit.schema_migrations (name, sha256)
          VALUES (${migration.name}, ${migration.sha256})
        `;
      });
      log.ok(`applied ${migration.name}`);
      applied.push({ name: migration.name, sha256: migration.sha256, state: 'applied' });
    }
  }

  // Read the schema back. A migration that "succeeded" without creating its
  // tables is the same class of failure as an edit that silently no-ops, and
  // CLAUDE.md is explicit that an edit is not a fix until the result is read.
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'conduit' ORDER BY table_name
  `;
  const names = tables.map((row) => row.table_name);

  log.stage('read back');
  log.step(`${String(names.length)} tables: ${names.join(', ')}`);

  const required = [
    'deployments',
    'settlements',
    'settlement_legs',
    'intents',
    'messages',
    'vaas',
    'compliance_attestations',
    'disposition_orders',
    'authority_policies',
    'indexed_events',
    'evidence_artifacts',
    'verification_runs',
    'outbox',
    'worker_jobs',
  ];
  const missing = required.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    log.fail(`missing after migration: ${missing.join(', ')}`);
    process.exit(1);
  }
  log.ok('every required table exists');

  // The constraint ADR-0018 turns into a schema property. Asserted against the
  // live catalogue rather than against the file that was supposed to create it.
  // Constraints whose *entire* column list is one address-like column.
  //
  // The first version of this grouped by column as well as by constraint, so
  // every composite key contributed a one-row group and `deployment_contracts`
  // failed for a key on (deployment_id, chain_id, address, role) — which is
  // precisely the correct shape. It reported the opposite of the truth.
  //
  // ADR-0019's rule, applied to a SQL predicate: the check has to ask about the
  // thing the claim is about. The claim is about the constraint's arity, so the
  // count has to be over the constraint.
  const badKeys = await sql`
    SELECT tc.table_name, tc.constraint_name, min(kcu.column_name) AS column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    WHERE tc.table_schema = 'conduit'
      AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    GROUP BY tc.table_name, tc.constraint_name
    HAVING count(*) = 1 AND min(kcu.column_name) IN ('address', 'emitter')
  `;
  if (badKeys.length > 0) {
    log.fail(
      `a unique key on a bare address exists: ${badKeys
        .map((row) => `${row.table_name}.${row.column_name}`)
        .join(', ')}. Identity is (chain_id, address) — see ADR-0018.`,
    );
    process.exit(1);
  }
  log.ok('no unique key on a bare address or emitter (ADR-0018)');

  // The lockdown, verified against the catalogue rather than trusted from the
  // file that claims to apply it. Supabase grants `anon` full privileges on
  // anything created in `public` through an event trigger, so this is not a
  // hypothetical posture — it is the state the database starts in.
  log.stage('exposure');

  // Scoped to the two schemas Conduit owns. `storage` and `realtime` are
  // Supabase's own and are *supposed* to be reachable by `anon` — that is what
  // signed URLs and channel subscriptions are. Failing on them would be the
  // check asking about something other than the claim, which is the mistake
  // ADR-0019 names and the one this file has already made twice tonight.
  const exposed = await sql`
    SELECT grantee, table_schema, count(*)::int AS grants
    FROM information_schema.role_table_grants
    WHERE grantee IN ('anon', 'authenticated')
      AND table_schema IN ('public', 'conduit')
    GROUP BY grantee, table_schema
  `;
  if (exposed.length > 0) {
    log.fail(
      `anon or authenticated still hold privileges: ${exposed
        .map((row) => `${row.grantee} on ${row.table_schema} (${String(row.grants)})`)
        .join(', ')}`,
    );
    process.exit(1);
  }
  log.ok('anon and authenticated hold no table privilege in public or conduit');

  // `conduit` is the claim. `public` is context.
  //
  // Revoking USAGE on `public` from the PUBLIC pseudo-role is possible and was
  // tried; it leaves Supabase's own machinery resolving unqualified names in a
  // schema it can no longer enter, for no benefit — because `public` now holds
  // zero tables. What matters is that it *stays* empty, so that is what is
  // asserted, alongside `conduit` being unreachable at all.
  const usage = await sql`
    SELECT nspname,
           has_schema_privilege('anon', nspname, 'USAGE') AS anon_usage,
           has_schema_privilege('authenticated', nspname, 'USAGE') AS auth_usage
    FROM pg_namespace WHERE nspname IN ('public', 'conduit')
  `;
  const conduitUsage = usage.find((row) => row.nspname === 'conduit');
  if (conduitUsage?.anon_usage === true || conduitUsage?.auth_usage === true) {
    log.fail('anon or authenticated can reach the conduit schema');
    process.exit(1);
  }
  log.ok('neither role has USAGE on conduit');

  const leftInPublic = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `;
  if (leftInPublic.length > 0) {
    log.fail(
      `${String(leftInPublic.length)} table(s) remain in the API-exposed schema: ` +
        `${leftInPublic.map((row) => row.table_name).join(', ')}. Move them to conduit.`,
    );
    process.exit(1);
  }
  log.ok('public holds no tables, so USAGE on it reaches nothing');

  const unprotected = await sql`
    SELECT c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'conduit' AND c.relkind = 'r' AND NOT c.relrowsecurity
    ORDER BY c.relname
  `;
  if (unprotected.length > 0) {
    log.fail(`row-level security is off on: ${unprotected.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  log.ok('row-level security is on for every table, with no policies');
} finally {
  await sql.end({ timeout: 5 });
}

log.ok(`migrations complete against ${describeTarget(connectionString)}`);

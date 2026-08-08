import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The boundaries that keep credentials out of places they must never reach.
 *
 * Each of these was checked by hand once and would have stayed checked by hand
 * — which is the same as unchecked, three commits later. They are here so the
 * build fails instead of a person remembering.
 *
 * The list is shaped by what actually went wrong. The Supabase projection was
 * created with `anon` holding DELETE and TRUNCATE on all nineteen tables,
 * because that is Supabase's default for the `public` schema and defaults are
 * only safe for data designed to be public. Nothing here would have caught that
 * one — a database's grants are not visible from the repository — but the class
 * of mistake is the same: an assumption about what is exposed, never verified.
 */

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
}

describe('credentials never enter version control', () => {
  it('ignores every file that holds live values', () => {
    // `.env.example` is deliberately tracked and deliberately empty. Every other
    // shape of env file carries real values and must be ignored *before* it
    // exists, because the moment one is created is the moment it can be staged.
    const mustBeIgnored = [
      '.env',
      '.env.local',
      '.env.production',
      '.env.deploy',
      '.dev.vars',
      'apps/web/.env.local',
      'apps/api/.dev.vars',
    ];

    const notIgnored = mustBeIgnored.filter((path) => {
      try {
        git('check-ignore', '-q', path);
        return false;
      } catch {
        return true;
      }
    });

    expect(notIgnored, 'these would be committable if created').toEqual([]);
  });

  it('tracks no file whose name promises a secret', () => {
    const tracked = git('ls-files').split('\n').filter(Boolean);
    const suspicious = tracked.filter(
      (path) =>
        /(^|\/)\.env($|\.)(?!example)/.test(path) ||
        /\.(key|pem|p12|pfx)$/.test(path) ||
        /(^|\/)(id_rsa|id_ed25519|credentials)$/.test(path),
    );
    expect(suspicious).toEqual([]);
  });

  it('keeps .env.example free of anything that looks like a live value', () => {
    // A template that ships one real key is worse than no template: it reads as
    // an example and works as a credential.
    const lines = read('.env.example')
      .split('\n')
      .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'));

    const populated = lines
      .map((line) => {
        const [name, ...rest] = line.split('=');
        return { name: name ?? '', value: rest.join('=').trim() };
      })
      .filter((entry) => entry.value.length > 0);

    // Only values that are self-evidently placeholders may be non-empty.
    const suspicious = populated.filter(
      (entry) =>
        !/^(<.*>|\.\.\.|CHANGEME|example|true|false|\d+|https?:\/\/(localhost|example))/i.test(
          entry.value,
        ),
    );
    expect(suspicious.map((entry) => entry.name)).toEqual([]);
  });
});

describe('the database credential cannot reach a browser', () => {
  it('keeps the db package out of every client-side workspace', () => {
    // The service-role connection string is the whole database. A bundler that
    // can resolve `@conduit-protocol/db` from a client entry point can inline
    // it, and no runtime guard fixes a value that is already in the bundle.
    for (const app of ['apps/web', 'packages/ui']) {
      const manifestPath = join(ROOT, app, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      expect(Object.keys(manifest.dependencies ?? {}), `${app} dependencies`).not.toContain(
        '@conduit-protocol/db',
      );
    }
  });

  it('imports no database client from client-side source', () => {
    const offenders: string[] = [];
    for (const app of ['apps/web/src', 'packages/ui/src']) {
      const dir = join(ROOT, app);
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const body = readFileSync(file, 'utf8');
        if (/@conduit-protocol\/db|createDatabase|DATABASE_URL|SERVICE_ROLE/.test(body)) {
          offenders.push(file.slice(ROOT.length + 1));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The runtime backstop, tested so it is known to work rather than assumed.
   * It does not replace the bundler boundary above — by the time this throws,
   * the string is already in the bundle — but it turns a mistake into a crash
   * on the first request instead of a quiet exfiltration.
   */
  it('refuses to open a connection where a window exists', async () => {
    const { createDatabase } = await import('@conduit-protocol/db');
    const globals = globalThis as { window?: unknown };
    const had = 'window' in globals;
    globals.window = {};
    try {
      expect(() => createDatabase({ connectionString: 'postgresql://x' })).toThrow(/browser/i);
    } finally {
      if (!had) delete globals.window;
    }
  });
});

describe('the migration ledger and the lockdown are part of the schema', () => {
  it('ships a migration that takes the projection off the API surface', () => {
    const migrations = readdirSync(join(ROOT, 'packages/db/migrations'));
    const lockdown = migrations.find((name) => name.includes('lock_down'));
    expect(lockdown, 'no lockdown migration').toBeDefined();

    const sql = read(`packages/db/migrations/${String(lockdown)}`);
    // The three locks, each independently sufficient. Asserted by shape rather
    // than by exact text so the migration can be reworded.
    expect(sql).toMatch(/SET SCHEMA conduit/);
    expect(sql).toMatch(/REVOKE ALL[\s\S]*FROM anon, authenticated/);
    expect(sql).toMatch(/ALTER DEFAULT PRIVILEGES[\s\S]*REVOKE ALL/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('creates no table in the API-exposed schema after the lockdown', () => {
    // A later migration that says `CREATE TABLE foo` without a schema puts it
    // back in `public`, where Supabase's event trigger grants `anon` everything.
    const dir = join(ROOT, 'packages/db/migrations');
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    const afterLockdown = files.slice(files.findIndex((name) => name.includes('lock_down')) + 1);

    const offenders: string[] = [];
    for (const name of afterLockdown) {
      const sql = readFileSync(join(dir, name), 'utf8');
      const creates = sql.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g) ?? [];
      // Unqualified means `public` under the default search path.
      if (creates.length > 0) offenders.push(`${name}: ${creates.join(', ')}`);
    }
    expect(offenders, 'qualify these with conduit.').toEqual([]);
  });

  it('grants nothing back to the API roles', () => {
    const dir = join(ROOT, 'packages/db/migrations');
    const offenders: string[] = [];
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.sql'))) {
      const sql = readFileSync(join(dir, name), 'utf8');
      // Comments explaining the absence of a grant are fine; a GRANT is not.
      const statements = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      if (/\bGRANT\b[\s\S]*?\b(anon|authenticated|service_role)\b/.test(statements)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) yield path;
  }
}

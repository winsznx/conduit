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

  it('imports no database client from anything that could reach a browser', () => {
    // `worker.ts` is the Cloudflare entry point — server-side by definition, and
    // reading `DATABASE_URL` from a secret binding is exactly its job. Excluding
    // it by name rather than widening the pattern, so a *new* file that touches
    // the credential still fails. The moment this app grows a client bundle,
    // that bundle's directory goes in the list below and nothing else changes.
    // `data.ts` is the Worker's read layer and is imported by `worker.ts` alone.
    // It is named here for the same reason `worker.ts` is: it legitimately holds
    // the credential, and naming it keeps the check sharp for the next file that
    // does so by accident.
    //
    // `worker.test.ts` is allowed one thing and no more. It builds the Worker's `Env`
    // to drive its routes, and `Env` has a required field for the connection
    // string, so the file has to spell the field's name. Every other pattern still
    // applies to it, and the next test requires that any connection string it holds
    // points at a host that cannot resolve. Nothing imports a test file and no
    // bundle contains one, so it cannot reach a browser.
    //
    // The client bundle this comment used to say did not exist now does, under
    // `apps/web/src/client`. That is exactly the case this check was written
    // for, so it is asserted separately and harder below: server-only files are
    // named one at a time, and *nothing* under `client/` may mention the
    // credential at all.
    const serverOnly = new Set(['apps/web/src/worker.ts', 'apps/web/src/data.ts']);
    const mayNameTheConnectionField = new Set(['apps/web/src/worker.test.ts']);
    const offenders: string[] = [];
    for (const app of ['apps/web/src', 'packages/ui/src']) {
      const dir = join(ROOT, app);
      if (!existsSync(dir)) continue;
      for (const file of walk(dir)) {
        const body = readFileSync(file, 'utf8');
        const relative = file.slice(ROOT.length + 1);
        if (serverOnly.has(relative)) continue;
        const forbidden = mayNameTheConnectionField.has(relative)
          ? /@conduit-protocol\/db|createDatabase|SERVICE_ROLE/
          : /@conduit-protocol\/db|createDatabase|DATABASE_URL|SERVICE_ROLE/;
        if (forbidden.test(body)) {
          offenders.push(relative);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds only an unresolvable placeholder where a test names the connection string', () => {
    // The exemption above lets `worker.test.ts` spell `DATABASE_URL`. This is what stops
    // it holding a real one: the secrets scan does not recognise a bare connection URI.
    const body = readFileSync(join(ROOT, 'apps/web/src/worker.test.ts'), 'utf8');
    const hosts = (body.match(/postgres(?:ql)?:\/\/[^\s'"`]+/g) ?? []).map(
      (literal) => new URL(literal).hostname,
    );

    expect(
      hosts.length > 0 && hosts.every((host) => host.endsWith('.invalid')),
      `connection strings in worker.test.ts must name a .invalid host, found: ${hosts.join(', ')}`,
    ).toBe(true);
  });

  /**
   * The browser bundle is the one place a leaked credential is unrecoverable.
   *
   * A server-side mistake exposes a secret to whoever reads the logs. A mistake
   * here ships it to every visitor, cached, in a file they can save. So this is
   * a blanket refusal rather than an allowlist: no file under `client/` may
   * name the connection string, the service role, or a Cleanverse credential,
   * and there is no exception to add one to.
   */
  it('ships no server credential in the browser bundle', () => {
    const dir = join(ROOT, 'apps/web/src/client');
    if (!existsSync(dir)) return;
    const offenders: string[] = [];
    for (const file of walk(dir)) {
      const body = readFileSync(file, 'utf8');
      if (
        /DATABASE_URL|SUPABASE_DB_URL|SERVICE_ROLE|createDatabase|@conduit-protocol\/db|CLEANVERSE_API_KEY|CLEANVERSE_AES/.test(
          body,
        )
      ) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * `script-src 'self'` is the whole budget.
   *
   * The wallet layer needed script execution, so the policy gained exactly one
   * source and nothing else. This fails if anyone widens it to an external
   * origin, to `unsafe-inline`, or to `unsafe-eval` — each of which would turn
   * a proof page into a page that runs whatever it was handed.
   */
  it('allows scripts only from this origin', () => {
    const worker = readFileSync(join(ROOT, 'apps/web/src/worker.ts'), 'utf8');
    const match = /'content-security-policy':([\s\S]*?),\n\s*'x-content-type-options'/.exec(worker);
    expect(match, 'the Worker must send a content-security-policy').not.toBeNull();

    const value = (match?.[1] ?? '').replace(/['"+\s]+/g, ' ');
    expect(value).toContain('script-src self');
    expect(value).not.toMatch(/script-src[^;]*unsafe-eval/);
    expect(value).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(value).not.toMatch(/script-src[^;]*https?:/);
    expect(value).toContain('frame-ancestors none');
    expect(value).toContain('base-uri none');
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

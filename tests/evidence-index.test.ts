/**
 * The evidence the web surface serves must be the evidence on disk.
 *
 * `apps/web/src/evidence-index.ts` is generated from `docs/evidence` and
 * `contracts/deployments` and committed, so a clean clone typechecks without
 * running a build step first. Committed generated files drift. This is the check
 * that says so, and it is the same shape as the settlement trace corpus gate:
 * regenerate, compare, fail loudly rather than serving a stale transaction hash
 * next to a claim that it is what happened.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('evidence index', () => {
  it('matches the artifacts it was generated from', () => {
    // #given the committed index and the artifacts on disk
    // #when the generator is asked to compare them
    const run = (): string =>
      execFileSync(
        process.execPath,
        [join(ROOT, 'scripts', 'build-evidence-index.mjs'), '--check'],
        {
          cwd: ROOT,
          encoding: 'utf8',
        },
      );

    // #then it agrees, and says how much it checked
    expect(run()).toContain('evidence index matches');
  });

  it('keeps the canonical manifest in step with the artifacts it quotes', () => {
    // #given a manifest generated from docs/evidence and contracts/deployments
    // #when the generator is asked to compare them
    const run = (): string =>
      execFileSync(
        process.execPath,
        [join(ROOT, 'scripts', 'build-evidence-manifest.mjs'), '--check'],
        { cwd: ROOT, encoding: 'utf8' },
      );

    // #then nothing in it has drifted from its source
    expect(run()).toContain('evidence manifest matches');
  });

  it('never claims a publication that does not exist', () => {
    // #given the module that turns the index into pages
    const source = readFileSync(join(ROOT, 'apps', 'web', 'src', 'evidence.ts'), 'utf8');

    // #then it does not describe the artifacts as published to object storage,
    // because they are served from this repository and ASM-039 is still open
    expect(source).toContain('ASM-039');
    expect(source).not.toMatch(/published to (R2|object storage)/i);
  });
});

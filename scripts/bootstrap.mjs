#!/usr/bin/env node
/**
 * The one bootstrap command from the Phase 00 gate:
 *
 *     git clone … && cd conduit && pnpm bootstrap
 *
 * It verifies the machine's toolchain, restores every pinned dependency, then
 * runs the full repository gate. It must stay runnable before `node_modules`
 * exists, so it imports nothing outside `scripts/`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { heading, ROOT, run } from './lib/run.mjs';

function step(title, command, args, options = {}) {
  heading(title);
  const result = run(command, args, { ...options, allowFailure: true });
  if (!result.ok) {
    console.error(`\nbootstrap failed during: ${title}`);
    process.exit(result.status);
  }
}

step('verify toolchain', 'node', ['scripts/verify-toolchain.mjs']);

const lockfileExists = existsSync(join(ROOT, 'pnpm-lock.yaml'));
step(
  lockfileExists ? 'install npm dependencies (frozen lockfile)' : 'resolve npm dependencies',
  'pnpm',
  lockfileExists ? ['install', '--frozen-lockfile'] : ['install'],
);

step('restore Solidity dependencies at locked revisions', 'forge', ['install']);

step('build contracts', 'forge', ['build', '--deny', 'warnings']);

step('run the repository gate', 'node', ['scripts/verify.mjs']);

console.log('\nbootstrap complete — repository gate is green');

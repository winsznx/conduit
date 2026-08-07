import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

/**
 * PRD 15.5 lists Playwright end-to-end runs as a CI gate. Phase 00 has no
 * application to drive, so this file exists to prove the harness itself is
 * installed, pinned, and rooted at the right directory. It deliberately opens
 * no browser: a browser download would be the only thing it proved.
 *
 * The twenty scenarios in PRD 15.4 land here alongside apps/web in phase 06.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')) as Record<string, unknown>;
}

test('the installed Playwright matches the pin in package.json', () => {
  const rootPkg = readJson('package.json');
  const devDependencies = rootPkg['devDependencies'] as Record<string, string>;
  const installed = readJson('node_modules/@playwright/test/package.json');

  expect(installed['version']).toBe(devDependencies['@playwright/test']);
});

test('the harness runs from the repository root', () => {
  expect(readJson('package.json')['name']).toBe('conduit');
});

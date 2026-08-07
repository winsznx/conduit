#!/usr/bin/env node
/**
 * Storage-layout snapshot.
 *
 * PRD 15.1 requires this even though core contracts are non-upgradeable: a
 * layout change between the audited commit and the deployed commit is a signal
 * that storage semantics moved, and the snapshot makes that visible in review
 * instead of in production.
 *
 *   node scripts/storage-layout.mjs           # write the snapshot
 *   node scripts/storage-layout.mjs --check   # fail if the snapshot drifted
 *
 * Only `contracts/src` is snapshotted. Test and script contracts are excluded
 * because their layout carries no protocol meaning.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ROOT } from './lib/run.mjs';

const SNAPSHOT_FILE = join(ROOT, 'contracts', 'storage-layout.json');
const SRC_DIR = join(ROOT, 'contracts', 'src');
const check = process.argv.includes('--check');

/** @param {string} dir @returns {string[]} */
function solidityFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return solidityFiles(full);
    return entry.isFile() && entry.name.endsWith('.sol') ? [full] : [];
  });
}

/** Top-level contract declarations, excluding interfaces, libraries, and abstracts. */
function declaredContracts(source) {
  return [...source.matchAll(/^contract\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]);
}

const layout = {};
for (const file of solidityFiles(SRC_DIR).sort()) {
  const relativePath = relative(ROOT, file);
  for (const contract of declaredContracts(readFileSync(file, 'utf8'))) {
    const raw = execFileSync(
      'forge',
      ['inspect', `${relativePath}:${contract}`, 'storageLayout', '--json'],
      {
        cwd: ROOT,
        encoding: 'utf8',
      },
    );
    layout[`${relativePath}:${contract}`] = JSON.parse(raw);
  }
}

const serialized = `${JSON.stringify(layout, null, 2)}\n`;

if (!check) {
  writeFileSync(SNAPSHOT_FILE, serialized);
  console.log(`storage layout snapshot written: ${Object.keys(layout).length} contracts`);
  process.exit(0);
}

let committed;
try {
  committed = readFileSync(SNAPSHOT_FILE, 'utf8');
} catch {
  console.error(`no storage layout snapshot at ${relative(ROOT, SNAPSHOT_FILE)}`);
  console.error('run: node scripts/storage-layout.mjs');
  process.exit(1);
}

if (committed !== serialized) {
  console.error('storage layout drifted from the committed snapshot.');
  console.error('review the change, then run: node scripts/storage-layout.mjs');
  process.exit(1);
}

console.log(
  Object.keys(layout).length === 0
    ? 'storage layout: 0 contracts in contracts/src (expected until phase 03)'
    : `storage layout: ${Object.keys(layout).length} contracts unchanged`,
);

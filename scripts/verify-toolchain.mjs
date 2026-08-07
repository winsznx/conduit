#!/usr/bin/env node
/**
 * Environment gate.
 *
 * Asserts that the toolchain actually installed on this machine matches
 * toolchain.json. It runs before `pnpm install`, so it may not import anything
 * from node_modules.
 *
 * Repository *files* are checked separately by tests/toolchain.test.ts. Keeping
 * the two concerns apart means a version drift reports as either "your machine
 * is wrong" or "the repository is inconsistent", never an ambiguous mix.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(ROOT, 'toolchain.json'), 'utf8'));

/** @type {{name:string, expected:string, actual:string|null, hint:string}[]} */
const results = [];

function record(name, expected, actual, hint) {
  results.push({ name, expected, actual, hint });
}

function capture(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

record(
  'node',
  manifest.runtime.node,
  process.versions.node,
  `install Node ${manifest.runtime.node} (\`fnm use\` / \`nvm use\` reads .node-version)`,
);

const pnpmVersion = capture('pnpm', ['--version']);
record(
  'pnpm',
  manifest.runtime.pnpm,
  pnpmVersion === null ? null : pnpmVersion.trim(),
  `run \`corepack enable && corepack prepare pnpm@${manifest.runtime.pnpm} --activate\``,
);

const forgeVersion = capture('forge', ['--version']);
const forgeSemver =
  forgeVersion === null
    ? null
    : (/Version:\s*([0-9]+\.[0-9]+\.[0-9]+)/.exec(forgeVersion)?.[1] ?? null);
record(
  'foundry (forge)',
  manifest.foundry.version,
  forgeSemver,
  `run \`foundryup --install ${manifest.foundry.version}\``,
);

const failures = results.filter((r) => r.actual !== r.expected);

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  const ok = r.actual === r.expected;
  const actual = r.actual ?? 'not found';
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(width)}  expected ${r.expected}  actual ${actual}`,
  );
}

if (failures.length > 0) {
  console.error('\ntoolchain does not match toolchain.json:');
  for (const f of failures) {
    console.error(`  - ${f.name}: ${f.hint}`);
  }
  process.exit(1);
}

console.log(`\ntoolchain matches toolchain.json (${results.length} checks)`);

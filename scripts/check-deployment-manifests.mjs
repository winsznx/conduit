#!/usr/bin/env node
/**
 * Validates every committed deployment manifest against the PRD 17.3 schema.
 *
 * PRD FR-014 lets the public verifier bootstrap from a manifest alone, and
 * CLAUDE.md forbids taking contract addresses from anywhere else. A manifest
 * that drifts from the schema, or that disagrees with the pinned compiler,
 * would silently corrupt that path — so the check is a gate, not a lint.
 *
 * Phase 00 ships zero deployments. The check reporting "0 manifests" is the
 * correct result, and it starts failing the moment phase 01 writes a bad one.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { ROOT, toolchain } from './lib/run.mjs';

const DEPLOYMENTS_DIR = join(ROOT, 'contracts', 'deployments');
const SCHEMA_FILE = 'deployment-manifest.schema.json';

const schema = JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, SCHEMA_FILE), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);

const pinnedSolc = toolchain().solidity.solc;

const manifests = readdirSync(DEPLOYMENTS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== SCHEMA_FILE)
  .map((entry) => entry.name)
  .sort();

/** @type {string[]} */
const problems = [];

for (const name of manifests) {
  const manifest = JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, name), 'utf8'));

  if (!validate(manifest)) {
    for (const error of validate.errors ?? []) {
      problems.push(`${name}: ${error.instancePath || '/'} ${error.message ?? 'invalid'}`);
    }
    continue;
  }

  if (manifest.solcVersion !== pinnedSolc) {
    problems.push(
      `${name}: solcVersion ${manifest.solcVersion} does not match the pinned compiler ${pinnedSolc}`,
    );
  }

  const contractNames = Object.keys(manifest.contracts);
  const hashedNames = Object.keys(manifest.bytecodeHashes);
  const unhashed = contractNames.filter((c) => !hashedNames.includes(c));
  if (unhashed.length > 0) {
    problems.push(`${name}: contracts without a bytecode hash: ${unhashed.join(', ')}`);
  }

  const chains = Object.keys(manifest.chainConfigs);
  const unknownChains = Object.entries(manifest.contracts)
    .filter(([, entry]) => !chains.includes(entry.chain))
    .map(([contract]) => contract);
  if (unknownChains.length > 0) {
    problems.push(
      `${name}: contracts deployed to a chain absent from chainConfigs: ${unknownChains.join(', ')}`,
    );
  }
}

if (problems.length > 0) {
  console.error(`deployment manifest check failed (${problems.length} problems):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log(
  manifests.length === 0
    ? 'deployment manifests: 0 committed (expected until phase 01 deploys)'
    : `deployment manifests: ${manifests.length} valid (${manifests.join(', ')})`,
);

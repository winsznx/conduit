#!/usr/bin/env node
/**
 * Proves that every canonical contract is publicly inspectable, and keeps
 * proving it.
 *
 *   node scripts/check-onchain-verification.mjs           # refresh the evidence
 *   node scripts/check-onchain-verification.mjs --check   # fail if it regressed
 *
 * ## Why this is a gate step and not a README sentence
 *
 * "The contracts are verified" is the easiest claim in a submission to make and
 * the easiest to stop being true. Source verification lives on someone else's
 * server; a redeployment, a moved address or a purged index turns a true
 * sentence into a false one with no local change to notice. So it is checked,
 * from the public endpoint, and recorded with a timestamp.
 *
 * Three things are asserted per contract, and they are different claims:
 *
 *   1. the address has code — a manifest can name an address that was never
 *      deployed, and an empty address is the loudest possible failure;
 *   2. the on-chain runtime code hash matches the deployment manifest — this is
 *      local and needs no third party, and it is what says the bytes running
 *      today are the bytes the manifest was written for;
 *   3. Sourcify reports a match for that exact (chain, address) — this is what
 *      lets a stranger read the source without trusting us at all.
 *
 * A Sourcify outage is reported as `UNKNOWN`, never as a pass. If the endpoint
 * cannot be reached the run says so and `--check` fails, because "we could not
 * ask" and "the answer was yes" are different answers and only one of them is
 * evidence.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, http, keccak256 } from 'viem';

import { ROOT } from './lib/run.mjs';

const SOURCIFY = 'https://sourcify.dev/server';
const OUT = join(ROOT, 'docs', 'evidence', 'onchain-verification.json');

/** The canonical generation. Superseded generations are history, not claims. */
const CANONICAL = '0xdcb9db121ca873817fca7ee6a8e2cd8ef0249b7c83f4e656553338da00eccaa6';

const CHAINS = {
  monadTestnet: {
    chainId: 10_143,
    rpc: 'https://testnet-rpc.monad.xyz',
    explorer: 'https://testnet.monadexplorer.com',
  },
  baseSepolia: {
    chainId: 84_532,
    rpc: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
  },
};

/**
 * Which Solidity source each deployed contract came from.
 *
 * `ConduitSandboxSettlementCVA` is the manifest's name for a second deployment
 * of `ConduitRWACVA` with different constructor arguments — the two share a
 * bytecode hash, which is how the manifest already records it. Naming the file
 * here rather than deriving it from the manifest key keeps that fact explicit
 * instead of leaving a reader to notice the hashes coincide.
 */
const SOURCE = {
  SettlementCoordinator: 'contracts/src/SettlementCoordinator.sol',
  CashEscrow: 'contracts/src/CashEscrow.sol',
  ConduitSandboxSettlementCVA: 'contracts/src/ConduitRWACVA.sol',
  ConduitVaultRegistrar: 'contracts/src/ConduitVaultRegistrar.sol',
  ConduitRWACVA: 'contracts/src/ConduitRWACVA.sol',
  RWACVASettlementAdapter: 'contracts/src/RWACVASettlementAdapter.sol',
  AuthorityRegistry: 'contracts/src/AuthorityRegistry.sol',
  DispositionController: 'contracts/src/DispositionController.sol',
};

/**
 * Contracts wired after the generation was cut, so they are not in its manifest.
 *
 * The disposition kernel was deployed and wired separately; its addresses come
 * from `phase-07-kernel-wiring.json`, which is the artifact that recorded the
 * wiring transactions. Listed explicitly so nobody has to guess why the manifest
 * has eight entries and the canonical deployment has ten.
 */
const KERNEL = [
  { chain: 'monadTestnet', role: 'AuthorityRegistry', address: '0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7' },
  { chain: 'monadTestnet', role: 'DispositionController', address: '0x3c4060D402675A25CAd836247CFA0B95614efe81' },
  { chain: 'baseSepolia', role: 'AuthorityRegistry', address: '0x33BB1eBa633d527f664bEFEd0FD6F13E0bE70E45' },
  { chain: 'baseSepolia', role: 'DispositionController', address: '0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7' },
];

function manifests() {
  const dir = join(ROOT, 'contracts', 'deployments');
  const out = [];
  for (const chain of Object.keys(CHAINS)) {
    const file = `${chain === 'monadTestnet' ? 'monad-testnet' : 'base-sepolia'}-0xdcb9db12.json`;
    const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (manifest.deploymentId !== CANONICAL) {
      throw new Error(`${file} is not the canonical deployment`);
    }
    for (const [role, entry] of Object.entries(manifest.contracts ?? {})) {
      out.push({
        chain,
        role,
        address: entry.address,
        expectedCodeHash: manifest.bytecodeHashes?.[role] ?? null,
        manifest: `contracts/deployments/${file}`,
        solcVersion: manifest.solcVersion,
        gitCommit: manifest.gitCommit,
      });
    }
  }
  for (const entry of KERNEL) {
    out.push({
      ...entry,
      expectedCodeHash: null,
      manifest: 'docs/evidence/phase-07-kernel-wiring.json',
      solcVersion: '0.8.36',
      gitCommit: null,
    });
  }
  return out;
}

async function sourcifyStatus(chainId, address) {
  try {
    const response = await fetch(`${SOURCIFY}/v2/contract/${String(chainId)}/${address}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { status: 'UNKNOWN', detail: `HTTP ${String(response.status)}` };
    const body = await response.json();
    if (body.match === null || body.match === undefined) {
      return { status: 'UNVERIFIED', detail: 'Sourcify holds no source for this address' };
    }
    return {
      status: 'VERIFIED',
      match: body.match,
      creationMatch: body.creationMatch,
      runtimeMatch: body.runtimeMatch,
      verifiedAt: body.verifiedAt ?? null,
    };
  } catch (error) {
    return { status: 'UNKNOWN', detail: `Sourcify could not be reached: ${String(error)}` };
  }
}

const clients = Object.fromEntries(
  Object.entries(CHAINS).map(([name, chain]) => [name, createPublicClient({ transport: http(chain.rpc) })]),
);

const results = [];
for (const entry of manifests()) {
  const chain = CHAINS[entry.chain];
  const code = await clients[entry.chain]
    .getCode({ address: entry.address })
    .catch(() => undefined);

  const hasCode = typeof code === 'string' && code !== '0x';
  const codeHash = hasCode ? keccak256(code) : null;
  const sourcify = await sourcifyStatus(chain.chainId, entry.address);

  results.push({
    ...entry,
    chainId: chain.chainId,
    hasCode,
    onChainCodeHash: codeHash,
    codeHashMatchesManifest:
      entry.expectedCodeHash === null ? null : codeHash === entry.expectedCodeHash,
    sourcify,
    sourcePath: SOURCE[entry.role] ?? null,
    explorer: `${chain.explorer}/address/${entry.address}`,
    sourcifyUrl: `https://repo.sourcify.dev/${String(chain.chainId)}/${entry.address}`,
  });
}

/** One of exactly three answers per address. No fourth, softer option exists. */
function classify(entry) {
  if (!entry.hasCode) return 'UNVERIFIED — FIX REQUIRED';
  if (entry.sourcify.status === 'VERIFIED') return 'VERIFIED SOURCE';
  if (entry.sourcify.status === 'UNKNOWN') return 'UNKNOWN — EXPLORER COULD NOT BE CHECKED';
  return 'UNVERIFIED — FIX REQUIRED';
}

const evidence = {
  capturedAt: new Date().toISOString(),
  deploymentId: CANONICAL,
  verifier: 'Sourcify, https://sourcify.dev',
  note:
    'Every row is read from a public endpoint at capture time. A Sourcify outage is recorded ' +
    'as UNKNOWN and fails the gate; it is never recorded as a pass, because "we could not ask" ' +
    'and "the answer was yes" are different answers and only one of them is evidence.',
  contracts: results.map((entry) => ({
    chain: entry.chain,
    chainId: entry.chainId,
    role: entry.role,
    address: entry.address,
    source: entry.sourcePath,
    solcVersion: entry.solcVersion,
    hasCode: entry.hasCode,
    onChainCodeHash: entry.onChainCodeHash,
    manifestCodeHash: entry.expectedCodeHash,
    codeHashMatchesManifest: entry.codeHashMatchesManifest,
    verification: classify(entry),
    sourcify: entry.sourcify,
    explorer: entry.explorer,
    sourcifyUrl: entry.sourcifyUrl,
    recordedIn: entry.manifest,
  })),
};

const bad = evidence.contracts.filter((entry) => entry.verification !== 'VERIFIED SOURCE');
const mismatched = evidence.contracts.filter((entry) => entry.codeHashMatchesManifest === false);

if (process.argv.includes('--check')) {
  for (const entry of evidence.contracts) {
    console.log(
      `${String(entry.chainId).padEnd(6)} ${entry.role.padEnd(28)} ${entry.verification}`,
    );
  }
  if (mismatched.length > 0) {
    console.error(
      `\n${String(mismatched.length)} contract(s) run code the manifest does not describe.`,
    );
    process.exit(1);
  }
  if (bad.length > 0) {
    console.error(`\n${String(bad.length)} canonical contract(s) are not publicly verified.`);
    for (const entry of bad) console.error(`  ${entry.address} — ${entry.verification}`);
    process.exit(1);
  }
  console.log(`\nall ${String(evidence.contracts.length)} canonical contracts: VERIFIED SOURCE`);
} else {
  writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
  for (const entry of evidence.contracts) {
    console.log(
      `${String(entry.chainId).padEnd(6)} ${entry.role.padEnd(28)} ${entry.verification}`,
    );
  }
}

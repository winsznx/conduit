#!/usr/bin/env node
/**
 * Re-extracts the pinned Wormhole registry snapshot. CLAUDE.md: "Use core
 * contract addresses from pinned official registry snapshot."
 *
 * The snapshot exists so a moved upstream value cannot silently redirect the
 * settlement path. That guarantee only holds if the file is *extracted* from
 * the pinned SDK rather than hand-edited, which is why this script exists and
 * why the snapshot carries its own provenance.
 *
 *   pnpm --filter @conduit-protocol/wormhole registry:extract
 *   pnpm --filter @conduit-protocol/wormhole registry:check
 *
 * The chain list is deliberately explicit. Extracting every chain the SDK knows
 * would make the snapshot churn on every upstream release and bury the two
 * networks that actually carry value.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as base from '@wormhole-foundation/sdk-base';

// This lives inside packages/wormhole rather than in scripts/ so the SDK
// resolves: pnpm keeps it in this package's node_modules, and an extractor that
// cannot import its own source is not an extractor.
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The SDK is ESM-only and does not export its package.json, so the version is
// read from the manifest that pins it. A snapshot claiming a source it cannot
// substantiate is worse than no snapshot.
const sdkVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
  .devDependencies['@wormhole-foundation/sdk-base'];

const NETWORK = 'Testnet';

/** key → the SDK's own chain name. Both legs of the DvP, nothing else. */
const CHAINS = {
  monadTestnet: 'MonadTestnet',
  baseSepolia: 'BaseSepolia',
};

const chains = {};
for (const [key, wormholeName] of Object.entries(CHAINS)) {
  const coreBridgeAddress = base.contracts.coreBridge.get(NETWORK, wormholeName);
  if (coreBridgeAddress === undefined) {
    console.error(
      `${wormholeName} has no core bridge in ${NETWORK}; refusing to write a partial snapshot`,
    );
    process.exit(1);
  }

  // These accessors take the chain alone, not (network, chain). Getting that
  // wrong returns undefined rather than throwing, which silently wrote zeros
  // into the snapshot and would have made every finality calculation trivial.
  const finality = base.finality.finalityThreshold.get(wormholeName);
  const blockTime = base.finality.blockTime.get(wormholeName);
  const nativeChainId = base.nativeChainIds.networkChainToNativeChainId.get(NETWORK, wormholeName);

  if (finality === undefined || blockTime === undefined || nativeChainId === undefined) {
    console.error(
      `${wormholeName}: incomplete registry data; refusing to write a partial snapshot`,
    );
    process.exit(1);
  }

  chains[key] = {
    wormholeName,
    wormholeChainId: base.chainToChainId(wormholeName),
    nativeChainId: Number(nativeChainId),
    coreBridgeAddress,
    finalityThresholdBlocks: finality,
    blockTimeMilliseconds: blockTime,
  };
}

const snapshot = {
  $comment:
    "Pinned snapshot of the official Wormhole registry. CLAUDE.md: 'Use core contract addresses from pinned official registry snapshot.' Regenerate with scripts/extract-wormhole-registry.mjs; never hand-edit a value.",
  provenance: {
    source: '@wormhole-foundation/sdk-base',
    version: sdkVersion,
    files: [
      'dist/esm/constants/contracts/core.js',
      'dist/esm/constants/chains.js',
      'dist/esm/constants/nativeChainIds.js',
      'dist/esm/constants/finality.js',
    ],
    network: NETWORK,
    retrievedAt: '2026-08-07',
  },
  chains,
};

const path = join(PACKAGE_ROOT, 'src', 'registry.snapshot.json');
const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== serialized) {
    console.error('the committed Wormhole snapshot does not match the pinned SDK');
    console.error('regenerate it: pnpm --filter @conduit-protocol/wormhole registry:extract');
    process.exit(1);
  }
  console.log(`Wormhole snapshot matches ${sdkVersion} (${Object.keys(chains).length} chains)`);
  process.exit(0);
}

writeFileSync(path, serialized);

for (const [key, chain] of Object.entries(chains)) {
  console.log(
    `${key.padEnd(14)} wormhole ${String(chain.wormholeChainId).padEnd(6)} native ${String(chain.nativeChainId).padEnd(9)} core ${chain.coreBridgeAddress}`,
  );
}
console.log(`\nwritten ${path} from ${sdkVersion}`);

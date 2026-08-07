#!/usr/bin/env node
/**
 * Emits a PRD 17.3 deployment manifest from live chain state.
 *
 * Every value is read back from the chain rather than copied from the broadcast
 * log, because PRD FR-014 lets the public verifier bootstrap from this file and
 * a manifest that merely echoes what the deployer intended proves nothing.
 *
 *   node --env-file=.env scripts/emit-deployment-manifest.mjs <network>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { keccak256 } from 'viem';

import { ROOT, toolchain } from './lib/run.mjs';

const network = process.argv[2] ?? 'base-sepolia';
const CONFIG = {
  'base-sepolia': {
    chainKey: 'baseSepolia',
    rpcEnv: 'BASE_SEPOLIA_RPC_URL',
    nativeChainId: 84532,
    wormholeChainId: 10004,
    coreEnv: 'WORMHOLE_CORE_BASE_SEPOLIA',
    contracts: {
      ConduitRWACVA: '0x244198CFA8660BE9B47961E3C061DFA90622d2B0',
      RWACVASettlementAdapter: '0x5479a4ff288E1cC77B5E352BfD822a9ce269E93f',
    },
  },
};

const cfg = CONFIG[network];
if (cfg === undefined) {
  console.error(`unknown network ${network}`);
  process.exit(1);
}

const rpcUrl = process.env[cfg.rpcEnv];
const rpc = async (method, params) => {
  const r = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await r.json();
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};

const reported = Number.parseInt(await rpc('eth_chainId', []), 16);
if (reported !== cfg.nativeChainId) {
  console.error(`RPC reports chain ${reported}, expected ${cfg.nativeChainId}`);
  process.exit(1);
}

const contracts = {};
const bytecodeHashes = {};
for (const [name, address] of Object.entries(cfg.contracts)) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  if (code.length <= 2) {
    console.error(`${name} at ${address} has no bytecode on ${network}`);
    process.exit(1);
  }
  contracts[name] = { chain: cfg.chainKey, address };
  bytecodeHashes[name] = keccak256(code);
}

const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: ROOT,
  encoding: 'utf8',
}).trim();
const snapshotPath = join(ROOT, 'docs', 'evidence', 'phase-01-monad-cash-token.json');
const cleanverseAssetSnapshotHash = JSON.parse(readFileSync(snapshotPath, 'utf8')).discovery
  .rawResponseHash;

const manifest = {
  deploymentId: process.env.CONDUIT_DEPLOYMENT_ID,
  protocolVersion: 1,
  gitCommit,
  solcVersion: toolchain().solidity.solc,
  chainConfigs: {
    [cfg.chainKey]: {
      nativeChainId: cfg.nativeChainId,
      wormholeChainId: cfg.wormholeChainId,
      rpcUrlEnvVar: cfg.rpcEnv,
      finalityBlocks: 512,
    },
  },
  contracts,
  bytecodeHashes,
  wormhole: {
    [cfg.chainKey]: {
      coreAddress: process.env[cfg.coreEnv],
      wormholeChainId: cfg.wormholeChainId,
      consistencyLevel: 1,
    },
  },
  cleanverseAssetSnapshotHash,
  // Empty until RuleV2 is configured. PRD 9.6 stores the normalized response
  // Cleanverse returns, never a local interpretation of it.
  validatorRuleHashes: {},
  timestamp: new Date().toISOString(),
};

const path = join(
  ROOT,
  'contracts',
  'deployments',
  `${network}-${manifest.deploymentId.slice(0, 10)}.json`,
);
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

for (const [name, address] of Object.entries(cfg.contracts)) {
  console.log(`${name.padEnd(24)} ${address}  codeHash ${bytecodeHashes[name]}`);
}
console.log(`\nwritten ${path}`);

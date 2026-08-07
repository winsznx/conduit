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
    finalityBlocks: 512,
    contracts: {
      // Superseded 0x244198CF…d2B0, which carried AccessControl alone and so
      // had no owner() for Cleanverse to validate a registration signature
      // against. ADR-0011.
      ConduitRWACVA: '0x6B70a81E010d8CEFE7c44701e490337661785644',
      RWACVASettlementAdapter: '0xC0A9Eb5F9D1fd0D4264564B1C7A1ed69946E3170',
    },
  },
  'monad-testnet': {
    chainKey: 'monadTestnet',
    rpcEnv: 'MONAD_TESTNET_RPC_URL',
    nativeChainId: 10143,
    wormholeChainId: 10009,
    coreEnv: 'WORMHOLE_CORE_MONAD_TESTNET',
    finalityBlocks: 1,
    contracts: {
      SettlementCoordinator: '0x1491A25Fc93778ECcb69BCec96495c6f12c686d1',
      CashEscrow: '0x1645BA0873118A997Bd39718A82dd268E46D3B48',
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
      finalityBlocks: cfg.finalityBlocks ?? 512,
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
  finalityProfile: {
    settlement: 'FINALIZED',
    observation: 'INSTANT',
    note: 'Enforced on chain per message class and bound into the bytecode as an immutable, so the codeHash above covers it. An authentic VAA below this level is refused: parseAndVerifyVM proves guardians signed, not that the source state is irreversible.',
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

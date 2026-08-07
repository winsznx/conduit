#!/usr/bin/env node
/**
 * Cash-token evidence capture. PRD 2.4, PRD 17.3.
 *
 * `eth_getCode` returning non-empty is not enough to select a settlement asset.
 * This binds the token to a chain and to its own bytecode, and records the
 * supporting contracts and the API response the address came from, so a verifier
 * can repeat every step.
 *
 * The manifest binds chainId + address + codeHash, never address alone: aUSDC is
 * deployed at the same address on Monad and on Base, so an address by itself
 * does not identify an asset.
 *
 *   node --env-file=.env scripts/capture-cash-token-evidence.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CHAINS } from '@conduit-protocol/config';
import { hashRawBody, redact } from '@conduit-protocol/cleanverse';
import { keccak256 } from 'viem';

import { ROOT } from './lib/run.mjs';

const chain = CHAINS.monadTestnet;
const rpcUrl = process.env[chain.rpcUrlEnvVar];
const base = process.env['CLEANVERSE_BASE_URL'];
const apiId = process.env['CLEANVERSE_API_ID'];

if (rpcUrl === undefined || base === undefined || apiId === undefined) {
  console.error(`set ${chain.rpcUrlEnvVar}, CLEANVERSE_BASE_URL, and CLEANVERSE_API_ID`);
  process.exit(1);
}

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** ERC-20 metadata via raw eth_call, so no ABI decoding library is required. */
const SELECTOR = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
};

function decodeString(hex) {
  if (hex === '0x' || hex.length < 130) return undefined;
  const length = Number.parseInt(hex.slice(66, 130), 16);
  const bytes = hex.slice(130, 130 + length * 2);
  return Buffer.from(bytes, 'hex').toString('utf8');
}

async function erc20(address) {
  const read = async (selector) => {
    try {
      return await rpc('eth_call', [{ to: address, data: selector }, 'latest']);
    } catch {
      return '0x';
    }
  };

  const [name, symbol, decimals, totalSupply] = await Promise.all([
    read(SELECTOR.name),
    read(SELECTOR.symbol),
    read(SELECTOR.decimals),
    read(SELECTOR.totalSupply),
  ]);

  return {
    name: decodeString(name),
    symbol: decodeString(symbol),
    decimals: decimals === '0x' ? undefined : Number.parseInt(decimals, 16),
    totalSupply: totalSupply === '0x' ? undefined : BigInt(totalSupply).toString(),
  };
}

/** EIP-1967 implementation slot: keccak256('eip1967.proxy.implementation') - 1. */
const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/**
 * A proxy's codeHash identifies the proxy, not the logic behind it.
 *
 * Observed here: the A-Token, AccessCore, and A-Pass contracts all report the
 * identical codeHash, because all three are proxies sharing one runtime
 * bytecode. Recording only that hash would assert three different contracts are
 * the same thing. The implementation address behind each is what differs.
 */
async function contractEvidence(label, address) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  const deployed = code.length > 2;

  let implementation = null;
  if (deployed) {
    const slot = await rpc('eth_getStorageAt', [address, EIP1967_IMPLEMENTATION_SLOT, 'latest']);
    const candidate = `0x${slot.slice(-40)}`;
    if (/^0x0{40}$/.test(candidate) === false) implementation = candidate;
  }

  let implementationCodeHash = null;
  if (implementation !== null) {
    const implCode = await rpc('eth_getCode', [implementation, 'latest']);
    if (implCode.length > 2) implementationCodeHash = keccak256(implCode);
  }

  return {
    label,
    address,
    deployed,
    codeBytes: (code.length - 2) / 2,
    // Binding identity to code, not just to an address.
    codeHash: deployed ? keccak256(code) : null,
    proxy: implementation !== null,
    implementation,
    implementationCodeHash,
  };
}

// 1. Discovery. The address must originate from the API, never a literal.
const discoveryBody = JSON.stringify({ chain: chain.cleanverseChain });
const discoveryResponse = await fetch(`${base}/query_deposit_atoken_list`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'api-id': apiId,
    'X-Request-ID': crypto.randomUUID(),
  },
  body: discoveryBody,
  signal: AbortSignal.timeout(25_000),
});
const rawDiscovery = await discoveryResponse.text();
const discoveryHash = await hashRawBody(rawDiscovery);
const discovery = JSON.parse(rawDiscovery);

const entry = discovery.data?.tokens?.[0];
if (entry === undefined) {
  console.error(`no A-Token catalogued for ${chain.cleanverseChain}`);
  process.exit(1);
}

// 2. Chain identity, verified rather than assumed.
const reportedChainId = Number.parseInt(await rpc('eth_chainId', []), 16);
if (reportedChainId !== chain.nativeChainId) {
  console.error(`RPC reports chain ${reportedChainId}, expected ${chain.nativeChainId}`);
  process.exit(1);
}

// 3. Token, access core, and A-Pass contracts.
const [token, accessCore, aPass] = await Promise.all([
  contractEvidence('atoken', entry.atoken.address),
  contractEvidence('accesscore', entry.accesscore_address),
  contractEvidence('apass', entry.apass_address),
]);

const onChain = await erc20(entry.atoken.address);

// 4. Cross-check the catalogue against the contract itself.
const problems = [];
if (!token.deployed) problems.push('no bytecode at the A-Token address');
if (onChain.decimals !== undefined && onChain.decimals !== entry.atoken.decimals) {
  problems.push(
    `decimals disagree: catalogue ${entry.atoken.decimals}, contract ${onChain.decimals}`,
  );
}
if (
  onChain.symbol !== undefined &&
  onChain.symbol.toLowerCase() !== entry.atoken.symbol.toLowerCase()
) {
  problems.push(`symbol disagrees: catalogue ${entry.atoken.symbol}, contract ${onChain.symbol}`);
}
for (const contract of [accessCore, aPass]) {
  if (!contract.deployed) problems.push(`no bytecode at the ${contract.label} address`);
}

const evidence = {
  capturedAt: new Date().toISOString(),
  chain: {
    key: chain.key,
    cleanverseChain: chain.cleanverseChain,
    nativeChainId: chain.nativeChainId,
    reportedChainId,
  },
  discovery: {
    endpoint: '/query_deposit_atoken_list',
    request: { chain: chain.cleanverseChain },
    catalogueSize: discovery.data.tokens.length,
    rawResponseHash: discoveryHash,
    redactedResponse: redact(discovery),
  },
  catalogue: {
    aToken: entry.atoken,
    originToken: entry.origin_token,
    accessCoreAddress: entry.accesscore_address,
    aPassAddress: entry.apass_address,
  },
  onChain: { erc20: onChain, contracts: [token, accessCore, aPass] },
  crossCheck: { ok: problems.length === 0, problems },
};

const path = join(ROOT, 'docs', 'evidence', 'phase-01-monad-cash-token.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);

console.log(`chain              ${chain.key} (${reportedChainId})`);
console.log(`catalogue          ${discovery.data.tokens.length} entry(s), hash ${discoveryHash}`);
console.log(`a-token            ${entry.atoken.address}`);
console.log(`  catalogue        ${entry.atoken.symbol} / ${entry.atoken.decimals} decimals`);
console.log(
  `  on-chain         ${onChain.symbol ?? '?'} / ${onChain.decimals ?? '?'} decimals / supply ${onChain.totalSupply ?? '?'}`,
);
console.log(`  codeHash         ${token.codeHash ?? 'none'}`);
console.log(
  `  implementation   ${token.implementation ?? 'not a proxy'} codeHash ${token.implementationCodeHash ?? '-'}`,
);
for (const contract of [accessCore, aPass]) {
  console.log(`${contract.label.padEnd(18)} ${contract.address}`);
  console.log(
    `  implementation   ${contract.implementation ?? 'not a proxy'} codeHash ${contract.implementationCodeHash ?? '-'}`,
  );
}
console.log(`cross-check        ${problems.length === 0 ? 'ok' : problems.join('; ')}`);
console.log(`\nwritten            ${path}`);

process.exitCode = problems.length === 0 ? 0 : 1;

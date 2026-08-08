#!/usr/bin/env node
/**
 * Mints the sandbox supply a generation's live runs need, and no more.
 *
 *   node --env-file=.env scripts/mint-generation-supply.mjs
 *
 * Both tokens are new in generation 3, so both start at zero supply and neither
 * can settle anything. The amounts are the settlement sizes multiplied by the
 * number of runs planned, with headroom for one retry — deliberately small,
 * because a sandbox balance is not a demonstration of anything and an oversized
 * mint invites a report to imply liquidity that does not exist.
 *
 * The mint passes `policy.canTransfer` like every other movement, so a token
 * whose Cleanverse registration has not reached ISSUED fails here rather than
 * at the first settlement. That ordering is the point: a failed mint costs a
 * transaction, and a failed settlement costs a finality wait.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { formatUnits, parseAbi } from 'viem';

import { assertChainIdentity, submit } from './lib/chain.mjs';
import { loadDvpConfig } from './lib/dvp.mjs';
import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'mint-generation-supply.log'));

const config = loadDvpConfig();
const { monad, base, addresses, deployer } = config;

const TOKEN_ABI = parseAbi([
  'function MINTER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function grantRole(bytes32 role, address account)',
  'function mint(address to, uint256 amount)',
  'function balanceOf(address account) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** Four settlements' worth on each side: happy path, held run, and two retries. */
const TARGETS = [
  { name: 'settlement CVA', chain: monad, token: addresses.cash, units: config.amounts.cash * 4n },
  { name: 'RWA CVA', chain: base, token: addresses.rwa, units: config.amounts.asset * 8n },
];

await assertChainIdentity(monad);
await assertChainIdentity(base);

const minted = [];

for (const target of TARGETS) {
  const { chain, token } = target;
  log.stage(target.name);

  const [symbol, decimals, before, supplyBefore] = await Promise.all([
    chain.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'symbol' }),
    chain.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'decimals' }),
    chain.pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [deployer.address],
    }),
    chain.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'totalSupply' }),
  ]);

  log.step(`${symbol} at ${token}`);
  log.step(`holder ${deployer.address} holds ${formatUnits(before, decimals)}`);

  if (before >= target.units) {
    log.ok(`already holds ${formatUnits(before, decimals)} ${symbol}; nothing to mint`);
    minted.push({ ...describe(target, symbol, decimals), minted: '0', balance: before.toString() });
    continue;
  }

  const minterRole = await chain.pub.readContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: 'MINTER_ROLE',
  });
  const hasRole = await chain.pub.readContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: 'hasRole',
    args: [minterRole, deployer.address],
  });

  if (!hasRole) {
    await submit(chain, {
      label: `${symbol}.grantRole(MINTER_ROLE, deployer)`,
      log,
      request: {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'grantRole',
        args: [minterRole, deployer.address],
      },
      postState: {
        describe: 'the deployer holds MINTER_ROLE',
        read: () =>
          chain.pub.readContract({
            address: token,
            abi: TOKEN_ABI,
            functionName: 'hasRole',
            args: [minterRole, deployer.address],
          }),
        matches: (value) => value === true,
      },
    });
  }

  const shortfall = target.units - before;
  await submit(chain, {
    label: `${symbol}.mint(deployer, ${formatUnits(shortfall, decimals)})`,
    log,
    request: {
      address: token,
      abi: TOKEN_ABI,
      functionName: 'mint',
      args: [deployer.address, shortfall],
    },
    postState: {
      // The delta, not the balance. A balance that happens to be right proves
      // nothing about whether this transaction is what made it right.
      describe: `balance rises by exactly ${shortfall.toString()}`,
      read: () =>
        chain.pub.readContract({
          address: token,
          abi: TOKEN_ABI,
          functionName: 'balanceOf',
          args: [deployer.address],
        }),
      matches: (value) => value === before + shortfall,
    },
  });

  const [after, supplyAfter] = await Promise.all([
    chain.pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [deployer.address],
    }),
    chain.pub.readContract({ address: token, abi: TOKEN_ABI, functionName: 'totalSupply' }),
  ]);

  if (supplyAfter - supplyBefore !== shortfall) {
    log.fail(
      `supply moved by ${(supplyAfter - supplyBefore).toString()} for a mint of ${shortfall.toString()}`,
    );
    process.exit(1);
  }

  log.ok(
    `${formatUnits(after, decimals)} ${symbol}, total supply ${formatUnits(supplyAfter, decimals)}`,
  );
  minted.push({
    ...describe(target, symbol, decimals),
    minted: shortfall.toString(),
    balance: after.toString(),
    totalSupply: supplyAfter.toString(),
  });
}

function describe(target, symbol, decimals) {
  return {
    token: target.token,
    chainId: target.chain.chainId,
    symbol,
    decimals,
  };
}

const path = join(ROOT, 'docs', 'evidence', 'phase-07-generation-3-supply.json');
writeFileSync(
  path,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      deploymentId: config.deploymentId,
      holder: deployer.address,
      tokens: minted,
      note:
        'Sandbox supply for the planned live runs only. Neither token is backed by anything ' +
        'and neither is aUSDC.',
    },
    null,
    2,
  )}\n`,
);
log.ok(`written ${path}`);

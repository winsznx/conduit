#!/usr/bin/env node
/**
 * Everything between two deployments and a settlement that can actually run.
 *
 *   node --env-file=.env scripts/wire-dvp-stack.mjs
 *
 * A fresh pair of legs is inert. The peer emitters are unset in one direction,
 * the coordinator does not know its escrow, no contract has a compliance signer,
 * the escrow has no CVI so the policy refuses to let it hold the cash, and the
 * deployer cannot mint the bond it is supposed to sell.
 *
 * Every one of those is a protocol step rather than setup, so every one is
 * submitted, confirmed, made visible on each provider, and read back before the
 * next goes out. A wiring call that silently did not land shows up two hours
 * later as a settlement that refuses a message from an address nobody chose.
 *
 * Idempotent: each step reads its own post-state first and skips when it is
 * already true. `setRemotePeer` and `setCashEscrow` lock permanently after one
 * call, so a rerun must not attempt them again.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import {
  ADAPTER_ABI,
  COORDINATOR_ABI,
  ESCROW_ABI,
  RWA_ABI,
  loadDvpConfig,
  padEmitter,
} from './lib/dvp.mjs';
import { assertChainIdentity, submit } from './lib/chain.mjs';
import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'wire-dvp-stack.log'));

const config = loadDvpConfig();
const { monad, base, addresses, deployer, complianceSigner } = config;

const done = [];

/** Runs a step only when its post-state is not already true. */
async function ensure({ label, chain, isDone, request }) {
  if (await isDone()) {
    log.step(`${label} — already true`);
    done.push({ step: label, action: 'skipped' });
    return;
  }
  const result = await submit(chain, {
    label,
    log,
    request,
    postState: {
      describe: 'read back',
      read: async () => await isDone(),
      matches: (value) => value === true,
    },
  });
  done.push({ step: label, action: 'sent', hash: result.hash });
}

await assertChainIdentity(monad);
await assertChainIdentity(base);

log.stage('peers');

await ensure({
  label: 'adapter.setRemotePeer(coordinator)',
  chain: base,
  isDone: async () => {
    const [emitter, locked] = await Promise.all([
      base.pub.readContract({
        address: addresses.adapter,
        abi: ADAPTER_ABI,
        functionName: 'remoteEmitter',
      }),
      base.pub.readContract({
        address: addresses.adapter,
        abi: ADAPTER_ABI,
        functionName: 'remotePeerLocked',
      }),
    ]);
    return locked && emitter === padEmitter(addresses.coordinator);
  },
  request: {
    address: addresses.adapter,
    abi: ADAPTER_ABI,
    functionName: 'setRemotePeer',
    args: [padEmitter(addresses.coordinator)],
  },
});

log.step(
  `coordinator peer ${await monad.pub.readContract({ address: addresses.coordinator, abi: COORDINATOR_ABI, functionName: 'remoteEmitter' })}`,
);

log.stage('bindings');

await ensure({
  label: 'coordinator.setCashEscrow(escrow)',
  chain: monad,
  isDone: async () => {
    const wired = await monad.pub.readContract({
      address: addresses.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'cashEscrow',
    });
    return wired.toLowerCase() === addresses.escrow.toLowerCase();
  },
  request: {
    address: addresses.coordinator,
    abi: COORDINATOR_ABI,
    functionName: 'setCashEscrow',
    args: [addresses.escrow],
  },
});

log.stage('compliance authority');

for (const [name, chain, address, abi] of [
  ['coordinator', monad, addresses.coordinator, COORDINATOR_ABI],
  ['escrow', monad, addresses.escrow, ESCROW_ABI],
  ['adapter', base, addresses.adapter, ADAPTER_ABI],
]) {
  await ensure({
    label: `${name}.addComplianceSigner`,
    chain,
    isDone: () =>
      chain.pub.readContract({
        address,
        abi,
        functionName: 'isComplianceSigner',
        args: [complianceSigner.address],
      }),
    request: {
      address,
      abi,
      functionName: 'addComplianceSigner',
      args: [complianceSigner.address],
    },
  });

  await ensure({
    label: `${name}.setComplianceQuorum(1)`,
    chain,
    isDone: async () =>
      (await chain.pub.readContract({ address, abi, functionName: 'complianceQuorum' })) === 1n,
    request: { address, abi, functionName: 'setComplianceQuorum', args: [1n] },
  });
}

log.stage('supply');

const minterRole = await base.pub.readContract({
  address: addresses.rwa,
  abi: RWA_ABI,
  functionName: 'MINTER_ROLE',
});

await ensure({
  label: 'rwa.grantRole(MINTER_ROLE, deployer)',
  chain: base,
  isDone: () =>
    base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'hasRole',
      args: [minterRole, deployer.address],
    }),
  request: {
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'grantRole',
    args: [minterRole, deployer.address],
  },
});

const path = join(ROOT, 'docs', 'evidence', 'phase-06-wiring.json');
writeFileSync(
  path,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      addresses,
      complianceSigner: complianceSigner.address,
      steps: done,
      remaining: [
        'register the RWA CVA with Cleanverse (scripts/register-cva.mjs)',
        'configure RuleV2 (scripts/configure-cva-rule.mjs)',
        'register the escrow as a CVI vault (scripts/register-cash-vault.mjs)',
        'emit both deployment manifests',
      ],
    },
    null,
    2,
  )}\n`,
);
log.ok(`written ${path}`);

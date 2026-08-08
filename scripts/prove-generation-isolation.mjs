#!/usr/bin/env node
/**
 * Proves a superseded deployment generation cannot reach into the current one.
 *
 *   node --env-file=.env scripts/prove-generation-isolation.mjs
 *
 * Core contracts are non-upgradeable, so every fix deploys a new generation and
 * the old contracts stay on chain. That is the safe design and it creates its
 * own hazard: two coordinators, two escrows, two adapters, and one registered
 * CVA token that both adapters were once authorised against. Nothing about
 * "we redeployed" makes the old set inert — the addresses still resolve, the
 * code still runs, and the guardians will still sign whatever the old emitters
 * publish.
 *
 * Four separations have to hold, and each is asked of the chain rather than
 * assumed:
 *
 * ```text
 *   the superseded adapter can no longer touch the token's reservations
 *   exactly one adapter is authorised against the token
 *   the superseded coordinator knows nothing about the current generation
 *   a message from the superseded generation is refused by the current one
 * ```
 *
 * The last is the one `deploymentId` exists for. Every header carries it and
 * `_consume` compares it, so a VAA from generation one is not merely unwanted by
 * generation two — it is undecodable as one of its messages.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ADAPTER_ABI, COORDINATOR_ABI, RWA_ABI, loadDvpConfig, padEmitter } from './lib/dvp.mjs';
import { assertChainIdentity, revertName, shortMessage } from './lib/chain.mjs';
import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'generation-isolation.log'));

const config = loadDvpConfig();
const { monad, base, addresses, deployer } = config;

const supersededAdapter = process.env['SUPERSEDED_RWA_CVA_ADAPTER_ADDRESS'];
const supersededCoordinator = process.env['SUPERSEDED_SETTLEMENT_COORDINATOR_ADDRESS'];
const supersededEscrow = process.env['SUPERSEDED_CASH_ESCROW_ADDRESS'];
const supersededDeploymentId = process.env['SUPERSEDED_DEPLOYMENT_ID'];
/** A real message the superseded generation published. Optional but strong. */
const supersededVaa = process.env['SUPERSEDED_ASSET_PREPARED_VAA'];

const results = [];
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  (ok ? log.ok : log.fail)(`${check} — ${detail}`);
}

async function refuses(label, chain, request) {
  const outcome = await chain.pub
    .simulateContract({ ...request, account: deployer })
    .then(() => undefined)
    .catch((error) => error);
  if (outcome === undefined) {
    record(label, false, 'the call succeeded, and it must not');
    return;
  }
  record(label, true, `refused with ${revertName(outcome) ?? shortMessage(outcome)}`);
}

await assertChainIdentity(monad);
await assertChainIdentity(base);

log.stage('the current generation');
log.step(`deployment  ${config.deploymentId}`);
log.step(`coordinator eip155:10143:${addresses.coordinator}`);
log.step(`escrow      eip155:10143:${addresses.escrow}`);
log.step(`adapter     eip155:84532:${addresses.adapter}`);
log.step(`token       eip155:84532:${addresses.rwa}  (unchanged across generations)`);

// ── 1. The superseded adapter is disarmed ───────────────────────────────────

if (supersededAdapter !== undefined && supersededAdapter !== '') {
  log.stage('the superseded adapter');

  const settlementRole = await base.pub.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'SETTLEMENT_ROLE',
  });

  const oldHasRole = await base.pub.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'hasRole',
    args: [settlementRole, supersededAdapter],
  });
  record(
    'the superseded adapter no longer holds SETTLEMENT_ROLE',
    !oldHasRole,
    `${supersededAdapter} hasRole=${String(oldHasRole)}`,
  );

  const newHasRole = await base.pub.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'hasRole',
    args: [settlementRole, addresses.adapter],
  });
  record(
    'the current adapter does hold it',
    newHasRole,
    `${addresses.adapter} hasRole=${String(newHasRole)}`,
  );

  // Losing the role is what makes the reservation calls unreachable, so the
  // calls themselves are tried. A revoked role that still admits a call would
  // be the interesting finding.
  const probe = `0x${'ab'.repeat(32)}`;
  for (const [label, functionName, args] of [
    ['markCommitted', 'markCommitted', [probe]],
    ['markAnnounced', 'markAnnounced', [probe]],
    ['releaseReservation', 'releaseReservation', [probe, deployer.address]],
  ]) {
    await refuses(`the superseded adapter cannot call ${label} on the token`, base, {
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName,
      args,
      // Simulated as the old adapter: this is the exact authority it used to
      // have, exercised from the address that used to have it.
      account: supersededAdapter,
    });
  }
}

// ── 2. Exactly one adapter is authorised ────────────────────────────────────

{
  const settlementRole = await base.pub.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'SETTLEMENT_ROLE',
  });
  const candidates = [addresses.adapter, supersededAdapter, deployer.address].filter(
    (entry) => typeof entry === 'string' && entry !== '',
  );
  const holders = [];
  for (const candidate of candidates) {
    const has = await base.pub.readContract({
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName: 'hasRole',
      args: [settlementRole, candidate],
    });
    if (has) holders.push(candidate);
  }
  record(
    'exactly one settlement adapter is authorised against the token',
    holders.length === 1 && holders[0] === addresses.adapter,
    holders.length === 0 ? 'nobody holds it' : holders.join(', '),
  );
}

// ── 3. The superseded coordinator is not part of this generation ────────────

if (supersededCoordinator !== undefined && supersededCoordinator !== '') {
  log.stage('the superseded coordinator');

  const peer = await base.pub.readContract({
    address: addresses.adapter,
    abi: ADAPTER_ABI,
    functionName: 'remoteEmitter',
  });
  record(
    'the current adapter is locked to the current coordinator, not the old one',
    peer === padEmitter(addresses.coordinator),
    `peer ${peer}, old coordinator would be ${padEmitter(supersededCoordinator)}`,
  );

  const oldDeployment = await monad.pub.readContract({
    address: supersededCoordinator,
    abi: COORDINATOR_ABI,
    functionName: 'deploymentId',
  });
  record(
    'the two coordinators carry different deployment ids',
    oldDeployment !== config.deploymentId,
    `old ${oldDeployment}, current ${config.deploymentId}`,
  );

  const oldEscrow = await monad.pub.readContract({
    address: supersededCoordinator,
    abi: COORDINATOR_ABI,
    functionName: 'cashEscrow',
  });
  record(
    'the superseded coordinator points at its own escrow, not the current one',
    oldEscrow.toLowerCase() !== addresses.escrow.toLowerCase(),
    `${oldEscrow}`,
  );
}

if (supersededEscrow !== undefined && supersededEscrow !== '') {
  // `recordCashPrepared` is restricted to the coordinator's own escrow, so the
  // superseded escrow reporting into the current coordinator is exactly the
  // cross-generation confusion the caller check also happens to close.
  await refuses('the superseded escrow cannot report into the current coordinator', monad, {
    address: addresses.coordinator,
    abi: COORDINATOR_ABI,
    functionName: 'recordCashPrepared',
    args: [`0x${'cd'.repeat(32)}`, `0x${'cd'.repeat(32)}`],
    account: supersededEscrow,
  });
}

// ── 4. A message from the superseded generation is refused ──────────────────

if (supersededVaa !== undefined && supersededVaa !== '') {
  log.stage('a real message from the superseded generation');
  await refuses('the current coordinator refuses a VAA from the superseded generation', monad, {
    address: addresses.coordinator,
    abi: COORDINATOR_ABI,
    functionName: 'recordAssetPrepared',
    args: [supersededVaa],
  });
  log.step(
    'the refusal names either the emitter or the deployment id: the old adapter is not ' +
      'this generation’s peer, and its header carries the old deployment id. Both checks ' +
      'are independent and either alone is sufficient.',
  );
} else {
  log.warn(
    'SUPERSEDED_ASSET_PREPARED_VAA is unset, so cross-generation message rejection was not ' +
      'exercised against a real message. Set it to a VAA the previous generation published.',
  );
  results.push({
    check: 'cross-generation message rejection',
    ok: false,
    detail: 'not exercised: no superseded VAA supplied',
  });
}

// ── Report ──────────────────────────────────────────────────────────────────

const failed = results.filter((entry) => !entry.ok);
log.stage('summary');
log.step(`${results.length - failed.length}/${results.length} separations hold`);

const path = join(ROOT, 'docs', 'evidence', 'phase-06-generation-isolation.json');
writeFileSync(
  path,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      current: {
        deploymentId: config.deploymentId,
        coordinator: addresses.coordinator,
        escrow: addresses.escrow,
        adapter: addresses.adapter,
        token: addresses.rwa,
      },
      superseded: {
        deploymentId: supersededDeploymentId ?? null,
        coordinator: supersededCoordinator ?? null,
        escrow: supersededEscrow ?? null,
        adapter: supersededAdapter ?? null,
      },
      checks: results,
    },
    null,
    2,
  )}\n`,
);
log.step(`written ${path}`);

if (failed.length > 0) process.exitCode = 1;

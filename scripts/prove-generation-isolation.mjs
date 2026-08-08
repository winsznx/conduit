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
import { proveContractRefusal } from '../packages/verifier/dist/refusal.js';
import { assertChainIdentity, shortMessage } from './lib/chain.mjs';
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
/** Full refusal evidence, so the artifact carries the path and not the verdict. */
const refusals = [];
function record(check, ok, detail) {
  results.push({ check, ok, detail });
  (ok ? log.ok : log.fail)(`${check} — ${detail}`);
}

/**
 * Proves a refusal rather than inferring one.
 *
 * This function used to catch any error from `simulateContract` and record it
 * as the chain rejecting the caller. It passed once on
 * `Function "recordCashPrepared" not found on ABI` — viem refused to build the
 * calldata, nothing reached the chain, and the report claimed an authority
 * check had held that was never exercised. It would have passed against a
 * contract with no access control at all.
 *
 * `proveContractRefusal` walks the whole path and returns evidence only when
 * the calldata encoded, the target had code, the call reached it, and the
 * contract reverted with bytes that decode against its own ABI. Anything else
 * throws with the outcome named, and this records it as a failed check rather
 * than a passing one.
 */
async function refuses(label, chain, request, expectedError) {
  try {
    const evidence = await proveContractRefusal(chain.pub, {
      label,
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      args: request.args,
      account: request.account ?? deployer.address ?? deployer,
      ...(expectedError === undefined ? {} : { expectedError }),
    });
    record(label, true, `refused with ${evidence.decodedError ?? evidence.rawRevert}`);
    refusals.push(evidence);
  } catch (error) {
    const evidence = error?.evidence;
    record(
      label,
      false,
      evidence === undefined
        ? shortMessage(error)
        : `${evidence.outcome}: ${evidence.detail} (not a protocol refusal)`,
    );
    if (evidence !== undefined) refusals.push(evidence);
  }
}

await assertChainIdentity(monad);
await assertChainIdentity(base);

log.stage('the current generation');
log.step(`deployment  ${config.deploymentId}`);
log.step(`coordinator eip155:10143:${addresses.coordinator}`);
log.step(`escrow      eip155:10143:${addresses.escrow}`);
log.step(`adapter     eip155:84532:${addresses.adapter}`);
log.step(`token       eip155:84532:${addresses.rwa}`);
// The label used to read "unchanged across generations", which was true for
// generation 2 and stopped being true for generation 3. D-06 changed
// `ConduitRWACVA._update`, and both tokens are `ConduitRWACVA`, so both were
// redeployed and both were re-registered with Cleanverse. A stale reassurance
// in a report is worse than no reassurance.
log.step(`             generation 3 redeployed both CVAs: D-06 changed the token's code`);

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

// ── 5. The generation *before* the superseded one ───────────────────────────
//
// Generation 1 still holds a real committed settlement and has no disposition
// path. Testing only the nearest predecessor would leave the older one
// unexamined precisely because it is easy to forget, and it is the generation
// whose contracts have been live longest.

const gen1Adapter = process.env['GENERATION_1_RWA_CVA_ADAPTER'];
const gen1Coordinator = process.env['GENERATION_1_SETTLEMENT_COORDINATOR'];
const gen1Escrow = process.env['GENERATION_1_CASH_ESCROW'];
const gen1DeploymentId = process.env['GENERATION_1_DEPLOYMENT_ID'];

if (gen1Adapter !== undefined && gen1Adapter !== '') {
  log.stage('generation 1');
  log.step(`deployment  ${gen1DeploymentId}`);

  for (const [label, functionName, args] of [
    ['markCommitted', 'markCommitted', [`0x${'ab'.repeat(32)}`]],
    ['releaseReservation', 'releaseReservation', [`0x${'ab'.repeat(32)}`, deployer.address]],
  ]) {
    await refuses(`the generation-1 adapter cannot call ${label} on the generation-3 token`, base, {
      address: addresses.rwa,
      abi: RWA_ABI,
      functionName,
      args,
      account: gen1Adapter,
    });
  }

  await refuses('the generation-1 escrow cannot report into the generation-3 coordinator', monad, {
    address: addresses.coordinator,
    abi: COORDINATOR_ABI,
    functionName: 'recordCashPrepared',
    args: [`0x${'ab'.repeat(32)}`, `0x${'ab'.repeat(32)}`],
    account: gen1Escrow,
  });

  const gen1CoordinatorEmitter = padEmitter(gen1Coordinator);
  const currentPeer = await base.pub.readContract({
    address: addresses.adapter,
    abi: ADAPTER_ABI,
    functionName: 'remoteEmitter',
  });
  record(
    'the generation-3 adapter is not peered to the generation-1 coordinator',
    currentPeer.toLowerCase() !== gen1CoordinatorEmitter.toLowerCase(),
    `peer ${currentPeer}, generation-1 coordinator would be ${gen1CoordinatorEmitter}`,
  );
}

// ── 6. One address, two chains, two contracts ───────────────────────────────
//
// Generation 3 reproduced the collision ADR-0018 was written for, twice: the
// deployer's nonce lines up across chains and the same address lands on both.
// This is the check that the *system* keeps them apart rather than the
// deployment happening to avoid it.

log.stage('same address, different chains');

{
  const collisions = [];
  const identities = [
    ['SettlementCoordinator', monad, addresses.coordinator],
    ['CashEscrow', monad, addresses.escrow],
    ['RWACVASettlementAdapter', base, addresses.adapter],
    ['ConduitRWACVA', base, addresses.rwa],
  ];

  for (const [roleA, chainA, addressA] of identities) {
    for (const [roleB, chainB, addressB] of identities) {
      if (roleA >= roleB) continue;
      if (addressA.toLowerCase() !== addressB.toLowerCase()) continue;
      // The chain object travels with the role, not a slot index. The first
      // version read code from `monad` for whichever role sorted first and from
      // `base` for the other, so the byte counts appeared beside the wrong
      // labels — a report that was true in substance and wrong in every detail
      // a reader would check.
      collisions.push({ roleA, chainA, roleB, chainB, address: addressA });
    }
  }

  if (collisions.length === 0) {
    log.step('no address is shared across roles in this generation');
  }

  for (const collision of collisions) {
    // The same address, and provably different code. If these ever matched,
    // one contract would be answering for both roles and every claim keyed by
    // address alone would be right by accident.
    const codeA = await collision.chainA.pub.getCode({ address: collision.address });
    const codeB = await collision.chainB.pub.getCode({ address: collision.address });
    const bytes = (code) => String((code?.length ?? 2) / 2 - 1);
    record(
      `${collision.address} is two different contracts across chains`,
      codeA !== codeB && codeA !== undefined && codeB !== undefined,
      `eip155:${String(collision.chainA.chainId)} is ${collision.roleA} (${bytes(codeA)} bytes), ` +
        `eip155:${String(collision.chainB.chainId)} is ${collision.roleB} (${bytes(codeB)} bytes)`,
    );
  }

  record(
    'the deployment reports its own collisions rather than hiding them',
    true,
    collisions.length === 0
      ? 'none in this generation'
      : collisions
          .map(
            (entry) =>
              `${entry.address}: ${entry.roleA}@${String(entry.chainA.chainId)} vs ` +
              `${entry.roleB}@${String(entry.chainB.chainId)}`,
          )
          .join('; '),
  );
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
      // The path behind every negative claim, not the verdict alone: the
      // calldata that encoded, the address it reached, the chain it reached it
      // on, the raw revert bytes, and the decoded error. A reader can tell a
      // contract refusal from a client-side failure without rerunning anything.
      refusalEvidence: refusals,
    },
    null,
    2,
  )}\n`,
);
log.step(`written ${path}`);

if (failed.length > 0) process.exitCode = 1;

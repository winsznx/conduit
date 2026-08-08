#!/usr/bin/env node
/**
 * The whole generation-2 migration, in one command.
 *
 *   node --env-file=.env scripts/deploy-generation-2.mjs [--dry-run]
 *
 * Generation 1 settled phase 06 and cannot disposition a held leg:
 * `resolveHeldCash` and `resolveHeldAsset` postdate it. Core contracts are
 * non-upgradeable, so the fix is a new generation with its own deployment ID,
 * and the old contracts stay on chain holding the settlements they decided.
 *
 * This exists because the last redeployment was done by hand and two ordering
 * mistakes came out of it. The coordinator locks its peer emitter at
 * construction, so deploying Monad before the final Base adapter stranded it and
 * cost a second deployment; and `register_atoken` refuses a duplicate symbol, so
 * the token had to be redeployed under a new one after the far side already
 * existed. Both are ordering facts, both are now encoded here, and neither is
 * something to remember at two in the morning.
 *
 * The order, and why:
 *
 * ```text
 *   0  refuse early if the deployer cannot cover the whole migration
 *   1  Base adapter first — the coordinator locks its peer at construction
 *   2  Monad coordinator and escrow, pointed at that adapter
 *   3  adapter.setRemotePeer(coordinator) closes the loop, once, forever
 *   4  bindings, signers, quorum, minter
 *   5  revoke SETTLEMENT_ROLE from the superseded adapter
 *   6  register the new escrow for CVI custody, or it cannot hold the cash
 *   7  manifests under the new deployment id — the old files are not touched
 *   8  prove the superseded generation is inert
 *   9  full preflight against the new stack
 * ```
 *
 * The token is not redeployed. It is a registered Cleanverse CVA and its
 * registration is bound to its address; nothing in this generation changes it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'deploy-generation-2.log'));
const dryRun = process.argv.includes('--dry-run');

const ENV_PATH = join(ROOT, '.env');

/** Rewrites one variable in `.env`, leaving every other line byte-identical. */
function setEnv(name, value) {
  const contents = readFileSync(ENV_PATH, 'utf8');
  const line = `${name}=${value}`;
  const updated = new RegExp(`^${name}=.*$`, 'm').test(contents)
    ? contents.replace(new RegExp(`^${name}=.*$`, 'm'), line)
    : `${contents.replace(/\n*$/, '\n')}${line}\n`;
  if (dryRun) {
    log.step(`[dry run] would set ${name}`);
    return;
  }
  writeFileSync(ENV_PATH, updated);
  process.env[name] = value;
  log.step(`set ${name}=${value}`);
}

function run(command, args, label) {
  log.step(`$ ${command} ${args.slice(0, 3).join(' ')}…`);
  if (dryRun) {
    log.step(`[dry run] skipped ${label}`);
    return '';
  }
  const output = execFileSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return output;
}

const deployer = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const monad = createPublicClient({ transport: http(process.env['MONAD_TESTNET_RPC_URL']) });

// ── 0. Can this finish? ─────────────────────────────────────────────────────

log.stage('funding');

/**
 * The reservation, not the spend.
 *
 * A deploy is refused if the sender cannot cover `gasLimit × price` up front,
 * and Forge sets the limit to 130% of its estimate. The estimates for these two
 * contracts came in *below* what generation 1 actually used — 6.85M against
 * 8.62M — so the multiplier is covering a real gap rather than padding, and it
 * stays. This checks against the reserved figure for that reason.
 */
const REQUIRED_GAS = 8_900_000n;
const SCENARIO_GAS = 3_000_000n;

{
  const balance = await monad.getBalance({ address: deployer.address });
  const gasPrice = await monad.getGasPrice();
  const needed = (REQUIRED_GAS + SCENARIO_GAS) * gasPrice;

  log.step(`deployer  ${deployer.address}`);
  log.step(`balance   ${(Number(balance) / 1e18).toFixed(6)} MON`);
  log.step(`gas price ${Number(gasPrice) / 1e9} gwei`);
  log.step(`needed    ${(Number(needed) / 1e18).toFixed(6)} MON (deploy + the live scenario)`);

  if (balance < needed && !dryRun) {
    log.fail(
      `short by ${(Number(needed - balance) / 1e18).toFixed(4)} MON. ` +
        'Fund the deployer and run this again; nothing has been changed.',
    );
    process.exit(1);
  }
  log.ok('the deployer can cover the whole migration');
}

const supersededDeploymentId = process.env['CONDUIT_DEPLOYMENT_ID'];
const supersededCoordinator = process.env['SETTLEMENT_COORDINATOR_ADDRESS'];
const supersededEscrow = process.env['CASH_ESCROW_ADDRESS'];
const supersededAdapter = process.env['RWA_CVA_ADAPTER_ADDRESS'];
const newDeploymentId = process.env['PENDING_GENERATION_2_DEPLOYMENT_ID'];
const pendingAdapter = process.env['PENDING_GENERATION_2_ADAPTER'];

if (newDeploymentId === undefined || newDeploymentId === '') {
  log.fail('PENDING_GENERATION_2_DEPLOYMENT_ID is not set');
  process.exit(1);
}

log.stage('generation');
log.step(`superseded ${supersededDeploymentId}`);
log.step(`new        ${newDeploymentId}`);

setEnv('SUPERSEDED_DEPLOYMENT_ID', supersededDeploymentId);
setEnv('SUPERSEDED_SETTLEMENT_COORDINATOR_ADDRESS', supersededCoordinator);
setEnv('SUPERSEDED_CASH_ESCROW_ADDRESS', supersededEscrow);
setEnv('SUPERSEDED_RWA_CVA_ADAPTER_ADDRESS', supersededAdapter);
setEnv('CONDUIT_DEPLOYMENT_ID', newDeploymentId);

// ── 1. Base adapter ─────────────────────────────────────────────────────────

log.stage('Base Sepolia: the settlement adapter');

/**
 * Reused when it already exists.
 *
 * The generation-2 adapter was deployed before the Monad side ran out of gas.
 * It carries the new deployment ID, its peer is unset, and `setRemotePeer` has
 * not been called — so it is exactly a fresh adapter and redeploying it would
 * only spend Base gas to reach the same state.
 */
let adapter = pendingAdapter;
if (adapter !== undefined && adapter !== '') {
  const base = createPublicClient({ transport: http(process.env['BASE_SEPOLIA_RPC_URL']) });
  const code = await base.getCode({ address: adapter });
  if (code !== undefined && code.length > 2) {
    log.ok(`reusing the already-deployed adapter ${adapter}`);
  } else {
    adapter = undefined;
  }
}

if (adapter === undefined || adapter === '') {
  const output = run(
    'forge',
    [
      'script',
      'contracts/script/DeployAssetAdapter.s.sol:DeployAssetAdapter',
      '--rpc-url',
      process.env['BASE_SEPOLIA_RPC_URL'],
      '--broadcast',
      '--slow',
    ],
    'adapter deploy',
  );
  const match = /RWACVASettlementAdapter\s+(0x[0-9a-fA-F]{40})/.exec(output);
  if (match === null) throw new Error('could not read the adapter address from the deploy output');
  adapter = match[1];
  log.ok(`adapter ${adapter}`);
}
setEnv('RWA_CVA_ADAPTER_ADDRESS', adapter);

// ── 2. Monad coordinator and escrow ─────────────────────────────────────────

log.stage('Monad Testnet: the coordinator and the escrow');

{
  const output = run(
    'forge',
    [
      'script',
      'contracts/script/DeployCashLeg.s.sol:DeployCashLeg',
      '--rpc-url',
      process.env['MONAD_TESTNET_RPC_URL'],
      '--broadcast',
      '--slow',
    ],
    'cash leg deploy',
  );
  if (!dryRun) {
    const coordinator = /SettlementCoordinator\s+(0x[0-9a-fA-F]{40})/.exec(output);
    const escrow = /CashEscrow\s+(0x[0-9a-fA-F]{40})/.exec(output);
    if (coordinator === null || escrow === null) {
      throw new Error('could not read the coordinator and escrow addresses from the deploy output');
    }
    setEnv('SETTLEMENT_COORDINATOR_ADDRESS', coordinator[1]);
    setEnv('CASH_ESCROW_ADDRESS', escrow[1]);
  }
}

// ── 3-5. Wiring, roles, and the superseded adapter ──────────────────────────

log.stage('wiring, roles, and revocation');
run('node', ['--env-file=.env', 'scripts/wire-dvp-stack.mjs'], 'wiring');

// ── 6. CVI custody for the new escrow ───────────────────────────────────────

log.stage('CVI custody for the new escrow');
run('node', ['--env-file=.env', 'scripts/register-cash-vault.mjs'], 'vault registration');

// ── 7. Manifests ────────────────────────────────────────────────────────────

log.stage('manifests');
run(
  'node',
  ['--env-file=.env', 'scripts/emit-deployment-manifest.mjs', 'base-sepolia'],
  'base manifest',
);
run(
  'node',
  ['--env-file=.env', 'scripts/emit-deployment-manifest.mjs', 'monad-testnet'],
  'monad manifest',
);
log.step('the superseded generation keeps its own manifest files: the filename carries the id');

// ── 8. The superseded generation is inert ───────────────────────────────────

log.stage('generation isolation');
run('node', ['--env-file=.env', 'scripts/prove-generation-isolation.mjs'], 'isolation proof');

// ── 9. Preflight ────────────────────────────────────────────────────────────

log.stage('preflight');
run('node', ['--env-file=.env', 'scripts/dvp-preflight.mjs'], 'preflight');

log.ok('generation 2 is live, wired, isolated from generation 1, and preflight-green');
log.step('next: node --env-file=.env scripts/run-compliance-change.mjs');

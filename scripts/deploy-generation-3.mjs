#!/usr/bin/env node
/**
 * The whole generation-3 migration, in one resumable command.
 *
 *   node --env-file=.env scripts/deploy-generation-3.mjs [--dry-run]
 *
 * Generation 2 settled phase 06's happy path and phase 07's compliance change,
 * and it carries D-06: `ConduitRWACVA._update` subtracts a releasing
 * reservation from `_reservedOf` after `releaseReservation` has already
 * decremented it. Unreachable with one reservation, and with a smaller second
 * one it underflows and the release reverts — held value no authority can free.
 *
 * **Both tokens are redeployed, not just the settlement contracts.** The Monad
 * settlement CVA is a `ConduitRWACVA` too (`DeploySettlementCVA.s.sol` reuses
 * it), so the fix changed its code as well. The cash leg never reserves, which
 * makes the defect unreachable there today — but "unreachable today" is not
 * "absent", the contract is non-upgradeable, and anyone may call
 * `reserveForSettlement` on it. Deploying only the coordinator, escrow and
 * adapter would leave a known token defect live under a generation that claims
 * to have fixed it.
 *
 * A new token means a new Cleanverse registration, and `register_atoken`
 * refuses a duplicate symbol, so both tokens take new ones.
 *
 * The order, and why each position is forced:
 *
 * ```text
 *   0  refuse early if either chain cannot cover its half
 *   1  Base token — everything else on Base points at it
 *   2  register it with Cleanverse and poll to ISSUED; a token the policy does
 *      not know reverts on every transfer, including the mint
 *   3  RuleV2, read back from the policy rather than from the request
 *   4  Base adapter — the coordinator locks its peer at construction, so the
 *      adapter must exist before Monad is deployed
 *   5  Base kernel: registry and controller
 *   6  Monad settlement CVA, registered and ruled the same way
 *   7  Monad coordinator and escrow, pointed at the Base adapter
 *   8  Monad kernel
 *   9  wiring: peers, bindings, signers, roles, executors, revocations
 *  10  CVI custody for the new escrow, or it cannot hold the cash
 *  11  supply, only what the final runs need
 *  12  manifests under the new deployment id
 *  13  isolation from generations 1 and 2
 *  14  preflight
 * ```
 *
 * Every step records its result in `.env` and skips when that record already
 * exists, so an interrupted migration resumes rather than restarting. A step
 * that spends gas or submits a Cleanverse application is exactly the kind that
 * must not run twice.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'deploy-generation-3.log'));
const dryRun = process.argv.includes('--dry-run');
const ENV_PATH = join(ROOT, '.env');

function setEnv(name, value) {
  const contents = readFileSync(ENV_PATH, 'utf8');
  const line = `${name}=${value}`;
  const updated = new RegExp(`^${name}=.*$`, 'm').test(contents)
    ? contents.replace(new RegExp(`^${name}=.*$`, 'm'), line)
    : `${contents.replace(/\n*$/, '\n')}${line}\n`;
  if (dryRun) {
    log.step(`[dry run] would set ${name}=${value}`);
    return;
  }
  writeFileSync(ENV_PATH, updated);
  process.env[name] = value;
  log.step(`set ${name}=${value}`);
}

function run(command, args, label) {
  log.step(`$ ${command} ${args.join(' ').slice(0, 110)}…`);
  if (dryRun) {
    log.step(`[dry run] skipped ${label}`);
    return '';
  }
  return execFileSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function forgeScript(target, rpcEnv, label) {
  return run(
    'forge',
    ['script', target, '--rpc-url', process.env[rpcEnv], '--broadcast', '--slow'],
    label,
  );
}

/** Reads one `console2.log("label", value)` line out of a forge script's output. */
function readAddress(output, label) {
  const match = new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`).exec(output);
  if (match === null) throw new Error(`could not read ${label} from the deploy output`);
  return match[1];
}

const deployer = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const monad = createPublicClient({ transport: http(process.env['MONAD_TESTNET_RPC_URL']) });
const base = createPublicClient({ transport: http(process.env['BASE_SEPOLIA_RPC_URL']) });

/** True when the address is set and actually carries code on that chain. */
async function deployed(client, address) {
  if (address === undefined || address === '') return false;
  const code = await client.getCode({ address });
  return code !== undefined && code.length > 2;
}

// ── 0. Can this finish? ─────────────────────────────────────────────────────

log.stage('funding');

/**
 * The reservation is for the work that is *left*, not for the whole migration.
 *
 * Generation 2 used 8.62M gas for the coordinator and escrow alone; generation 3
 * adds a token, a registry and a controller to that side. Forge reserves
 * `gasLimit × price` up front at 130% of its estimate, and that multiplier is
 * load-bearing — generation 2's estimate came in below what the deploy actually
 * consumed.
 *
 * But this script is resumable, and a resumed run that still reserves for
 * deploys it has already done refuses to continue over gas it does not need.
 * That happened: with every Monad contract live and only the timelocked wiring
 * left, a flat 26M-gas reservation stopped the run at 1.79 MON. The check now
 * asks the chain what exists before deciding what it has to pay for, which is
 * the same rule the rest of the script follows.
 */
const MONAD_DEPLOY_GAS = 20_000_000n;
/** Wiring, roles, custody, mint: many small transactions rather than a few big ones. */
const MONAD_WIRING_GAS = 3_000_000n;
/** Both live runs, from generation 2's observed consumption plus headroom. */
const SCENARIO_GAS = 6_000_000n;

{
  const monadDeployed =
    (await deployed(monad, process.env['GENERATION_3_SETTLEMENT_COORDINATOR'])) &&
    (await deployed(monad, process.env['GENERATION_3_CASH_ESCROW'])) &&
    (await deployed(monad, process.env['GENERATION_3_SETTLEMENT_CVA'])) &&
    (await deployed(monad, process.env['MONAD_DISPOSITION_CONTROLLER']));

  const balance = await monad.getBalance({ address: deployer.address });
  const gasPrice = await monad.getGasPrice();
  const remainingGas = (monadDeployed ? 0n : MONAD_DEPLOY_GAS) + MONAD_WIRING_GAS + SCENARIO_GAS;
  const needed = remainingGas * gasPrice;
  const baseBalance = await base.getBalance({ address: deployer.address });

  log.step(`deployer   ${deployer.address}`);
  log.step(
    `monad      ${(Number(balance) / 1e18).toFixed(6)} MON at ${Number(gasPrice) / 1e9} gwei`,
  );
  log.step(
    `monad need ${(Number(needed) / 1e18).toFixed(6)} MON for ${remainingGas.toString()} gas ` +
      `(${monadDeployed ? 'contracts already deployed: wiring and runs only' : 'deploy, wiring and runs'})`,
  );
  log.step(`base       ${(Number(baseBalance) / 1e18).toFixed(6)} ETH`);

  if (balance < needed && !dryRun) {
    log.fail(
      `HUMAN_GATE_FUNDING: short by ${(Number(needed - balance) / 1e18).toFixed(4)} MON on Monad. ` +
        'Nothing has been changed.',
    );
    process.exit(1);
  }
  if (baseBalance < 5_000_000_000_000_000n && !dryRun) {
    log.fail('HUMAN_GATE_FUNDING: below 0.005 ETH on Base Sepolia. Nothing has been changed.');
    process.exit(1);
  }
  log.ok('both chains can cover the work that remains');
}

// ── Generation bookkeeping ──────────────────────────────────────────────────

const previousDeploymentId = process.env['CONDUIT_DEPLOYMENT_ID'];
const newDeploymentId = process.env['PENDING_GENERATION_3_DEPLOYMENT_ID'];

if (newDeploymentId === undefined || newDeploymentId === '') {
  log.fail('PENDING_GENERATION_3_DEPLOYMENT_ID is not set');
  process.exit(1);
}

log.stage('generation');
log.step(`generation 1 ${process.env['SUPERSEDED_DEPLOYMENT_ID'] ?? '(unknown)'}`);
log.step(`generation 2 ${previousDeploymentId}`);
log.step(`generation 3 ${newDeploymentId}`);

if (previousDeploymentId !== newDeploymentId) {
  // Generation 2's addresses move to their own variables before anything
  // overwrites them, so the isolation proofs can still reach the contracts they
  // are proving inert. Generation 1's are already parked and stay untouched.
  setEnv('GENERATION_2_DEPLOYMENT_ID', previousDeploymentId);
  setEnv('GENERATION_2_SETTLEMENT_COORDINATOR', process.env['SETTLEMENT_COORDINATOR_ADDRESS']);
  setEnv('GENERATION_2_CASH_ESCROW', process.env['CASH_ESCROW_ADDRESS']);
  setEnv('GENERATION_2_RWA_CVA_ADAPTER', process.env['RWA_CVA_ADAPTER_ADDRESS']);
  setEnv('GENERATION_2_RWA_CVA', process.env['RWA_CVA_ADDRESS']);
  setEnv('GENERATION_2_SETTLEMENT_CVA', process.env['SETTLEMENT_CVA_ADDRESS']);

  // The isolation script reads these two, and generation 2 is now the nearest
  // superseded stack — the one whose VAAs and roles most plausibly still work.
  setEnv('SUPERSEDED_DEPLOYMENT_ID', previousDeploymentId);
  setEnv(
    'SUPERSEDED_SETTLEMENT_COORDINATOR_ADDRESS',
    process.env['SETTLEMENT_COORDINATOR_ADDRESS'],
  );
  setEnv('SUPERSEDED_CASH_ESCROW_ADDRESS', process.env['CASH_ESCROW_ADDRESS']);
  setEnv('SUPERSEDED_RWA_CVA_ADAPTER_ADDRESS', process.env['RWA_CVA_ADAPTER_ADDRESS']);

  setEnv('CONDUIT_DEPLOYMENT_ID', newDeploymentId);
}

// ── 1. Base: the fixed RWA CVA ──────────────────────────────────────────────

log.stage('Base Sepolia: the RWA CVA, with D-06 fixed');

if (!(await deployed(base, process.env['GENERATION_3_RWA_CVA']))) {
  setEnv('RWA_CVA_SYMBOL', process.env['GENERATION_3_RWA_SYMBOL'] ?? 'cBOND3');
  const output = forgeScript(
    'contracts/script/DeployAssetLeg.s.sol:DeployAssetLeg',
    'BASE_SEPOLIA_RPC_URL',
    'RWA CVA deploy',
  );
  if (!dryRun) {
    setEnv('GENERATION_3_RWA_CVA', readAddress(output, 'ConduitRWACVA'));
    // `DeployAssetLeg` deploys an adapter alongside the token. That adapter is
    // discarded: it was constructed against a peer that does not exist yet, and
    // the peer locks at construction.
    log.step('the adapter that deploy emitted is discarded; step 4 deploys the real one');
  }
} else {
  log.ok(`reusing ${process.env['GENERATION_3_RWA_CVA']}`);
}
setEnv('RWA_CVA_ADDRESS', process.env['GENERATION_3_RWA_CVA']);

// ── 2. Base: Cleanverse registration ────────────────────────────────────────

log.stage('Base Sepolia: Cleanverse registration');

if (process.env['GENERATION_3_RWA_REGISTERED'] !== 'true') {
  run(
    'node',
    ['--env-file=.env', 'scripts/register-cva.mjs', process.env['RWA_CVA_ADDRESS'], 'base'],
    'RWA registration',
  );
  if (!dryRun) {
    const evidence = JSON.parse(
      readFileSync(join(ROOT, 'docs', 'evidence', 'phase-03-cva-registration.json'), 'utf8'),
    );
    if (evidence.registered !== true) {
      log.fail(`registration did not reach ISSUED: applyStatus ${String(evidence.applyStatus)}`);
      process.exit(1);
    }
    setEnv('GENERATION_3_RWA_REGISTERED', 'true');
  }
} else {
  log.ok('already ISSUED');
}

// ── 3. Base: RuleV2 ─────────────────────────────────────────────────────────

log.stage('Base Sepolia: RuleV2');
run('node', ['--env-file=.env', 'scripts/configure-cva-rule.mjs', '0', 'base'], 'RWA RuleV2');

// ── 4. Base: the settlement adapter ─────────────────────────────────────────

log.stage('Base Sepolia: the settlement adapter');

if (!(await deployed(base, process.env['GENERATION_3_RWA_CVA_ADAPTER']))) {
  const output = forgeScript(
    'contracts/script/DeployAssetAdapter.s.sol:DeployAssetAdapter',
    'BASE_SEPOLIA_RPC_URL',
    'adapter deploy',
  );
  if (!dryRun) {
    setEnv('GENERATION_3_RWA_CVA_ADAPTER', readAddress(output, 'RWACVASettlementAdapter'));
  }
} else {
  log.ok(`reusing ${process.env['GENERATION_3_RWA_CVA_ADAPTER']}`);
}
setEnv('RWA_CVA_ADAPTER_ADDRESS', process.env['GENERATION_3_RWA_CVA_ADAPTER']);

// ── 5. Base: the Disposition Kernel ─────────────────────────────────────────

log.stage('Base Sepolia: the Disposition Kernel');

if (!(await deployed(base, process.env['BASE_DISPOSITION_CONTROLLER']))) {
  const output = forgeScript(
    'contracts/script/DeployDispositionKernel.s.sol:DeployDispositionKernel',
    'BASE_SEPOLIA_RPC_URL',
    'base kernel deploy',
  );
  if (!dryRun) {
    setEnv('BASE_AUTHORITY_REGISTRY', readAddress(output, 'AuthorityRegistry'));
    setEnv('BASE_DISPOSITION_CONTROLLER', readAddress(output, 'DispositionController'));
  }
} else {
  log.ok(`reusing ${process.env['BASE_DISPOSITION_CONTROLLER']}`);
}

// ── 6. Monad: the fixed settlement CVA ──────────────────────────────────────

log.stage('Monad Testnet: the settlement CVA, with D-06 fixed');

if (!(await deployed(monad, process.env['GENERATION_3_SETTLEMENT_CVA']))) {
  setEnv('SETTLEMENT_CVA_SYMBOL', process.env['GENERATION_3_SETTLEMENT_SYMBOL'] ?? 'cSETTLE3');
  const output = forgeScript(
    'contracts/script/DeploySettlementCVA.s.sol:DeploySettlementCVA',
    'MONAD_TESTNET_RPC_URL',
    'settlement CVA deploy',
  );
  if (!dryRun) setEnv('GENERATION_3_SETTLEMENT_CVA', readAddress(output, 'settlement CVA'));
} else {
  log.ok(`reusing ${process.env['GENERATION_3_SETTLEMENT_CVA']}`);
}
setEnv('SETTLEMENT_CVA_ADDRESS', process.env['GENERATION_3_SETTLEMENT_CVA']);
setEnv('MONAD_CASH_ATOKEN', process.env['GENERATION_3_SETTLEMENT_CVA']);

if (process.env['GENERATION_3_SETTLEMENT_REGISTERED'] !== 'true') {
  run(
    'node',
    ['--env-file=.env', 'scripts/register-cva.mjs', process.env['SETTLEMENT_CVA_ADDRESS'], 'monad'],
    'settlement CVA registration',
  );
  if (!dryRun) {
    const evidence = JSON.parse(
      readFileSync(
        join(ROOT, 'docs', 'evidence', 'phase-01-settlement-cva-registration.json'),
        'utf8',
      ),
    );
    if (evidence.registered !== true) {
      log.fail(`registration did not reach ISSUED: applyStatus ${String(evidence.applyStatus)}`);
      process.exit(1);
    }
    setEnv('GENERATION_3_SETTLEMENT_REGISTERED', 'true');
  }
} else {
  log.ok('already ISSUED');
}

log.stage('Monad Testnet: RuleV2');
run(
  'node',
  ['--env-file=.env', 'scripts/configure-cva-rule.mjs', '0', 'monad'],
  'settlement RuleV2',
);

// ── 7. Monad: coordinator and escrow ────────────────────────────────────────

log.stage('Monad Testnet: the coordinator and the escrow');

if (!(await deployed(monad, process.env['GENERATION_3_SETTLEMENT_COORDINATOR']))) {
  const output = forgeScript(
    'contracts/script/DeployCashLeg.s.sol:DeployCashLeg',
    'MONAD_TESTNET_RPC_URL',
    'cash leg deploy',
  );
  if (!dryRun) {
    setEnv('GENERATION_3_SETTLEMENT_COORDINATOR', readAddress(output, 'SettlementCoordinator'));
    setEnv('GENERATION_3_CASH_ESCROW', readAddress(output, 'CashEscrow'));
  }
} else {
  log.ok(`reusing ${process.env['GENERATION_3_SETTLEMENT_COORDINATOR']}`);
}
setEnv('SETTLEMENT_COORDINATOR_ADDRESS', process.env['GENERATION_3_SETTLEMENT_COORDINATOR']);
setEnv('CASH_ESCROW_ADDRESS', process.env['GENERATION_3_CASH_ESCROW']);

// ── 8. Monad: the Disposition Kernel ────────────────────────────────────────

log.stage('Monad Testnet: the Disposition Kernel');

if (!(await deployed(monad, process.env['MONAD_DISPOSITION_CONTROLLER']))) {
  const output = forgeScript(
    'contracts/script/DeployDispositionKernel.s.sol:DeployDispositionKernel',
    'MONAD_TESTNET_RPC_URL',
    'monad kernel deploy',
  );
  if (!dryRun) {
    setEnv('MONAD_AUTHORITY_REGISTRY', readAddress(output, 'AuthorityRegistry'));
    setEnv('MONAD_DISPOSITION_CONTROLLER', readAddress(output, 'DispositionController'));
  }
} else {
  log.ok(`reusing ${process.env['MONAD_DISPOSITION_CONTROLLER']}`);
}

// ── 9. Wiring ───────────────────────────────────────────────────────────────

log.stage('wiring, roles, executors, and revocation');
run('node', ['--env-file=.env', 'scripts/wire-dvp-stack.mjs'], 'wiring');
run('node', ['--env-file=.env', 'scripts/wire-disposition-kernel.mjs'], 'kernel wiring');

// ── 10. CVI custody ─────────────────────────────────────────────────────────

log.stage('CVI custody for the new escrow');
run('node', ['--env-file=.env', 'scripts/register-cash-vault.mjs'], 'vault registration');

// ── 11. Supply ──────────────────────────────────────────────────────────────

log.stage('supply');
run('node', ['--env-file=.env', 'scripts/mint-generation-supply.mjs'], 'supply');

// ── 12. Manifests ───────────────────────────────────────────────────────────

log.stage('manifests');
run('node', ['--env-file=.env', 'scripts/emit-deployment-manifest.mjs', 'base-sepolia'], 'base');
run('node', ['--env-file=.env', 'scripts/emit-deployment-manifest.mjs', 'monad-testnet'], 'monad');

// ── 13. Isolation ───────────────────────────────────────────────────────────

log.stage('generation isolation');
run('node', ['--env-file=.env', 'scripts/prove-generation-isolation.mjs'], 'isolation proof');

// ── 14. Preflight ───────────────────────────────────────────────────────────

log.stage('preflight');
run('node', ['--env-file=.env', 'scripts/dvp-preflight.mjs'], 'preflight');

log.ok('generation 3 is live, registered, wired, isolated, and preflight-green');

const TOKEN_ABI = parseAbi(['function symbol() view returns (string)']);
if (!dryRun) {
  log.stage('the canonical deployment');
  log.step(`deployment  ${newDeploymentId}`);
  log.step(`Monad  coordinator ${process.env['SETTLEMENT_COORDINATOR_ADDRESS']}`);
  log.step(`       escrow      ${process.env['CASH_ESCROW_ADDRESS']}`);
  log.step(
    `       cash CVA    ${process.env['SETTLEMENT_CVA_ADDRESS']}  ` +
      (await monad.readContract({
        address: process.env['SETTLEMENT_CVA_ADDRESS'],
        abi: TOKEN_ABI,
        functionName: 'symbol',
      })),
  );
  log.step(`       registry    ${process.env['MONAD_AUTHORITY_REGISTRY']}`);
  log.step(`       controller  ${process.env['MONAD_DISPOSITION_CONTROLLER']}`);
  log.step(
    `Base   RWA CVA     ${process.env['RWA_CVA_ADDRESS']}  ` +
      (await base.readContract({
        address: process.env['RWA_CVA_ADDRESS'],
        abi: TOKEN_ABI,
        functionName: 'symbol',
      })),
  );
  log.step(`       adapter     ${process.env['RWA_CVA_ADAPTER_ADDRESS']}`);
  log.step(`       registry    ${process.env['BASE_AUTHORITY_REGISTRY']}`);
  log.step(`       controller  ${process.env['BASE_DISPOSITION_CONTROLLER']}`);
}

/**
 * The generation the app is pointed at, and the two assets it settles.
 *
 * Addresses come from the environment, which is filled from the deployment
 * manifests — CLAUDE.md requires that and forbids hardcoding them here. What is
 * hardcoded is the *shape*: which chain each leg lives on, which chain has a
 * registered validator pool, and how many decimals each unit carries. Those are
 * properties of the protocol rather than of a deployment.
 */

import type { Address } from 'viem';

import type { CheckTarget } from './eligibility.js';
import type { Env } from './data.js';

export const MONAD_TESTNET = 10_143;
export const BASE_SEPOLIA = 84_532;

/** Cleanverse's own chain names, which are not the EVM chain ids. */
export const CLEANVERSE_CHAIN: Readonly<Record<number, string>> = Object.freeze({
  [MONAD_TESTNET]: 'monad',
  [BASE_SEPOLIA]: 'base',
});

export interface DeploymentConfig {
  readonly deploymentId: string;
  readonly coordinator: Address;
  readonly cashEscrow: Address;
  readonly cashAsset: Address;
  readonly rwaToken: Address;
  readonly rwaAdapter: Address;
}

export function deploymentConfig(env: Env): DeploymentConfig | undefined {
  const coordinator = env.SETTLEMENT_COORDINATOR_ADDRESS;
  const cashEscrow = env.CASH_ESCROW_ADDRESS;
  const cashAsset = env.SETTLEMENT_CVA_ADDRESS;
  const rwaToken = env.RWA_CVA_ADDRESS;
  const rwaAdapter = env.RWA_CVA_ADAPTER_ADDRESS;
  if (!coordinator || !cashEscrow || !cashAsset || !rwaToken || !rwaAdapter) return undefined;
  return {
    deploymentId: env.DEPLOYMENT_ID,
    coordinator: coordinator as Address,
    cashEscrow: cashEscrow as Address,
    cashAsset: cashAsset as Address,
    rwaToken: rwaToken as Address,
    rwaAdapter: rwaAdapter as Address,
  };
}

/** Both assets carry six decimals in this deployment. */
export const DECIMALS = 6;

/**
 * What to ask Cleanverse about, per chain.
 *
 * Monad names `CashEscrow` as the pool, because it is registered through
 * `ConduitVaultRegistrar` and `validator/verify` answers about pools rather
 * than tokens. Base names none: `validator/grant` was refused for this
 * credential, so no Conduit pool exists there and `verify_apass` is the only
 * source (ASM-037). Passing a token address to `validator/verify` returns
 * "no data", which reads as an outage and is a wrong question.
 */
export function checkTargets(config: DeploymentConfig): readonly CheckTarget[] {
  return [
    {
      chain: 'monad',
      chainId: MONAD_TESTNET,
      asset: config.cashAsset,
      assetSymbol: 'cSETTLE',
      pool: config.cashEscrow,
    },
    {
      chain: 'base',
      chainId: BASE_SEPOLIA,
      asset: config.rwaToken,
      assetSymbol: 'cBOND',
    },
  ];
}

export function targetForChain(config: DeploymentConfig, chainId: number): CheckTarget | undefined {
  return checkTargets(config).find((target) => target.chainId === chainId);
}

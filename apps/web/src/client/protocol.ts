/**
 * The protocol, from the browser.
 *
 * Builds a settlement intent, has the connected wallet sign it, and checks the
 * signature locally before anything is sent anywhere. Conduit never sees a key:
 * it sees a signature and a settlement id, both of which anyone can re-derive.
 *
 * ## Why the signature is recovered here
 *
 * A wallet that returns a signature for a *different* digest than the one shown
 * is the failure this guards against, and it is not hypothetical — it is what a
 * mismatched domain produces. Recovering the signer in the browser and
 * comparing it to the connected account turns that into an error the user sees
 * immediately, rather than a revert twenty minutes later when the coordinator
 * rejects the commit.
 *
 * ## What the server is and is not
 *
 * The signed intent is persisted so a counterparty can open the same settlement
 * from their own browser. That store is a convenience for coordination. It is
 * never the authority: the coordinator on chain verifies both signatures
 * against the digest itself, and a database that disagreed with it would simply
 * be wrong.
 */

import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  SETTLEMENT_INTENT_TYPE,
  createSettlementIntent,
  type SettlementIntent,
  type SettlementIntentTerms,
} from '@conduit-protocol/domain';
import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from 'viem';

import { BASE_SEPOLIA, MONAD_TESTNET, wallet } from './wallet.js';

/** Addresses the server rendered into the page, from the deployment manifests. */
export interface Deployment {
  readonly deploymentId: Hex;
  readonly coordinator: Address;
  readonly cashEscrow: Address;
  readonly cashAsset: Address;
  readonly rwaToken: Address;
  readonly rwaAdapter: Address;
}

export const DECIMALS = 6;

/** Base units from a decimal string, without floating point anywhere near it. */
export function toBaseUnits(value: string, decimals = DECIMALS): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('amount must be a positive number');
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) throw new Error(`at most ${String(decimals)} decimal places`);
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

export function fromBaseUnits(value: bigint, decimals = DECIMALS): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

export interface DraftTerms {
  readonly cashAmount: bigint;
  readonly cashPayer: Address;
  readonly cashReceiver: Address;
  readonly assetAmount: bigint;
  readonly assetSeller: Address;
  readonly assetReceiver: Address;
  readonly prepareDeadline: bigint;
  readonly commitDeadline: bigint;
  readonly releaseDeadline: bigint;
  readonly nonce: bigint;
}

/**
 * The domain the coordinator will verify against.
 *
 * `chainId` is the *cash* chain, because `SettlementCoordinator` lives on Monad
 * and is the verifying contract. Signing against Base produces a digest the
 * coordinator does not recognise, and the transaction reverts rather than
 * failing at signature time — which is why this is derived here rather than
 * left to a caller.
 */
export function intentDomain(deployment: Deployment): TypedDataDomain {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: MONAD_TESTNET,
    verifyingContract: deployment.coordinator,
  };
}

export function buildTerms(deployment: Deployment, draft: DraftTerms): SettlementIntentTerms {
  return {
    version: 1,
    cashChainId: BigInt(MONAD_TESTNET),
    cashEscrow: deployment.cashEscrow,
    cashAsset: deployment.cashAsset,
    cashAmount: draft.cashAmount,
    cashPayer: draft.cashPayer,
    cashReceiver: draft.cashReceiver,
    assetChainId: BigInt(BASE_SEPOLIA),
    // Under the v1.1 override the token itself records the reservation, so the
    // asset "escrow" is the RWA contract rather than a separate holder.
    assetEscrow: deployment.rwaToken,
    assetToken: deployment.rwaToken,
    assetAmount: draft.assetAmount,
    assetSeller: draft.assetSeller,
    assetReceiver: draft.assetReceiver,
    cashPolicyHash: ZERO32,
    assetPolicyHash: ZERO32,
    prepareDeadline: draft.prepareDeadline,
    commitDeadline: draft.commitDeadline,
    releaseDeadline: draft.releaseDeadline,
    nonce: draft.nonce,
  };
}

const ZERO32: Hex = `0x${'0'.repeat(64)}`;

export function buildIntent(deployment: Deployment, draft: DraftTerms): SettlementIntent {
  return createSettlementIntent(buildTerms(deployment, draft), {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: BigInt(MONAD_TESTNET),
    verifyingContract: deployment.coordinator,
  });
}

export interface SignedIntent {
  readonly intent: SettlementIntent;
  readonly signer: Address;
  readonly signature: Hex;
}

/**
 * Signs the intent with the connected wallet, then proves who signed it.
 *
 * The wallet is put on the cash chain first. `signTypedData` does not strictly
 * require it, but a wallet showing a different network while asking for a
 * signature bound to Monad is a prompt a careful person should refuse, and the
 * app should not be the reason they have to.
 */
export async function signIntent(
  deployment: Deployment,
  intent: SettlementIntent,
): Promise<SignedIntent> {
  const account = wallet.current.address;
  if (account === undefined) throw new Error('no wallet is connected');

  await wallet.ensureChain(MONAD_TESTNET);

  const domain = intentDomain(deployment);
  const client = wallet.walletClient(MONAD_TESTNET);
  const signature = await client.signTypedData({
    account,
    domain,
    types: SETTLEMENT_INTENT_TYPE,
    primaryType: 'SettlementIntent',
    message: intent,
  });

  const recovered = await recoverTypedDataAddress({
    domain,
    types: SETTLEMENT_INTENT_TYPE,
    primaryType: 'SettlementIntent',
    message: intent,
    signature,
  });

  if (recovered.toLowerCase() !== account.toLowerCase()) {
    throw new Error(
      `the wallet returned a signature for ${recovered}, not ${account}. It has not been used.`,
    );
  }

  return { intent, signer: recovered, signature };
}

/** Which roles the connected wallet can sign for in this intent. */
export function rolesFor(
  intent: SettlementIntent,
  account: Address | undefined,
): readonly string[] {
  if (account === undefined) return [];
  const lower = account.toLowerCase();
  const roles: string[] = [];
  if (intent.cashPayer.toLowerCase() === lower) roles.push('payer');
  if (intent.assetSeller.toLowerCase() === lower) roles.push('seller');
  return roles;
}

/** Serialises for the wire. `bigint` has no JSON representation. */
export function encodeIntent(intent: SettlementIntent): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(intent)) {
    out[key] = typeof value === 'bigint' ? value.toString() : (value as string | number);
  }
  return out;
}

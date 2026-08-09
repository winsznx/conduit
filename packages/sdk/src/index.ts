import {
  AuthorityType,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  DispositionType,
  Leg,
  SETTLEMENT_INTENT_TYPE,
  caseIdFor,
  createSettlementIntent,
  dispositionOrderDigest,
  redirectsValue,
  settlementIntentDomain,
} from '@conduit-protocol/domain';

import type {
  DeploymentDomain,
  DispositionOrder,
  SettlementIntent,
  SettlementIntentTerms,
} from '@conduit-protocol/domain';
import type { Hex, TypedDataDomain } from 'viem';

/**
 * @conduit-protocol/sdk
 *
 * What a party, an operator or an auditor needs to interact with Conduit
 * without trusting Conduit's servers.
 *
 * The shape of this package follows from one constraint: nothing here may be
 * the only way to do something. Every intent it builds can be rebuilt from the
 * PRD's typed struct; every digest it computes is reproduced independently by
 * the contracts; every verification it runs reads two chains and a guardian set
 * and consults no Conduit service. If this package disappeared, a determined
 * counterparty could still settle and still verify — that is the property, and
 * an SDK that quietly became load-bearing would have removed it.
 *
 * So there is no signer in here. `buildIntent` returns a struct and a digest; a
 * caller signs with their own wallet, and Conduit never sees a key. The same
 * for disposition orders: this constructs and hashes them, and an authority
 * signs.
 */

export const PACKAGE_ID = '@conduit-protocol/sdk';

/** PRD 11.x / phase 06, matching this workspace's README. */
export const IMPLEMENTATION_PHASE = '06';

export interface DeploymentRef {
  readonly deploymentId: Hex;
  readonly cashChainId: number;
  readonly assetChainId: number;
  readonly cashEscrow: Hex;
  readonly cashAsset: Hex;
  readonly assetToken: Hex;
  readonly assetAdapter: Hex;
  readonly coordinator: Hex;
  readonly cashController: Hex;
  readonly assetController: Hex;
}

export interface IntentDraft {
  readonly deployment: DeploymentRef;
  readonly cashAmount: bigint;
  readonly cashPayer: Hex;
  readonly cashReceiver: Hex;
  readonly assetAmount: bigint;
  readonly assetSeller: Hex;
  readonly assetReceiver: Hex;
  readonly cashPolicyHash: Hex;
  readonly assetPolicyHash: Hex;
  readonly prepareDeadline: bigint;
  readonly commitDeadline: bigint;
  readonly releaseDeadline: bigint;
  readonly nonce: bigint;
}

export interface BuiltIntent {
  readonly intent: SettlementIntent;
  /**
   * The digest both parties sign, and the settlement's identifier.
   *
   * One value for both purposes deliberately: if the ID and the signing digest
   * differed, a signature could be valid for an intent whose ID it did not
   * cover.
   */
  readonly settlementId: Hex;
  readonly domain: TypedDataDomain;
  /** Ready to hand to `wallet.signTypedData`. Conduit never sees the key. */
  readonly typedData: {
    readonly domain: TypedDataDomain;
    readonly types: typeof SETTLEMENT_INTENT_TYPE;
    readonly primaryType: 'SettlementIntent';
    readonly message: SettlementIntent;
  };
}

/**
 * Assembles a settlement intent from the terms two parties agreed.
 *
 * The deadlines are the caller's and are checked rather than defaulted. A
 * commit deadline shorter than the asset chain's finality produces a settlement
 * that cannot legally commit — observed Base Sepolia finality on this
 * deployment has run 999 to 1485 seconds, and a fifteen-minute window would
 * have failed roughly half of those. The SDK refuses to build it rather than
 * letting a caller discover that after locking funds.
 */
export function buildIntent(draft: IntentDraft): BuiltIntent {
  const { deployment } = draft;

  if (draft.cashAmount <= 0n || draft.assetAmount <= 0n) {
    throw new Error('both legs must move a positive amount');
  }
  if (draft.prepareDeadline >= draft.commitDeadline) {
    throw new Error('the prepare deadline must fall before the commit deadline');
  }
  if (draft.commitDeadline >= draft.releaseDeadline) {
    throw new Error('the commit deadline must fall before the release deadline');
  }

  const terms: SettlementIntentTerms = {
    version: 1,
    cashChainId: BigInt(deployment.cashChainId),
    cashEscrow: deployment.cashEscrow,
    cashAsset: deployment.cashAsset,
    cashAmount: draft.cashAmount,
    cashPayer: draft.cashPayer,
    cashReceiver: draft.cashReceiver,
    assetChainId: BigInt(deployment.assetChainId),
    assetEscrow: deployment.assetToken,
    assetToken: deployment.assetToken,
    assetAmount: draft.assetAmount,
    assetSeller: draft.assetSeller,
    assetReceiver: draft.assetReceiver,
    cashPolicyHash: draft.cashPolicyHash,
    assetPolicyHash: draft.assetPolicyHash,
    prepareDeadline: draft.prepareDeadline,
    commitDeadline: draft.commitDeadline,
    releaseDeadline: draft.releaseDeadline,
    nonce: draft.nonce,
  };

  // The domain binds `chainId` to the *cash* chain, where the coordinator
  // lives. The asset chain is a struct field, so one signature commits to both
  // legs without either party signing two domains.
  //
  // `createSettlementIntent` derives the identifier from the terms and the
  // domain together, which is why the terms are built first and the intent
  // second — the ID *is* the digest, so it cannot exist before both do.
  const deploymentDomain: DeploymentDomain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: BigInt(deployment.cashChainId),
    verifyingContract: deployment.coordinator,
  };
  const intent = createSettlementIntent(terms, deploymentDomain);
  const domain = settlementIntentDomain(BigInt(deployment.cashChainId), deployment.coordinator);

  return {
    intent,
    settlementId: intent.settlementId,
    domain,
    typedData: {
      domain,
      types: SETTLEMENT_INTENT_TYPE,
      primaryType: 'SettlementIntent',
      message: intent,
    },
  };
}

/**
 * How long the commit window must be for a settlement to be committable at all.
 *
 * Two independent constraints meet here and the tighter one wins. The window
 * has to outlast the asset chain's economic finality, because the COMMIT rests
 * on a FINALIZED cross-chain message. And the compliance attestations that
 * authorize the COMMIT expire after `maxAttestationValidity`, which is
 * immutable at 900 seconds in the deployed bytecode — so they are minted *after*
 * the finality wait, not before it.
 *
 * That ordering is not a convenience. A prepare-time attestation cannot reach
 * the commit, and a deployment where it could would be one where compliance was
 * checked before the point of no return rather than at it.
 */
export const OBSERVED_BASE_FINALITY_SECONDS = Object.freeze([
  999, 1093, 1223, 1275, 1350, 1483, 1485,
]);

export function recommendedCommitWindowSeconds(): number {
  // The slowest observation, not the mean. Averaging seven samples of a
  // distribution whose tail is the thing that breaks you produces a number that
  // works most of the time.
  const slowest = Math.max(...OBSERVED_BASE_FINALITY_SECONDS);
  return slowest * 2;
}

export interface DispositionDraft {
  readonly deployment: DeploymentRef;
  readonly settlementId: Hex;
  readonly leg: 0 | 1;
  readonly dispositionType: (typeof DispositionType)[keyof typeof DispositionType];
  readonly sourceEscrow: Hex;
  readonly asset: Hex;
  readonly amount: bigint;
  readonly currentReceiver: Hex;
  readonly destination: Hex;
  readonly destinationIdentityCommitment: Hex;
  readonly authority: Hex;
  readonly authorityType: (typeof AuthorityType)[keyof typeof AuthorityType];
  readonly authorityPolicyId: Hex;
  readonly authorityPolicyHash: Hex;
  readonly evidenceCommitment: Hex;
  readonly complianceAttestationIds: Hex;
  readonly notBefore: bigint;
  readonly expiry: bigint;
  readonly nonce: bigint;
  readonly hostStateVersion: bigint;
}

export interface BuiltDispositionOrder {
  readonly order: DispositionOrder;
  readonly caseId: Hex;
  readonly digest: Hex;
  readonly domain: TypedDataDomain;
  /** True for every type except `REVERIFY_AND_RESUME`. */
  readonly redirectsValue: boolean;
}

/**
 * Assembles a disposition order for an authority to sign. PRD FR-012.
 *
 * The case ID is derived, never taken from the caller. A signer who chose it
 * could file two contradictory orders into two separate cases, both
 * uncontested, and have both execute — which would defeat the conflict rule
 * entirely. The controller rejects any order whose `caseId` is not this value,
 * and computing it here means a client cannot accidentally produce one.
 */
export function buildDispositionOrder(draft: DispositionDraft): BuiltDispositionOrder {
  const chainId =
    draft.leg === Leg.CASH ? draft.deployment.cashChainId : draft.deployment.assetChainId;
  const controller =
    draft.leg === Leg.CASH ? draft.deployment.cashController : draft.deployment.assetController;

  if (draft.expiry <= draft.notBefore) {
    throw new Error('an order must be valid for a non-zero window');
  }

  const caseId = caseIdFor(draft.deployment.deploymentId, draft.settlementId, draft.leg);

  const order: DispositionOrder = {
    caseId,
    settlementId: draft.settlementId,
    deploymentId: draft.deployment.deploymentId,
    leg: draft.leg,
    dispositionType: draft.dispositionType,
    sourceEscrow: draft.sourceEscrow,
    asset: draft.asset,
    amount: draft.amount,
    currentReceiver: draft.currentReceiver,
    destination: draft.destination,
    destinationIdentityCommitment: draft.destinationIdentityCommitment,
    authority: draft.authority,
    authorityType: draft.authorityType,
    authorityPolicyId: draft.authorityPolicyId,
    authorityPolicyHash: draft.authorityPolicyHash,
    evidenceCommitment: draft.evidenceCommitment,
    complianceAttestationIds: draft.complianceAttestationIds,
    notBefore: draft.notBefore,
    expiry: draft.expiry,
    nonce: draft.nonce,
    hostStateVersion: draft.hostStateVersion,
  };

  // The controller's domain, not the coordinator's. An order for the Monad
  // controller is not valid at the Base controller even with the same authority
  // and the same settlement, and two of this deployment's contracts already
  // share an address across those two chains.
  const domain: TypedDataDomain = {
    name: 'Conduit',
    version: '1',
    chainId,
    verifyingContract: controller,
  };

  return {
    order,
    caseId,
    domain,
    digest: dispositionOrderDigest(order, domain),
    redirectsValue: redirectsValue(draft.dispositionType),
  };
}

export {
  AuthorityType,
  DispositionType,
  Leg,
  caseIdFor,
  conflictResolutionDigest,
  dispositionOrderDigest,
  hashSettlementIntent,
  redirectsValue,
} from '@conduit-protocol/domain';

export type { DispositionOrder, SettlementIntent } from '@conduit-protocol/domain';

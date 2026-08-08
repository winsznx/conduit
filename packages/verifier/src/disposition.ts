import type { Address, Hex } from 'viem';

import type { ChainScopedAddress } from '@conduit-protocol/domain';

import type { DeploymentGeneration } from './registry.js';

/**
 * Independent reconstruction of a Disposition Kernel case. PRD FR-012, FR-014.
 *
 * The settlement verifier answers where the value went. This answers who said it
 * could, under which policy, against which compliance evidence, and whether
 * anybody disagreed. A settlement that reached a terminal state through a
 * disposition is not the same event as one that reached it through delivery, and
 * an audit that could not tell them apart could not tell whether the
 * counterparties got what they agreed to.
 *
 * Everything here is read from contract state rather than from event logs. That
 * is a deliberate constraint: public endpoints cap `eth_getLogs` at a hundred
 * blocks on Monad Testnet and a thousand on Base Sepolia, and a verifier whose
 * conclusion depends on how much history it managed to scan is a verifier that
 * certifies whatever fits in the window. The controller stores the winning
 * order, its authorities, the bound policy content and the compliance digest
 * precisely so this function needs no log range at all.
 *
 * ## The outcomes are classifications, not enums
 *
 * `CaseState` below *is* an on-chain enum on `DispositionController`. The
 * settlement-level outcomes — `DISPOSITION_FINAL`, `RESTRICTED_HOLD_FINAL`,
 * `HELD_PENDING_DISPOSITION` — are not, and no Solidity contract knows those
 * names. They are derived here from facts on two chains, exactly as
 * `SETTLED_FINAL` is (ADR-0017), and a report must never present them as
 * contract state.
 */

/** `DispositionController.CaseState`. This one is on chain. */
export const DISPOSITION_CASE_STATE = [
  'NONE',
  'OPEN',
  'CONTESTED',
  'ADJUDICATED',
  'EXECUTED',
] as const;

export type DispositionCaseState = (typeof DISPOSITION_CASE_STATE)[number];

/** PRD FR-012's order types, in the PRD's order. */
export const DISPOSITION_TYPE = [
  'REVERIFY_AND_RESUME',
  'REBIND_RECEIVER',
  'RETURN_TO_ELIGIBLE_SENDER',
  'AUTHORIZED_SUBSTITUTION',
  'OPERATOR_ASSISTED_OFFRAMP',
  'RESTRICTED_HOLD',
] as const;

export type DispositionTypeName = (typeof DISPOSITION_TYPE)[number];

/** PRD FR-012's authority classes, in the PRD's order. */
export const AUTHORITY_TYPE = [
  'SUBJECT',
  'COUNTERPARTY',
  'ISSUER',
  'TRANSFER_AGENT',
  'COMPLIANCE_OPERATOR',
  'GATEWAY_OPERATOR',
  'MULTISIG',
] as const;

export type AuthorityTypeName = (typeof AUTHORITY_TYPE)[number];

export const LEG_NAME = ['CASH', 'ASSET'] as const;
export type LegName = (typeof LEG_NAME)[number];

export interface ReconstructedAuthority {
  readonly address: Address;
  /** Its class *now*. A revoked signer is reported as revoked, not omitted. */
  readonly authorityType: AuthorityTypeName | undefined;
  readonly stillActive: boolean;
}

export interface ReconstructedDisposition {
  readonly leg: LegName;
  readonly caseId: Hex;
  readonly controller: ChainScopedAddress;
  readonly state: DispositionCaseState;
  readonly policyId: Hex;
  /** The policy content the orders bound, which may differ from today's. */
  readonly policyHash: Hex;
  /** Whether the registry's current policy still hashes to that. */
  readonly policyUnchangedSinceFiling: boolean;
  readonly filedAt: string;
  readonly signatures: number;
  readonly authorities: readonly ReconstructedAuthority[];
  readonly leadOrderHash: Hex;
  readonly executedOrderHash: Hex | undefined;
  readonly executedType: DispositionTypeName | undefined;
  readonly executedDestination: Address | undefined;
  readonly executedAmount: string | undefined;
  readonly executedComplianceDigest: Hex | undefined;
}

/** The subset of the settlement verifier's reader this needs. */
export interface DispositionReader {
  read(
    identity: ChainScopedAddress,
    functionName: string,
    args: readonly unknown[],
  ): Promise<unknown>;
}

const ZERO_HASH = `0x${'00'.repeat(32)}`;

/**
 * `DispositionController.Case`, by position.
 *
 * A struct comes back from `eth_call` as a positional tuple, and reading it with
 * bare numbers is how a field inserted in the middle of the Solidity struct
 * silently reassigns every value after it. Naming the positions here does not
 * prevent that, but it makes the diff visible: adding a field to the contract
 * means editing this block, and a reviewer can see the two lists side by side.
 */
const CASE = {
  state: 0,
  leg: 1,
  settlementId: 2,
  policyId: 3,
  policyHash: 4,
  leadTermsKey: 5,
  leadOrderHash: 6,
  filedAt: 7,
  signatures: 8,
  executedOrderHash: 9,
  executedType: 10,
  executedDestination: 11,
  executedAmount: 12,
  executedComplianceDigest: 13,
} as const;

function nameOf<T extends readonly string[]>(table: T, value: unknown): T[number] | undefined {
  return table[Number(value)];
}

/**
 * The case ID, derived exactly as the controller derives it.
 *
 * A signer does not choose it. Two orders about one piece of held value land in
 * one case by construction, which is what makes the conflict rule unavoidable —
 * and it is what lets a verifier find the case from nothing but a settlement ID
 * and a generation.
 */
export async function caseIdFor(deploymentId: Hex, settlementId: Hex, leg: 0 | 1): Promise<Hex> {
  const { encodeAbiParameters, keccak256 } = await import('viem');
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
      [deploymentId, settlementId, leg],
    ),
  );
}

/**
 * Reads one leg's disposition case, or reports that the generation has no kernel.
 *
 * Returns `undefined` when the controller is absent from the manifest or knows
 * nothing about this settlement. Those are different from a case that exists and
 * is empty, and the caller distinguishes them: generation 1 holds a real,
 * correct, permanently unresolvable settlement precisely because it has no
 * kernel, and reporting that as "no disposition" without the reason would be the
 * most misleading sentence in the whole report.
 */
export async function reconstructDisposition(
  settlementId: Hex,
  leg: LegName,
  chainId: number,
  generation: DeploymentGeneration,
  reader: DispositionReader,
): Promise<ReconstructedDisposition | undefined> {
  const controller = generation.tryRole(chainId, 'DispositionController');
  if (controller === undefined) return undefined;

  const caseId = await caseIdFor(generation.deploymentId, settlementId, leg === 'CASH' ? 0 : 1);
  const raw = (await reader.read(controller.identity, 'caseOf', [caseId])) as readonly unknown[];

  const state = nameOf(DISPOSITION_CASE_STATE, raw[CASE.state]) ?? 'NONE';
  if (state === 'NONE') return undefined;

  const policyId = raw[CASE.policyId] as Hex;
  const policyHash = raw[CASE.policyHash] as Hex;

  // The registry's current hash, compared rather than substituted. A policy
  // that changed after the orders were signed does not invalidate what already
  // executed — the orders bound the old content and the controller checked it —
  // but a reader deserves to know the two differ.
  const registry = generation.tryRole(chainId, 'AuthorityRegistry');
  let policyUnchangedSinceFiling = true;
  if (registry !== undefined) {
    const current = (await reader.read(registry.identity, 'policyHash', [policyId])) as Hex;
    policyUnchangedSinceFiling = current.toLowerCase() === policyHash.toLowerCase();
  }

  const signers = (await reader.read(controller.identity, 'authoritiesOf', [
    caseId,
  ])) as readonly Address[];

  const authorities: ReconstructedAuthority[] = [];
  for (const address of signers) {
    if (registry === undefined) {
      authorities.push({ address, authorityType: undefined, stillActive: false });
      continue;
    }
    const authority = (await reader.read(registry.identity, 'authorityOf', [
      address,
    ])) as readonly unknown[];
    authorities.push({
      address,
      authorityType: nameOf(AUTHORITY_TYPE, authority[0]),
      stillActive: authority[1] === true,
    });
  }

  const executedOrderHash = raw[CASE.executedOrderHash] as Hex;
  const executed = executedOrderHash !== ZERO_HASH;

  return {
    leg,
    caseId,
    controller: controller.identity,
    state,
    policyId,
    policyHash,
    policyUnchangedSinceFiling,
    filedAt: String(raw[CASE.filedAt]),
    signatures: Number(raw[CASE.signatures]),
    authorities,
    leadOrderHash: raw[CASE.leadOrderHash] as Hex,
    executedOrderHash: executed ? executedOrderHash : undefined,
    executedType: executed ? nameOf(DISPOSITION_TYPE, raw[CASE.executedType]) : undefined,
    executedDestination: executed ? (raw[CASE.executedDestination] as Address) : undefined,
    executedAmount: executed ? String(raw[CASE.executedAmount]) : undefined,
    executedComplianceDigest: executed ? (raw[CASE.executedComplianceDigest] as Hex) : undefined,
  };
}

/**
 * What a reconstructed case says about the settlement as a whole.
 *
 * Ordered by severity rather than by chronology: a contested case is the loudest
 * fact about a settlement whatever else is true of it, because it means two
 * authorities disagree and nothing may move until that is resolved.
 */
export function outcomeOfCases(
  cases: readonly (ReconstructedDisposition | undefined)[],
): 'CONTESTED' | 'RESTRICTED_HOLD_FINAL' | 'DISPOSITION_FINAL' | 'NONE' {
  const present = cases.filter((entry): entry is ReconstructedDisposition => entry !== undefined);
  if (present.length === 0) return 'NONE';

  if (present.some((entry) => entry.state === 'CONTESTED')) return 'CONTESTED';

  const executed = present.filter((entry) => entry.state === 'EXECUTED');
  if (executed.length === 0) return 'NONE';

  // Restricted custody is reported ahead of the others when any leg reached it.
  // It is the one outcome where the value did not reach a party to the trade at
  // all, and a report that folded it into "dispositioned" would be describing a
  // settlement that completed.
  if (executed.some((entry) => entry.executedType === 'RESTRICTED_HOLD')) {
    return 'RESTRICTED_HOLD_FINAL';
  }
  return 'DISPOSITION_FINAL';
}

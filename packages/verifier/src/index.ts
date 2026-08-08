/**
 * @conduit-protocol/verifier
 *
 * Database-independent settlement verifier.
 *
 * Phase 00 delivers this workspace as structure only. PRD FR-014 defines the
 * behaviour, which lands in phase 08. Nothing here may encode product
 * logic, protocol constants, or external-capability assumptions.
 */

export const PACKAGE_ID = '@conduit-protocol/verifier';

export const IMPLEMENTATION_PHASE = '08';

export {
  DeploymentGeneration,
  type DeploymentManifest,
  type ManifestChainConfig,
  type RegisteredContract,
} from './registry.js';

export {
  AUTHORITY_TYPE,
  DISPOSITION_CASE_STATE,
  DISPOSITION_TYPE,
  LEG_NAME,
  caseIdFor,
  outcomeOfCases,
  reconstructDisposition,
  type AuthorityTypeName,
  type DispositionCaseState,
  type DispositionReader,
  type DispositionTypeName,
  type LegName,
  type ReconstructedAuthority,
  type ReconstructedDisposition,
} from './disposition.js';

export {
  NotARefusalError,
  proveContractRefusal,
  RefusalOutcome,
  type RefusalClient,
  type RefusalEvidence,
  type RefusalRequest,
} from './refusal.js';

export {
  authorizesValue,
  CASH_LEG_STATE,
  DECISION,
  decodeVaa,
  finalityOf,
  LEG_OUTCOME,
  MESSAGE_TYPE,
  SETTLEMENT_STATE,
  verifySettlement,
  type ChainReader,
  type Finding,
  type GuardianReader,
  type MessageTypeName,
  type VerificationResult,
  type VerifiedMessage,
  type VerifyOptions,
} from './settlement.js';

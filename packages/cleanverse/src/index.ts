/**
 * @conduit-protocol/cleanverse
 *
 * Server-only Cleanverse API V5.6 client, encryption helper, and response parser.
 *
 * PRD 9.1: the browser never receives the API key, a decrypted payload, a raw
 * response containing sensitive material, or webhook HMAC key material. Nothing
 * in this package may be imported into a client bundle.
 *
 * CLAUDE.md: the AES helper exists only here.
 */

export const PACKAGE_ID = '@conduit-protocol/cleanverse';

export const IMPLEMENTATION_PHASE = '01';

export {
  isRestorationEvent,
  isRestricted,
  normalizeApass,
  NormalizedApassStatus,
  type ApassRecord,
  type NormalizedApass,
  type NormalizedApassStatusValue,
  type NormalizeOptions,
} from './apass.js';

export {
  aTokensDeployedOn,
  EVM_ADDRESS,
  isEvmAddress,
  type AttributedAToken,
  type CodeReader,
} from './discovery.js';

export {
  ApassStatus,
  ApiCode,
  describeVerifyApassCode,
  isApiOk,
  isRetryableApiCode,
  verifyApassAllowsTransfer,
  VerifyApassCode,
  type ApiCodeValue,
  type VerifyApassCodeValue,
} from './codes.js';

export {
  CleanverseClient,
  type CleanverseClientOptions,
  type CleanverseResult,
  type Fetcher,
} from './client.js';

export { createCipher, encryptRequestBody, type CleanverseCipher } from './encryption.js';

export {
  ADMIN_ONLY_ENDPOINTS,
  ENDPOINTS,
  isAdminOnly,
  type EndpointDefinition,
  type EndpointKind,
  type EndpointName,
} from './endpoints.js';

export {
  CleanverseApiError,
  CleanverseEncryptionError,
  CleanverseError,
  CleanverseSchemaError,
  CleanverseTransportError,
  CleanverseWriteInFlightError,
} from './errors.js';

export { hashRawBody, redact, REDACTED } from './redact.js';

export {
  depositATokenListDataSchema,
  depositATokenSchema,
  describeIssues,
  downloadReportDataSchema,
  encryptedEnvelopeSchema,
  envelopeSchema,
  queryApassDataSchema,
  queryTxsDataSchema,
  transactionRecordSchema,
  validatorIsPausedDataSchema,
  validatorIsRegisterDataSchema,
  validatorRuleSchema,
  validatorRulesDataSchema,
  validatorVerifyDataSchema,
  validatorWriteDataSchema,
  verifyApassDataSchema,
  type DepositAToken,
  type Envelope,
  type QueryApassData,
  type ValidatorRule,
  type ValidatorVerifyData,
  type VerifyApassData,
} from './schemas.js';

export {
  DELIVERY_ID_HEADER,
  DeliveryLedger,
  SIGNATURE_HEADER,
  verifyWebhook,
  WebhookVerificationError,
  type WebhookDelivery,
} from './webhooks.js';

export {
  pollApplyStatus,
  registerAToken,
  registrationMessage,
  type ApplyStatusData,
  type PollOptions,
  type RegisterATokenData,
  type RegisterATokenRequest,
  type RegistrationOutcome,
} from './registration.js';

export {
  applyStatusDataSchema,
  ApplyStatus,
  isApplyStatusTerminal,
  isRegistrationComplete,
  registerATokenDataSchema,
  type ApplyStatusValue,
} from './schemas.js';

export {
  attestEligibility,
  evidenceHashOf,
  isComplianceDecision,
  type AttestationClock,
  type AttestationRequest,
  type AttestationSigner,
  type AttestationSubject,
  type SignedAttestation,
} from './compliance.js';

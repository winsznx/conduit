import { z } from 'zod';

/**
 * Response schemas. PRD 9.3 step 3.
 *
 * Every response is validated before its `code` is read. That ordering is the
 * point: a body whose shape is unknown cannot be interpreted, and the failure
 * mode of interpreting it anyway is a compliance rejection that reads as a pass.
 */

/**
 * The envelope every endpoint returns.
 *
 * `data` stays `unknown` here. It is narrowed per endpoint only after `code` has
 * been checked, so a caller cannot reach a `data` field on a response that never
 * completed.
 */
export const envelopeSchema = z.object({
  code: z.string(),
  message: z.string().default(''),
  data: z.unknown().optional(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

/** An encrypted response body: `{ "data": "<base64 ciphertext>" }`. */
export const encryptedEnvelopeSchema = z.object({
  data: z.string().min(1),
});

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte hex address');

const unixSeconds = z.number().int().nonnegative();

/** `POST /query_apass`. Fields per PRD 2.1. */
export const queryApassDataSchema = z.object({
  status: z.number().int(),
  expirationTime: unixSeconds,
  tier: z.number().int().nonnegative(),
  subTier: z.number().int().nonnegative(),
  group: z.string(),
  subGroup: z.string(),
  currentKycHash: z.string(),
  countries: z.array(z.string()).default([]),
});

export type QueryApassData = z.infer<typeof queryApassDataSchema>;

/** `POST /verify_apass`. The inner `code` is the eligibility answer, 1 through 4. */
export const verifyApassDataSchema = z.object({
  code: z.number().int(),
  message: z.string().default(''),
});

export type VerifyApassData = z.infer<typeof verifyApassDataSchema>;

/**
 * `POST /validator/verify`.
 *
 * `valid: false` arrives alongside envelope `code: "0000"`. PRD 2.2 is explicit
 * that this is a legitimate non-eligibility decision and not an API failure,
 * which is why `valid` is required rather than defaulted: a missing field must
 * fail the schema instead of silently becoming `false` or `true`.
 */
export const validatorVerifyDataSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
});

export type ValidatorVerifyData = z.infer<typeof validatorVerifyDataSchema>;

/** `POST /validator/is_register`. */
export const validatorIsRegisterDataSchema = z.object({
  registered: z.boolean(),
});

/** `POST /validator/is_paused`. */
export const validatorIsPausedDataSchema = z.object({
  paused: z.boolean(),
});

/**
 * `POST /validator/rules`.
 *
 * PRD 9.6: "The application copies no hidden interpretation. The persisted
 * policy is the normalized response returned by Cleanverse." The v1.1 override
 * adds that `is_black_list` is deprecated under RuleV2 while the compatibility
 * API may still return it, and that legacy country arrays must not be
 * reinterpreted into bit positions locally — so both are captured verbatim and
 * neither is transformed here.
 */
export const validatorRuleSchema = z.object({
  allowed_group: z.string().optional(),
  allowed_sub_group: z.string().optional(),
  min_tier: z.number().int().nonnegative().optional(),
  min_sub_tier: z.number().int().nonnegative().optional(),
  is_black_list: z.boolean().optional(),
  countries: z.array(z.string()).optional(),
});

export const validatorRulesDataSchema = z.object({
  rules: z.array(validatorRuleSchema).default([]),
});

export type ValidatorRule = z.infer<typeof validatorRuleSchema>;

/** A write that lands on-chain returns the transaction to wait for. PRD 9.4. */
export const validatorWriteDataSchema = z.object({
  tx_hash: z.string().min(1),
});

/** `POST /query_deposit_atoken_list`. PRD 2.4: addresses are discovered, never hardcoded. */
export const depositATokenSchema = z.object({
  origin_token_address: address,
  origin_token_symbol: z.string(),
  origin_token_decimals: z.number().int().min(0).max(255),
  atoken_address: address,
  atoken_symbol: z.string(),
  atoken_decimals: z.number().int().min(0).max(255),
  accesscore_address: address,
  apass_address: address,
});

export const depositATokenListDataSchema = z.object({
  list: z.array(depositATokenSchema).default([]),
});

export type DepositAToken = z.infer<typeof depositATokenSchema>;

/** `POST /query_txs`. PRD FR-013 evidence ingestion. */
export const transactionRecordSchema = z.object({
  tx_hash: z.string(),
  from: z.string(),
  to: z.string(),
  amount: z.string(),
  token_address: z.string().optional(),
  timestamp: unixSeconds.optional(),
});

export const queryTxsDataSchema = z.object({
  list: z.array(transactionRecordSchema).default([]),
});

/** `POST /download_travel_rule`. PRD 9.7 forbids mislabelling the result. */
export const downloadReportDataSchema = z.object({
  url: z.url(),
  expires_at: unixSeconds.optional(),
});

export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length === 0 ? issue.message : `${path}: ${issue.message}`;
  });
}

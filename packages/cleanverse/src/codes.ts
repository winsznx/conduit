/**
 * Cleanverse response codes and what they actually mean. PRD 9.3.
 *
 * The whole point of this file is that `response.ok` is never the business
 * success condition. Every constant below exists so no caller has to remember
 * that, and so the difference between "the call failed" and "the call succeeded
 * and the answer is no" is impossible to blur.
 */

/** Envelope-level `code`, present on every response. */
export const ApiCode = {
  /** The API operation completed. Says nothing about the business answer. */
  OK: '0000',
  /** Parameter or signature failure. Never retry unchanged; the request is wrong. */
  PARAMETER_OR_SIGNATURE: '0001',
  /** Business failure. Inspect `message`. */
  BUSINESS: '0002',
  /** Validator write failure. */
  VALIDATOR_WRITE_FAILED: '12026',
  /** Validator read failure, including a paused pool. */
  VALIDATOR_READ_FAILED: '12027',
} as const;

export type ApiCodeValue = (typeof ApiCode)[keyof typeof ApiCode];

/**
 * `POST /verify_apass` result codes. PRD 2.2.
 *
 * Only `4` permits a transfer. CLAUDE.md states it as an invariant:
 * "`verify_apass` requires result code 4."
 */
export const VerifyApassCode = {
  ATOKEN_NOT_FOUND: 1,
  NO_APASS: 2,
  /** An A-Pass exists but transfer is disallowed: expired or frozen. */
  TRANSFER_DISALLOWED: 3,
  /** The only value that authorizes a transfer. */
  ALLOWED: 4,
} as const;

export type VerifyApassCodeValue = (typeof VerifyApassCode)[keyof typeof VerifyApassCode];

/** Native A-Pass status. PRD 2.1 exposes exactly these two. */
export const ApassStatus = {
  ACTIVE: 1,
  FROZEN: 2,
} as const;

export function isApiOk(code: string): boolean {
  return code === ApiCode.OK;
}

/**
 * Whether a failed call may be retried at all.
 *
 * A parameter or signature failure is deterministic: the same request produces
 * the same rejection, so retrying only burns rate limit. A validator read
 * failure may be a paused pool, which can un-pause, so it is retryable under
 * policy — but a paused pool is still not eligibility, and the caller has to
 * fail closed if the retries run out.
 */
export function isRetryableApiCode(code: string): boolean {
  return code === ApiCode.VALIDATOR_READ_FAILED;
}

/**
 * PRD 2.2: "Conduit uses this for every proposed CVA payer, recipient, return
 * address, and substitute receiver."
 */
export function verifyApassAllowsTransfer(code: number): boolean {
  return code === VerifyApassCode.ALLOWED;
}

export function describeVerifyApassCode(code: number): string {
  switch (code) {
    case VerifyApassCode.ATOKEN_NOT_FOUND:
      return 'A-Token not found';
    case VerifyApassCode.NO_APASS:
      return 'wallet has no A-Pass';
    case VerifyApassCode.TRANSFER_DISALLOWED:
      return 'A-Pass exists but transfer is disallowed because it is expired or frozen';
    case VerifyApassCode.ALLOWED:
      return 'valid A-Pass and transfer is allowed';
    default:
      return `undocumented verify_apass code ${String(code)}`;
  }
}

/**
 * Policy refusals the gateway reports through the *error* envelope.
 *
 * `verify_apass` answers a permitted transfer with envelope `0000` and inner
 * code 4. It answers a refusal the on-chain policy computed with envelope
 * `0002` and a message carrying the policy's own custom error, observed live:
 *
 * ```text
 *   Failed to validate atoken: failed to check apass: custom err name
 *   TierTooLow, revert data: 0x9742a8f1…83c130ed…0015…0014
 * ```
 *
 * That is a decision — the subject holds tier 20 and the pool now requires 21 —
 * arriving down the channel reserved for failures. Treating it as an outage
 * would make a real refusal look like a retryable fault and fail *open* on the
 * retry; treating every `0002` as a refusal would turn a genuine outage into a
 * signed compliance judgement nobody made. So the markers are named
 * individually, and anything not on this list still throws.
 *
 * PRD 2.2 makes non-eligibility a legitimate answer rather than an error, and
 * this is the shape it actually takes on the wire.
 */
export const POLICY_REFUSAL_MARKERS: readonly string[] = Object.freeze([
  'TierTooLow',
  'SubTierTooLow',
  'GroupNotAllowed',
  'SubGroupNotAllowed',
  'CountryNotAllowed',
  'BlackListed',
  'ComplianceFailed',
  'NoAPass',
  'TransferNotAllowed',
]);

/**
 * Whether a gateway error message carries a policy decision rather than a fault.
 *
 * @returns the marker that matched, so the caller can record which refusal it
 *          was rather than only that there was one.
 */
export function policyRefusalIn(message: string): string | undefined {
  return POLICY_REFUSAL_MARKERS.find((marker) =>
    message.toLowerCase().includes(marker.toLowerCase()),
  );
}

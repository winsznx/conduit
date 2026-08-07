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

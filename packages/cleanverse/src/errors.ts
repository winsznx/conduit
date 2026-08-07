/**
 * Cleanverse error taxonomy.
 *
 * The distinction that matters most here is not error-versus-success. It is
 * *transport failure* versus *business answer*. PRD 9.3 and CLAUDE.md are
 * explicit: an HTTP 200 is not automatically business success, and a
 * `validator/verify` result of `valid: false` is a legitimate non-eligibility
 * decision rather than an API failure.
 *
 * Collapsing those two into one "error" type is threat T-06, response-code
 * confusion, and it fails in the dangerous direction: a compliance rejection
 * that looks like an outage invites a retry, and a retry that eventually
 * succeeds looks like eligibility.
 *
 * So: non-eligibility is never an exception. It is a value the caller must
 * inspect. Only transport, schema, and protocol faults throw.
 *
 * Fields are declared explicitly rather than as constructor parameter
 * properties, because `erasableSyntaxOnly` keeps this source runnable under
 * type stripping with no build step.
 */

export class CleanverseError extends Error {
  public override readonly name: string = 'CleanverseError';
  public readonly requestId: string | undefined;

  public constructor(message: string, requestId?: string) {
    super(requestId === undefined ? message : `${message} (X-Request-ID: ${requestId})`);
    this.requestId = requestId;
  }
}

/** AES layer fault. Never carries plaintext, ciphertext, or key material. */
export class CleanverseEncryptionError extends CleanverseError {
  public override readonly name = 'CleanverseEncryptionError';
}

/** Network failure, timeout, or non-2xx HTTP status. Retryable under policy. */
export class CleanverseTransportError extends CleanverseError {
  public override readonly name = 'CleanverseTransportError';
  public readonly httpStatus: number | undefined;

  public constructor(message: string, httpStatus: number | undefined, requestId?: string) {
    super(message, requestId);
    this.httpStatus = httpStatus;
  }
}

/**
 * The response did not match its schema.
 *
 * Always fatal, never retried. PRD 9.3 requires schema validation before `code`
 * is read, because a response whose shape is unknown cannot be interpreted at
 * all — and guessing is how a compliance failure becomes a silent pass.
 */
export class CleanverseSchemaError extends CleanverseError {
  public override readonly name = 'CleanverseSchemaError';
  public readonly endpoint: string;
  public readonly problems: readonly string[];

  public constructor(endpoint: string, problems: readonly string[], requestId?: string) {
    super(`response from ${endpoint} did not match its schema: ${problems.join('; ')}`, requestId);
    this.endpoint = endpoint;
    this.problems = problems;
  }
}

/**
 * The API reported that the operation itself did not complete: a `code` other
 * than `0000`.
 *
 * This is distinct from a completed call that returns an unfavourable business
 * answer. `validator/verify` returning `code: "0000"` with `data.valid: false`
 * does not raise this.
 */
export class CleanverseApiError extends CleanverseError {
  public override readonly name = 'CleanverseApiError';
  public readonly endpoint: string;
  public readonly code: string;
  public readonly apiMessage: string;

  public constructor(endpoint: string, code: string, apiMessage: string, requestId?: string) {
    super(`${endpoint} returned code ${code}: ${apiMessage}`, requestId);
    this.endpoint = endpoint;
    this.code = code;
    this.apiMessage = apiMessage;
  }
}

/**
 * A write was attempted while a prior write's on-chain transaction was still
 * unconfirmed.
 *
 * PRD 9.4: rule mutations wait for the returned transaction to confirm before
 * another mutation is issued. Two in flight can land out of order, and the
 * persisted policy would then describe neither state.
 */
export class CleanverseWriteInFlightError extends CleanverseError {
  public override readonly name = 'CleanverseWriteInFlightError';
  public readonly pendingTxHash: string;

  public constructor(pendingTxHash: string) {
    super(`a validator mutation is still unconfirmed: ${pendingTxHash}`);
    this.pendingTxHash = pendingTxHash;
  }
}

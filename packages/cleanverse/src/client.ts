import type { z } from 'zod';

import { normalizeApass, type NormalizedApass } from './apass.js';
import { ApiCode, isApiOk, isRetryableApiCode } from './codes.js';
import {
  CleanverseApiError,
  CleanverseSchemaError,
  CleanverseTransportError,
  CleanverseWriteInFlightError,
} from './errors.js';
import { type CleanverseCipher, encryptRequestBody } from './encryption.js';
import { ENDPOINTS, type EndpointDefinition, type EndpointName } from './endpoints.js';
import { hashRawBody, redact } from './redact.js';
import {
  depositATokenListDataSchema,
  describeIssues,
  encryptedEnvelopeSchema,
  envelopeSchema,
  queryApassDataSchema,
  validatorIsPausedDataSchema,
  validatorIsRegisterDataSchema,
  validatorRulesDataSchema,
  validatorVerifyDataSchema,
  verifyApassDataSchema,
} from './schemas.js';

/**
 * The server-only Cleanverse client. PRD 9.
 *
 * Every response passes through the same five steps in the order PRD 9.3 fixes:
 * check HTTP status, parse JSON, validate the schema, check `code`, then
 * interpret the endpoint-specific business data. No caller may shortcut to step
 * five, and `response.ok` is never the business-success condition.
 */

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface CleanverseClientOptions {
  readonly baseUrl: string;
  readonly apiId: string;
  readonly cipher: CleanverseCipher;
  readonly timeoutMs: number;
  readonly maxReadRetries: number;
  /**
   * PRD 9 does not state the authentication header name. It is configurable and
   * tracked as ASM-024 until the live sandbox confirms it.
   */
  readonly apiIdHeader?: string;
  readonly fetch?: Fetcher;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

export interface CleanverseResult<T> {
  readonly endpoint: EndpointName;
  readonly path: string;
  /** PRD 9.4: generated per request, echoed in errors, persisted with the response hash. */
  readonly requestId: string;
  readonly code: string;
  readonly message: string;
  readonly data: T;
  /** SHA-256 of the raw bytes, taken before redaction. */
  readonly responseHash: `0x${string}`;
  /** Safe to persist and log. The raw body is not. */
  readonly redactedBody: unknown;
  readonly receivedAt: number;
  readonly attempts: number;
}

const DEFAULT_API_ID_HEADER = 'api-id';
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 4_000;

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CleanverseClient {
  private readonly baseUrl: string;
  private readonly apiId: string;
  private readonly apiIdHeader: string;
  private readonly cipher: CleanverseCipher;
  private readonly timeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly fetchImpl: Fetcher;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;

  /**
   * PRD 9.4: a validator mutation returns a transaction hash, and another
   * mutation may not be issued until it confirms. Held here rather than in a
   * caller so the rule cannot be forgotten at one call site.
   */
  private pendingMutationTxHash: string | undefined;

  public constructor(options: CleanverseClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiId = options.apiId;
    this.apiIdHeader = options.apiIdHeader ?? DEFAULT_API_ID_HEADER;
    this.cipher = options.cipher;
    this.timeoutMs = options.timeoutMs;
    this.maxReadRetries = options.maxReadRetries;
    this.fetchImpl = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = options.now ?? ((): number => Date.now());
    this.randomUUID = options.randomUUID ?? ((): string => crypto.randomUUID());
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? ((): number => Math.random());
  }

  /** The transaction a prior mutation is waiting on, if any. */
  public get pendingMutation(): string | undefined {
    return this.pendingMutationTxHash;
  }

  /**
   * Records that the pending mutation's transaction has confirmed on-chain.
   *
   * The client cannot observe confirmation itself — that is an RPC concern — so
   * the caller reports it, and until then further mutations are refused.
   */
  public confirmMutation(): void {
    this.pendingMutationTxHash = undefined;
  }

  public async call<T>(
    name: EndpointName,
    payload: Record<string, unknown>,
    dataSchema: z.ZodType<T>,
  ): Promise<CleanverseResult<T>> {
    const endpoint = ENDPOINTS[name];

    if (endpoint.kind === 'write' && this.pendingMutationTxHash !== undefined) {
      throw new CleanverseWriteInFlightError(this.pendingMutationTxHash);
    }

    const result = await this.execute(name, endpoint, payload, dataSchema);

    if (endpoint.awaitsChainConfirmation) {
      const txHash = (result.data as { tx_hash?: unknown }).tx_hash;
      if (typeof txHash === 'string' && txHash.length > 0) {
        this.pendingMutationTxHash = txHash;
      }
    }

    return result;
  }

  private async execute<T>(
    name: EndpointName,
    endpoint: EndpointDefinition,
    payload: Record<string, unknown>,
    dataSchema: z.ZodType<T>,
  ): Promise<CleanverseResult<T>> {
    // PRD 9.4: reads may retry network errors and 5xx with jitter. Writes are
    // never blind-retried, so their budget is zero attempts beyond the first.
    const maxAttempts = endpoint.kind === 'read' ? this.maxReadRetries + 1 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.attempt(name, endpoint, payload, dataSchema, attempt);
      } catch (error) {
        lastError = error;

        if (attempt === maxAttempts || !this.isRetryable(error, endpoint)) {
          throw error;
        }

        await this.sleep(this.backoffFor(attempt));
      }
    }

    throw lastError;
  }

  private isRetryable(error: unknown, endpoint: EndpointDefinition): boolean {
    if (endpoint.kind !== 'read') return false;

    if (error instanceof CleanverseTransportError) {
      // A 4xx is deterministic; repeating it only burns rate limit.
      return error.httpStatus === undefined || error.httpStatus >= 500;
    }

    // A paused validator pool can un-pause. It is still not eligibility, and a
    // caller that exhausts the budget must fail closed.
    if (error instanceof CleanverseApiError) {
      return isRetryableApiCode(error.code);
    }

    // Schema faults are deterministic and never retried.
    return false;
  }

  private backoffFor(attempt: number): number {
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    return Math.floor(exponential * (0.5 + this.random() * 0.5));
  }

  private async attempt<T>(
    name: EndpointName,
    endpoint: EndpointDefinition,
    payload: Record<string, unknown>,
    dataSchema: z.ZodType<T>,
    attempt: number,
  ): Promise<CleanverseResult<T>> {
    const requestId = this.randomUUID();
    const url = `${this.baseUrl}${endpoint.path}`;

    const body = endpoint.encrypted ? await encryptRequestBody(this.cipher, payload) : payload;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Request-ID': requestId,
          [this.apiIdHeader]: this.apiId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      throw new CleanverseTransportError(
        `${endpoint.path} request failed: ${reason}`,
        undefined,
        requestId,
      );
    }

    // Step 1 of PRD 9.3. A non-2xx never reaches the body parser.
    if (!response.ok) {
      throw new CleanverseTransportError(
        `${endpoint.path} returned HTTP ${String(response.status)}`,
        response.status,
        requestId,
      );
    }

    const rawBody = await response.text();
    const responseHash = await hashRawBody(rawBody);

    // Step 2.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new CleanverseSchemaError(endpoint.path, ['body is not valid JSON'], requestId);
    }

    // An encrypted response carries the real envelope inside `data`.
    const decrypted = await this.unwrapIfEncrypted(parsed, endpoint, requestId);

    // Step 3.
    const envelope = envelopeSchema.safeParse(decrypted);
    if (!envelope.success) {
      throw new CleanverseSchemaError(endpoint.path, describeIssues(envelope.error), requestId);
    }

    // Step 4. Note that this is the *operation* completing, not the business
    // answer. `validator/verify` returning valid:false arrives here as 0000.
    if (!isApiOk(envelope.data.code)) {
      throw new CleanverseApiError(
        endpoint.path,
        envelope.data.code,
        envelope.data.message,
        requestId,
      );
    }

    // Step 5.
    const data = dataSchema.safeParse(envelope.data.data);
    if (!data.success) {
      throw new CleanverseSchemaError(endpoint.path, describeIssues(data.error), requestId);
    }

    return {
      endpoint: name,
      path: endpoint.path,
      requestId,
      code: envelope.data.code,
      message: envelope.data.message,
      data: data.data,
      responseHash,
      redactedBody: redact(decrypted),
      receivedAt: this.now(),
      attempts: attempt,
    };
  }

  private async unwrapIfEncrypted(
    parsed: unknown,
    endpoint: EndpointDefinition,
    requestId: string,
  ): Promise<unknown> {
    if (!endpoint.encrypted) return parsed;

    // Some encrypted endpoints answer in clear text when the operation failed
    // before the payload was built, so an unwrappable body is not an error by
    // itself — only an unparseable one is.
    const wrapper = encryptedEnvelopeSchema.safeParse(parsed);
    if (!wrapper.success) return parsed;

    const plaintext = await this.cipher.decrypt(wrapper.data.data);
    try {
      return JSON.parse(plaintext);
    } catch {
      throw new CleanverseSchemaError(
        endpoint.path,
        ['decrypted body is not valid JSON'],
        requestId,
      );
    }
  }

  // ── Typed endpoint wrappers ───────────────────────────────────────────────
  // Each one exists so a caller cannot pass the wrong schema to `call`, and so
  // the business interpretation lives next to the endpoint it belongs to.

  /** PRD 2.4: the cash token is discovered here, never hardcoded. */
  public async queryDepositATokenList(chain: string) {
    return this.call('queryDepositATokenList', { chain }, depositATokenListDataSchema);
  }

  /**
   * PRD 2.1. Returns the normalized status alongside the raw record.
   *
   * A wallet with no A-Pass is `MISSING`, which is a business answer rather than
   * an error, so the caller receives it as data.
   */
  public async queryApass(
    chain: string,
    wallet: string,
    options: { now: number; warningWindowSeconds: number },
  ): Promise<{ result: CleanverseResult<unknown>; normalized: NormalizedApass }> {
    const result = await this.call(
      'queryApass',
      { chain, address: wallet },
      queryApassDataSchema.optional(),
    );

    return {
      result,
      normalized: normalizeApass(result.data, options),
    };
  }

  /** PRD 2.2. Only inner code 4 authorizes a transfer. */
  public async verifyApass(chain: string, wallet: string, atokenAddress: string) {
    return this.call(
      'verifyApass',
      { chain, address: wallet, atoken_address: atokenAddress },
      verifyApassDataSchema,
    );
  }

  /**
   * PRD 2.2. A successful call returns `code: "0000"` even when `data.valid` is
   * false, and that is a compliance decision rather than a fault.
   */
  public async validatorVerify(chain: string, poolAddress: string, wallet: string) {
    return this.call(
      'validatorVerify',
      { chain, pool_address: poolAddress, address: wallet },
      validatorVerifyDataSchema,
    );
  }

  public async validatorIsRegister(chain: string, contractAddress: string) {
    return this.call(
      'validatorIsRegister',
      { chain, contract_address: contractAddress },
      validatorIsRegisterDataSchema,
    );
  }

  public async validatorIsPaused(chain: string, poolAddress: string) {
    return this.call(
      'validatorIsPaused',
      { chain, pool_address: poolAddress },
      validatorIsPausedDataSchema,
    );
  }

  /** PRD 9.6: the persisted policy is the normalized response, uninterpreted. */
  public async validatorRules(chain: string, poolAddress: string) {
    return this.call(
      'validatorRules',
      { chain, pool_address: poolAddress },
      validatorRulesDataSchema,
    );
  }
}

export { ApiCode };

import { z } from 'zod';

import { ConfigError } from './errors.js';

/**
 * Environment validation, run once at process start.
 *
 * Two rules shape this file. CLAUDE.md requires validation at startup, so a
 * missing credential fails before any settlement code runs rather than at the
 * first Cleanverse call. And PRD 9.1 forbids a secret reaching a log, so nothing
 * here ever formats a value into an error — zod's default messages would happily
 * print the string that failed a pattern.
 */

const base64 = z
  .string()
  .min(1)
  .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value), 'must be base64');

const httpsUrl = z.url().refine((value) => value.startsWith('https://'), 'must be https');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

/**
 * PRD 9.1 fixes these five names. The AES key is base64 because Cleanverse
 * distributes it that way and PRD 9.2 decodes it before use.
 */
const cleanverseSchema = z.object({
  CLEANVERSE_BASE_URL: httpsUrl,
  CLEANVERSE_API_ID: z.string().min(1),
  CLEANVERSE_API_KEY_BASE64: base64,
  CLEANVERSE_REQUEST_TIMEOUT_MS: positiveInt(15_000),
  CLEANVERSE_MAX_READ_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
});

const runtimeSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const rpcSchema = z.object({
  MONAD_TESTNET_RPC_URL: z.url(),
  BASE_SEPOLIA_RPC_URL: z.url(),
});

export type CleanverseEnv = z.infer<typeof cleanverseSchema>;
export type RuntimeEnv = z.infer<typeof runtimeSchema>;
export type RpcEnv = z.infer<typeof rpcSchema>;

export type EnvSource = Record<string, string | undefined>;

/**
 * Reports which variable failed and why, never what it contained.
 */
function describe(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    return issue.code === 'invalid_type' && issue.input === undefined
      ? `${name} is required`
      : `${name}: ${issue.message}`;
  });
}

/**
 * An environment variable that is present but empty is absent.
 *
 * `.env` files written from the committed template carry `KEY=` lines, and
 * Node's `--env-file` loads those as empty strings rather than omitting them.
 * zod applies a `.default()` only for `undefined`, and `z.coerce.number()` turns
 * `''` into `0`, so an untouched template value failed validation as "too
 * small" instead of quietly taking its documented default.
 *
 * Dropping empty values makes the two cases identical, which is what an operator
 * already assumes when they leave a line blank.
 */
function withoutEmpty(source: EnvSource): EnvSource {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );
}

function parse<T>(schema: z.ZodType<T>, source: EnvSource, label: string): T {
  const result = schema.safeParse(withoutEmpty(source));
  if (!result.success) {
    throw new ConfigError(`invalid ${label} configuration`, describe(result.error));
  }
  return result.data;
}

export function loadRuntimeEnv(source: EnvSource = process.env): RuntimeEnv {
  return parse(runtimeSchema, source, 'runtime');
}

export function loadCleanverseEnv(source: EnvSource = process.env): CleanverseEnv {
  return parse(cleanverseSchema, source, 'Cleanverse');
}

export function loadRpcEnv(source: EnvSource = process.env): RpcEnv {
  return parse(rpcSchema, source, 'RPC');
}

/**
 * The Cleanverse variables that have no default and must be supplied.
 *
 * The other two are tuning values with documented defaults, so reporting them
 * alongside a genuinely absent credential buries the thing an operator has to
 * act on.
 */
export const REQUIRED_CLEANVERSE_VARS = Object.freeze([
  'CLEANVERSE_BASE_URL',
  'CLEANVERSE_API_ID',
  'CLEANVERSE_API_KEY_BASE64',
] as const);

export interface CredentialPresence {
  readonly name: string;
  readonly required: boolean;
  readonly configured: boolean;
  readonly length: number;
}

/**
 * Presence check for a doctor report or a health endpoint.
 *
 * Returns a boolean and a length, which is what the one-shot brief permits:
 * enough to prove a credential is configured, never enough to reconstruct it.
 */
export function credentialPresence(source: EnvSource = process.env): CredentialPresence[] {
  const required = new Set<string>(REQUIRED_CLEANVERSE_VARS);

  return Object.keys(cleanverseSchema.shape).map((name) => {
    const value = source[name];
    return {
      name,
      required: required.has(name),
      configured: value !== undefined && value.length > 0,
      length: value?.length ?? 0,
    };
  });
}

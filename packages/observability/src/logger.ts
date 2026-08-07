import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Structured logging. PRD 16.4.
 *
 * The allowed fields are settlement ID, request ID, chain ID, and transaction
 * hash. Wallet addresses are permitted where operationally required and are
 * classified as pseudonymous identifiers.
 *
 * The forbidden list is absolute: private keys, the Cleanverse API key, raw PII,
 * raw bank details, and any decrypted Cleanverse payload. Redaction here is a
 * backstop rather than the primary control — callers pass
 * `@conduit-protocol/cleanverse`'s redacted view, and this catches the case
 * where somebody forgets.
 */

/**
 * Redaction paths.
 *
 * pino redacts by path, so wildcards cover the shapes these values actually
 * arrive in: top level, inside `err`, and one level down under any key.
 */
const REDACT_PATHS = [
  'apiKey',
  'api_key',
  'apiKeyBase64',
  'CLEANVERSE_API_KEY_BASE64',
  'privateKey',
  'private_key',
  'mnemonic',
  'seedPhrase',
  'secret',
  'password',
  'quoteToken',
  'signature',
  'ownerSignature',
  'plaintext',
  'ciphertext',
  'decrypted',
  'rawBody',
  'bankAccount',
  'accountNumber',
  'iban',
  'email',
  'phone',
  'firstName',
  'lastName',
  'dateOfBirth',
  'nationalId',
].flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

export interface LoggerConfig {
  readonly level: NonNullable<LoggerOptions['level']>;
  readonly service: string;
  readonly environment: string;
  /** Pretty output is never used in staging or production; JSON is the contract. */
  readonly pretty?: boolean;
}

export function createLogger(config: LoggerConfig): Logger {
  return pino({
    level: config.level,
    base: { service: config.service, environment: config.environment },
    // PRD: all timestamps are UTC.
    timestamp: (): string => `,"time":"${new Date().toISOString()}"`,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label): { level: string } => ({ level: label }),
    },
  });
}

/**
 * The correlation fields every settlement log line should carry when it has
 * them. Typed so a caller cannot invent a fifth spelling of `settlementId`.
 */
export interface SettlementLogContext {
  readonly settlementId?: `0x${string}`;
  readonly requestId?: string;
  readonly chainId?: number;
  readonly txHash?: `0x${string}`;
  readonly wallet?: `0x${string}`;
}

export function withSettlement(logger: Logger, context: SettlementLogContext): Logger {
  return logger.child(context);
}

export type { Logger };

/**
 * @conduit-protocol/observability
 *
 * OpenTelemetry tracing, metrics, and redaction-safe structured logging.
 *
 * PRD 16.4 forbids private keys, the Cleanverse API key, raw PII, raw bank
 * details, and decrypted Cleanverse payloads from ever reaching a log. Wallet
 * addresses are permitted as pseudonymous identifiers.
 */

export const PACKAGE_ID = '@conduit-protocol/observability';

export const IMPLEMENTATION_PHASE = '06';

export {
  createLogger,
  withSettlement,
  type Logger,
  type LoggerConfig,
  type SettlementLogContext,
} from './logger.js';

export {
  ALERT_CONDITIONS,
  AlertCondition,
  METRIC_NAMES,
  Metric,
  type AlertConditionName,
  type MetricName,
} from './metrics.js';

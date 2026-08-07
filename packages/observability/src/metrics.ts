/**
 * Metric names. PRD 16.2 fixes this list exactly.
 *
 * They live as constants because a metric renamed in one service and not another
 * produces a dashboard that looks healthy and an alert that never fires.
 */
export const Metric = {
  cleanverseRequestLatency: 'cleanverse_request_latency',
  cleanverseBusinessFailures: 'cleanverse_business_failures',
  cleanverseVerifyInvalid: 'cleanverse_verify_invalid',
  cleanverseVerifyUnknown: 'cleanverse_verify_unknown',
  complianceAttestationAge: 'compliance_attestation_age',
  settlementStateTotal: 'settlement_state_total',
  settlementTimeToReady: 'settlement_time_to_ready',
  settlementTimeToCommit: 'settlement_time_to_commit',
  settlementTimeToTerminal: 'settlement_time_to_terminal',
  vaaFetchLatency: 'vaa_fetch_latency',
  vaaSubmitFailures: 'vaa_submit_failures',
  vaaReplayRejections: 'vaa_replay_rejections',
  heldValueByAsset: 'held_value_by_asset',
  dispositionCaseAge: 'disposition_case_age',
  rpcProviderDisagreement: 'rpc_provider_disagreement',
  indexerLagBlocks: 'indexer_lag_blocks',
  outboxJobAge: 'outbox_job_age',
  reportDownloadFailures: 'report_download_failures',
} as const;

export type MetricName = (typeof Metric)[keyof typeof Metric];

export const METRIC_NAMES: readonly MetricName[] = Object.freeze(Object.values(Metric));

/**
 * Alert conditions. PRD 16.3.
 *
 * Thresholds are deliberately absent: they belong to an environment, and phase
 * 09 sets them against measured staging behaviour rather than guesses.
 */
export const AlertCondition = {
  valueHeldAboveThreshold: 'value_held_above_threshold',
  settlementStuckBeyondSla: 'settlement_stuck_beyond_sla',
  complianceSignerQuorumUnavailable: 'compliance_signer_quorum_unavailable',
  cleanverseErrorRateSpike: 'cleanverse_error_rate_spike',
  wormholeVaaUnavailable: 'wormhole_vaa_unavailable',
  chainCursorLag: 'chain_cursor_lag',
  databaseOutboxBacklog: 'database_outbox_backlog',
  contractPause: 'contract_pause',
  signerSetChange: 'signer_set_change',
  emitterConfigurationChange: 'emitter_configuration_change',
  balanceAccountingMismatch: 'balance_accounting_mismatch',
  publicVerifierDisagreement: 'public_verifier_disagreement',
} as const;

export type AlertConditionName = (typeof AlertCondition)[keyof typeof AlertCondition];

export const ALERT_CONDITIONS: readonly AlertConditionName[] = Object.freeze(
  Object.values(AlertCondition),
);

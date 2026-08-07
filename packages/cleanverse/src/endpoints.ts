/**
 * The endpoint map. PRD 9.5.
 *
 * Each entry records two things the client cannot infer: whether the body is
 * encrypted, and whether the call is a read or a write. The read/write flag is
 * not documentation — it drives retry policy, and PRD 9.4 makes that a safety
 * property rather than a performance one. Reads may retry; writes may not be
 * blind-retried, because a retried mutation that already landed produces two.
 */

export type EndpointKind = 'read' | 'write';

export interface EndpointDefinition {
  readonly path: string;
  readonly kind: EndpointKind;
  readonly encrypted: boolean;
  /** True when the response returns a `tx_hash` that must confirm before the next mutation. */
  readonly awaitsChainConfirmation: boolean;
}

function read(path: string, encrypted = true): EndpointDefinition {
  return { path, kind: 'read', encrypted, awaitsChainConfirmation: false };
}

function write(path: string, awaitsChainConfirmation: boolean): EndpointDefinition {
  return { path, kind: 'write', encrypted: true, awaitsChainConfirmation };
}

export const ENDPOINTS = Object.freeze({
  // Discovery and identity
  queryDepositATokenList: read('/query_deposit_atoken_list'),
  queryApass: read('/query_apass'),
  queryApassList: read('/query_apass_list'),
  verifyApass: read('/verify_apass'),
  queryDepositAddress: read('/query_deposit_address'),
  queryInstitutionWhiteList: read('/query_institution_white_list'),

  // Validator
  validatorGrant: write('/validator/grant', true),
  validatorRegister: write('/validator/register', true),
  validatorIsRegister: read('/validator/is_register'),
  validatorSetRule: write('/validator/set_rule', true),
  validatorAddRule: write('/validator/add_rule', true),
  validatorRemoveRule: write('/validator/remove_rule', true),
  validatorRules: read('/validator/rules'),
  validatorVerify: read('/validator/verify'),
  validatorSetPaused: write('/validator/set_paused', true),
  validatorIsPaused: read('/validator/is_paused'),

  // Evidence
  queryTxs: read('/query_txs'),
  queryInstitutionTxs: read('/query_institution_txs'),
  downloadTravelRule: read('/download_travel_rule'),

  // Sandbox. PRD 9.5: update_status is allowed only in the isolated demo/admin
  // harness and is never exposed to ordinary users.
  faucet: write('/faucet', false),
  updateStatus: write('/update_status', false),

  // Ramp
  queryRampCountries: read('/query_ramp_countries'),
  queryRampFiatCurrencies: read('/query_ramp_fiat_currencies'),
  queryRampCryptoCurrencies: read('/query_ramp_crypto_currencies'),
  queryRampPaymentMethods: read('/query_ramp_payment_methods'),
  queryRampQuote: read('/query_ramp_quote'),
  createRampWidgetUrl: write('/create_ramp_widget_url', false),
  queryRampOrder: read('/query_ramp_order'),
}) satisfies Readonly<Record<string, EndpointDefinition>>;

export type EndpointName = keyof typeof ENDPOINTS;

/**
 * Endpoints that must never be reachable from an ordinary user-facing path.
 * PRD 9.5 restricts `update_status` to the demo and admin harness.
 */
export const ADMIN_ONLY_ENDPOINTS: ReadonlySet<EndpointName> = new Set<EndpointName>([
  'updateStatus',
]);

export function isAdminOnly(name: EndpointName): boolean {
  return ADMIN_ONLY_ENDPOINTS.has(name);
}

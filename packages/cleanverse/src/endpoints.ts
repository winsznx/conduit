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

/**
 * Whether a body is AES-encrypted is per endpoint, not global.
 *
 * PRD 9.2 says "for documented encrypted endpoints", and an earlier version of
 * this file read that as "all of them". It is not. Every endpoint below marked
 * plaintext was verified against the live sandbox on 2026-08-07: an encrypted
 * body reached the server, failed to parse, and the endpoint reported its
 * required fields as missing — which reads exactly like a client sending the
 * wrong field names, and cost real time to distinguish.
 *
 * Worse, the endpoints that appeared to work encrypted were silently ignoring
 * the entire body. `query_deposit_atoken_list` looked like it ignored its
 * `chain` argument; in plaintext it filters correctly.
 *
 * An endpoint is only marked encrypted here with evidence that encryption is
 * what it wants.
 */

export interface EndpointDefinition {
  readonly path: string;
  readonly kind: EndpointKind;
  readonly encrypted: boolean;
  /** True when the response returns a `tx_hash` that must confirm before the next mutation. */
  readonly awaitsChainConfirmation: boolean;
}

/** Verified plaintext against the live sandbox. */
function read(path: string): EndpointDefinition {
  return { path, kind: 'read', encrypted: false, awaitsChainConfirmation: false };
}

/** Not yet verified either way; encryption is assumed until evidence says otherwise. */
function readEncrypted(path: string): EndpointDefinition {
  return { path, kind: 'read', encrypted: true, awaitsChainConfirmation: false };
}

function write(path: string, awaitsChainConfirmation: boolean): EndpointDefinition {
  return { path, kind: 'write', encrypted: true, awaitsChainConfirmation };
}

/** A mutation whose plaintext body the sandbox is observed to parse. */
function writePlain(path: string): EndpointDefinition {
  return { path, kind: 'write', encrypted: false, awaitsChainConfirmation: false };
}

export const ENDPOINTS = Object.freeze({
  // Discovery and identity
  queryDepositATokenList: read('/query_deposit_atoken_list'),
  queryApass: read('/query_apass'),
  queryApassList: read('/query_apass_list'),
  verifyApass: read('/verify_apass'),
  queryDepositAddress: readEncrypted('/query_deposit_address'),
  queryInstitutionWhiteList: read('/query_institution_white_list'),

  // CVA issuance. Method B registers an already-deployed custom contract; the
  // gateway validates `owner_signature` against the contract's owner before
  // forwarding the application, which is why ConduitRWACVA exposes `owner()`.
  registerAToken: write('/atoken/register_atoken', false),
  launchAToken: write('/atoken/launch', false),

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
  queryTxs: readEncrypted('/query_txs'),
  queryInstitutionTxs: readEncrypted('/query_institution_txs'),
  downloadTravelRule: readEncrypted('/download_travel_rule'),

  // Sandbox. PRD 9.5: update_status is allowed only in the isolated demo/admin
  // harness and is never exposed to ordinary users.
  faucet: write('/faucet', false),
  updateStatus: write('/update_status', false),

  // Ramp. Every one of these is plaintext, verified against the live sandbox on
  // 2026-08-08 (`docs/evidence/asm-010-fiat-ramp.json`). The assumed-encrypted
  // marking cost a diagnosis: `query_ramp_quote` reported all five of its
  // required fields as empty, in both camelCase and snake_case, including
  // `network` which is spelled identically either way. A field name cannot be
  // wrong in two conventions at once — that is a body the server never parsed,
  // and it is the same signature `query_deposit_atoken_list` showed.
  //
  // `create_ramp_widget_url` takes `wallet` as an object, not an address. Sent a
  // string it fails at the framework layer with a bare HTTP 400 and no business
  // code, which reads like an outage rather than a shape error.
  queryRampCountries: read('/query_ramp_countries'),
  queryRampFiatCurrencies: read('/query_ramp_fiat_currencies'),
  queryRampCryptoCurrencies: read('/query_ramp_crypto_currencies'),
  queryRampPaymentMethods: read('/query_ramp_payment_methods'),
  queryRampQuote: read('/query_ramp_quote'),
  createRampWidgetUrl: writePlain('/create_ramp_widget_url'),
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

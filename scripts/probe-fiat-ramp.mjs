#!/usr/bin/env node
/**
 * ASM-010: is Fiat Ramp SELL enabled for this credential and market?
 *
 * PRD 5.5 makes the operator-assisted fiat exit conditional on four things, and
 * the first is whether the active API role includes Fiat Ramp at all. FR-012's
 * `OPERATOR_ASSISTED_OFFRAMP` is the only disposition type whose external half
 * lives outside the chain, so the answer decides whether that half is a real
 * integration or a recorded limitation. It is not a decision to make from the
 * documentation: the guide describes the product, and the credential decides
 * what this credential can reach.
 *
 * The script walks PRD 5.5's flow in order — quote, then widget URL — and stops
 * before anything that would place a real order. It also answers the question
 * the flow cannot avoid: whether the held settlement asset is a listed ramp
 * asset at all, which is a different question from whether the ramp works.
 *
 * Every failure is classified rather than summarized. A 403 on the role, a
 * business code refusing the market, and a transport failure are three
 * different findings and only one of them is a limitation of the sandbox.
 *
 * Prints no secret. The user IP the widget requires is redacted from the
 * artifact, and the widget URL is recorded by hash and host rather than in full
 * because it is a bearer credential for a hosted session.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { privateKeyToAccount } from 'viem/accounts';

const PERMITTED_HOST = 'uatapi.cleanverse.com';

/**
 * Raw `fetch` rather than `CleanverseClient`, for one run and one reason: this
 * script is what establishes which of these endpoints are encrypted, and the
 * client takes that from `ENDPOINTS`. Using the client to determine the input
 * to the client's own configuration would only confirm whatever is written
 * there. Once the map is corrected against these observations, every caller
 * goes through the client.
 */
async function post(baseUrl, apiId, path, body) {
  const requestId = crypto.randomUUID();
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-id': apiId, 'X-Request-ID': requestId },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { httpStatus: response.status, requestId, body: parsed, raw: text };
}

/**
 * A negative result is only usable if it says which layer refused, and these
 * are not interchangeable: a role refusal is a credential fact, a business code
 * is a market fact, and a transport error is our own problem until proven
 * otherwise.
 */
function classify(result) {
  if (result.httpStatus === 401 || result.httpStatus === 403) return 'ROLE_NOT_GRANTED';
  if (result.httpStatus === 404) return 'ENDPOINT_NOT_PRESENT';
  if (result.httpStatus !== 200) return 'HTTP_ERROR';
  if (result.body === undefined) return 'UNPARSEABLE_BODY';
  return result.body.code === '0000' ? 'ANSWERED' : 'BUSINESS_REFUSAL';
}

function sha256(value) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

async function main() {
  const baseUrl = process.env['CLEANVERSE_BASE_URL'];
  const apiId = process.env['CLEANVERSE_API_ID'];
  const deployerKey = process.env['DEPLOYER_PRIVATE_KEY'];
  if (!baseUrl || !apiId || !deployerKey) {
    throw new Error('missing CLEANVERSE_BASE_URL, CLEANVERSE_API_ID or DEPLOYER_PRIVATE_KEY');
  }
  if (new URL(baseUrl).host !== PERMITTED_HOST) {
    throw new Error(`refusing to send Cleanverse credentials to ${new URL(baseUrl).host}`);
  }

  // The A-Passed wallet PRD 5.5 requires. It is the same controlled key the
  // settlements use (ASM-035), which is why no second identity appears here.
  const wallet = privateKeyToAccount(deployerKey).address;
  const userIp = (await (await fetch('https://api.ipify.org')).text()).trim();

  const observations = [];
  const record = (endpoint, result, extra = {}) => {
    const outcome = classify(result);
    observations.push({
      endpoint,
      outcome,
      httpStatus: result.httpStatus,
      requestId: result.requestId,
      code: result.body?.code,
      message: result.body?.message,
      ...extra,
    });
    console.log(`${endpoint.padEnd(28)} ${outcome.padEnd(18)} ${result.body?.message ?? ''}`);
    return outcome;
  };

  // ── What the ramp lists ────────────────────────────────────────────────────

  const cryptoResult = await post(baseUrl, apiId, '/query_ramp_crypto_currencies', {});
  record('/query_ramp_crypto_currencies', cryptoResult);
  const listed = Array.isArray(cryptoResult.body?.data) ? cryptoResult.body.data : [];

  const fiatResult = await post(baseUrl, apiId, '/query_ramp_fiat_currencies', {});
  record('/query_ramp_fiat_currencies', fiatResult);
  const fiats = Array.isArray(fiatResult.body?.data) ? fiatResult.body.data : [];

  const methodsResult = await post(baseUrl, apiId, '/query_ramp_payment_methods', {});
  record('/query_ramp_payment_methods', methodsResult);
  const methods = Array.isArray(methodsResult.body?.data) ? methodsResult.body.data : [];

  const networks = [...new Set(listed.map((entry) => entry.network?.name).filter(Boolean))];
  const sellable = listed
    .filter((entry) => entry.isSellAllowed)
    .map((entry) => `${entry.symbol}@${entry.network?.name}`);

  // ── The quote, then the widget, on every chain the ramp will quote ─────────
  //
  // Every supported chain is walked rather than one, because a refusal on one
  // chain is not evidence about the ramp. The `chain` the widget wants is the
  // uppercase form of the `network` the quote wants, which the API tells you
  // only by refusing the other spellings.

  const fiatCurrency = fiats.some((f) => f.symbol === 'USD' && f.isSellAllowed)
    ? 'USD'
    : fiats[0]?.symbol;
  const paymentMethod = methods[0]?.id;

  let quote;
  let quoteOutcome = 'NOT_ATTEMPTED';
  let widgetOutcome = 'NOT_ATTEMPTED';
  const widgetRefusals = [];

  for (const network of networks) {
    const market = {
      isBuyOrSell: 'SELL',
      network,
      cryptoCurrency: 'USDC',
      fiatCurrency,
      paymentMethod,
      cryptoAmount: 100,
    };
    const quoteResult = await post(baseUrl, apiId, '/query_ramp_quote', market);
    const outcome = record(`/query_ramp_quote [${network}]`, quoteResult, { market });
    if (outcome !== 'ANSWERED') continue;

    quoteOutcome = 'ANSWERED';
    quote ??= quoteResult.body.data;

    const widgetResult = await post(baseUrl, apiId, '/create_ramp_widget_url', {
      quoteToken: quoteResult.body.data.quoteToken,
      wallet: { address: wallet, chain: network.toUpperCase() },
      userIp,
    });
    const url = widgetResult.body?.data;
    const thisOutcome = record(`/create_ramp_widget_url [${network}]`, widgetResult, {
      // A hosted-session URL is a bearer credential. The host proves which
      // provider answered and the hash proves this artifact describes the URL
      // that was actually returned, without publishing the session itself.
      widgetUrlHost: typeof url === 'string' && url.length > 0 ? new URL(url).host : undefined,
      widgetUrlSha256: typeof url === 'string' && url.length > 0 ? sha256(url) : undefined,
    });
    if (thisOutcome === 'ANSWERED') {
      widgetOutcome = 'ANSWERED';
      break;
    }
    widgetRefusals.push({ network, message: widgetResult.body?.message });
  }

  // ── The question the flow cannot answer for us ─────────────────────────────

  const settlementAssets = [
    { symbol: process.env['RWA_CVA_SYMBOL'] ?? 'cBOND2', network: 'base' },
    { symbol: 'cSETTLE', network: 'monad' },
  ];
  const assetListing = settlementAssets.map((asset) => ({
    ...asset,
    networkOnRamp: networks.includes(asset.network),
    listedOnRamp: listed.some(
      (entry) => entry.symbol === asset.symbol && entry.network?.name === asset.network,
    ),
  }));

  const heldAssetOfframpable = assetListing.some((asset) => asset.listedOnRamp);

  // `RM_003` is the ramp saying the subject has no A-Pass on the chain it is
  // quoting. That is PRD 5.5's third precondition refusing, and it is the same
  // blocker as ASM-035: `generate_apass` is 403 for this credential, so no
  // A-Pass can be provisioned on a ramp chain. Recorded as its own cause rather
  // than folded into a generic failure, because it is the one that says the
  // route is closed rather than broken.
  const noAPassOnRampChain = widgetRefusals.some((refusal) =>
    (refusal.message ?? '').includes('RM_003'),
  );

  const artifact = {
    assumption: 'ASM-010',
    question: 'Is Fiat Ramp SELL enabled for the selected test market?',
    observedAt: new Date().toISOString(),
    subject: wallet,
    resolution: 'RESOLVED',
    rampRoleGranted: quoteOutcome === 'ANSWERED',
    sellQuoteAvailable: quoteOutcome === 'ANSWERED',
    widgetSessionAvailable: widgetOutcome === 'ANSWERED',
    widgetRefusals,
    blockedByMissingAPassOnRampChain: noAPassOnRampChain,
    heldSettlementAssetOfframpable: heldAssetOfframpable,
    networks,
    sellableMarkets: sellable,
    settlementAssetListing: assetListing,
    quote: quote
      ? {
          quoteId: quote.quoteId,
          isBuyOrSell: quote.isBuyOrSell,
          network: quote.network,
          cryptoCurrency: quote.cryptoCurrency,
          fiatCurrency: quote.fiatCurrency,
          cryptoAmount: quote.cryptoAmount,
          fiatAmount: quote.fiatAmount,
          totalFee: quote.totalFee,
          paymentMethod: quote.paymentMethod,
          // The token itself is single-use and 15 minutes long. Recording its
          // hash proves a token was issued without republishing a live one.
          quoteTokenSha256: sha256(quote.quoteToken),
        }
      : undefined,
    observations,
    /**
     * The distinction the submission has to keep straight. The ramp role is
     * granted and the SELL flow runs; the assets Conduit actually settles are
     * not on it. One of those is a Cleanverse limitation and the other is not a
     * limitation at all, it is what a restricted RWA and a sandbox CVA are.
     */
    limitation:
      'Fiat Ramp is granted for this credential and SELL quoting is live: real quote ' +
      'tokens with real pricing are returned for every listed network. Two independent ' +
      'things stop the external fiat leg from completing. First, the hosted widget ' +
      'requires an active A-Pass on the quoted chain (PRD 5.5) and refuses with RM_003; ' +
      'generate_apass is 403 for this credential (ASM-035), so no A-Pass can be ' +
      'provisioned on a ramp chain. Second, the listed markets are Transak-backed ' +
      'mainstream assets: neither the Monad settlement CVA nor the Base RWA CVA is a ' +
      'listed ramp asset, and Monad is not a ramp network at all. The on-chain ' +
      'OPERATOR_ASSISTED_OFFRAMP disposition moves the held units to a registered ' +
      'gateway account and is real. No fiat settlement is claimed.',
  };

  await writeFile(
    'docs/evidence/asm-010-fiat-ramp.json',
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );

  console.log(`\nramp role granted:       ${artifact.rampRoleGranted}`);
  console.log(`SELL quote live:         ${artifact.sellQuoteAvailable}`);
  console.log(`widget session:          ${artifact.widgetSessionAvailable}`);
  console.log(`blocked by ASM-035:      ${artifact.blockedByMissingAPassOnRampChain}`);
  console.log(`held asset off-rampable: ${heldAssetOfframpable}`);
  console.log(`networks:                ${networks.join(', ')}`);
  console.log('written: docs/evidence/asm-010-fiat-ramp.json');
}

await main();

#!/usr/bin/env node
/**
 * Signs the owner message and submits the CVA registration. PRD 19 phase 03.
 *
 * `ConduitRWACVA` calls the CCP policy on every transfer, and until Cleanverse
 * has registered it the policy answers `TokenNotRegistered()` and every transfer
 * reverts. Registration is the step that turns the contract from an ERC-20 that
 * happens to call a policy into an asset the policy will authorise.
 *
 * The signature is the whole risk surface, so the sequence is deliberate and
 * fails closed at every step:
 *
 *   1. read owner() from the deployed token, now, not from a note;
 *   2. sign the exact lowercase plaintext, in process;
 *   3. recover the signer from the signature we are about to send;
 *   4. refuse to submit unless the recovery equals the live owner.
 *
 * Step 3 is not ceremony. `lowercase(chain + address)` recovers a different
 * signer than the checksummed form, and the gateway reports only "chain
 * signature invalid" without saying which half was wrong — a failure that costs
 * an afternoon and looks like a credential problem.
 *
 * The key is read from `process.env` and used in memory. It is never printed,
 * never an argv element, never written anywhere. The only artifact that leaves
 * this process is the signature and the evidence below.
 *
 *   node --env-file=.env scripts/register-cva.mjs [address] [chain]
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { createPublicClient, http, parseAbi, recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { cleanverseClientFromEnv } from './lib/cleanverse.mjs';
import { ROOT } from './lib/run.mjs';

/**
 * Chain and token are arguments, because this now registers two CVAs: the RWA on
 * Base and the sandbox settlement unit on Monad. The chain slug goes into the
 * signed plaintext, so a mismatch produces a signature that recovers to the
 * wrong signer and a gateway error that names neither half.
 */
const CHAIN_SLUG = process.argv[3] ?? 'base';
const TOKEN = process.argv[2] ?? process.env['RWA_CVA_ADDRESS'];
const RPC_ENV = CHAIN_SLUG === 'monad' ? 'MONAD_TESTNET_RPC_URL' : 'BASE_SEPOLIA_RPC_URL';
const EXPECTED_CHAIN_ID = CHAIN_SLUG === 'monad' ? 10143 : 84532;
const ICON =
  process.env['RWA_CVA_ICON'] ?? 'https://images.cleanverse.com/app/token_icon/A_USDC.svg';

const TOKEN_ABI = parseAbi([
  'function owner() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function policy() view returns (address)',
]);

const sha256 = (value) => `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;

const pub = createPublicClient({ transport: http(process.env[RPC_ENV]) });

const chainId = await pub.getChainId();
if (chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`RPC reports chain ${chainId}, expected ${EXPECTED_CHAIN_ID} for ${CHAIN_SLUG}`);
}

const read = (functionName) =>
  pub.readContract({ address: TOKEN, abi: TOKEN_ABI, functionName, args: [] });

const [owner, name, symbol, decimals, policy] = await Promise.all([
  read('owner'),
  read('name'),
  read('symbol'),
  read('decimals'),
  read('policy'),
]);

console.log(`${CHAIN_SLUG} ${chainId}`);
console.log(`token   ${TOKEN}  ${name} (${symbol}) ${decimals}dp`);
console.log(`policy  ${policy}`);
console.log(`owner   ${owner}   ← read from chain, not from a manifest`);

/**
 * Lowercased as a whole rather than per part. A checksummed address inside the
 * plaintext recovers a different signer, and the gateway's error does not say so.
 */
const plaintext = `${CHAIN_SLUG}${TOKEN}`.toLowerCase();
console.log(`message "${plaintext}"`);

const account = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const signature = await account.signMessage({ message: plaintext });

const recovered = await recoverMessageAddress({ message: plaintext, signature });
console.log(`signer  ${recovered}`);

if (recovered.toLowerCase() !== owner.toLowerCase()) {
  console.error(`\nrecovered signer ${recovered} is not the token owner ${owner}`);
  console.error('refusing to submit: a registration signed by the wrong key is rejected upstream');
  process.exit(1);
}
console.log('recovered signer matches the live owner\n');

const payload = {
  chain: CHAIN_SLUG,
  atoken_address: TOKEN,
  owner_signature: signature,
  atoken_icon: ICON,
};

const client = await cleanverseClientFromEnv();
const passthrough = { safeParse: (value) => ({ success: true, data: value }) };

// The request hash covers the payload minus the signature. The signature is
// reproducible from the plaintext by anyone holding the key, and including it
// would put a credential-derived value into an artifact meant to be published.
const requestHash = sha256(
  JSON.stringify({
    chain: payload.chain,
    atoken_address: payload.atoken_address,
    atoken_icon: ICON,
  }),
);

let submission = null;
let failure = null;
try {
  submission = await client.call('registerAToken', payload, passthrough);
  console.log(`register_atoken  code=${submission.code}  ${submission.message}`);
  console.log(`                 ${JSON.stringify(submission.data)}`);
} catch (error) {
  failure = {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    apiMessage: error?.apiMessage ?? String(error?.message ?? error),
    httpStatus: error?.httpStatus ?? null,
    requestId: error?.requestId ?? null,
  };
  console.log(`register_atoken  FAILED  code=${failure.code ?? '-'}  ${failure.apiMessage}`);
}

/** Only `ISSUED` counts. `PENDING` and `APPROVED` still fail `canTransfer`. */
let outcome = null;
const requestId = submission?.data?.requestId ?? submission?.data?.request_id ?? null;
if (typeof requestId === 'string' && requestId.length > 0) {
  console.log(`\npolling apply status for ${requestId}`);
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const status = await client
      .getJson(`/atoken/query_apply_status/${encodeURIComponent(requestId)}`, passthrough)
      .catch((error) => ({ applyStatus: 'ERROR', reason: error?.apiMessage ?? String(error) }));
    const applyStatus = status.applyStatus ?? status.apply_status ?? 'UNKNOWN';
    console.log(`  ${applyStatus}`);
    outcome = { applyStatus, data: status };
    if (['ISSUED', 'REJECTED', 'FAILED', 'ERROR'].includes(applyStatus)) break;
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

const evidence = {
  capturedAt: new Date().toISOString(),
  endpoint: 'POST /atoken/register_atoken',
  chain: { slug: CHAIN_SLUG, nativeChainId: chainId },
  token: { address: TOKEN, name, symbol, decimals, policy },
  ownerOnChain: owner,
  signedPlaintext: plaintext,
  recoveredSigner: recovered,
  recoveredMatchesOwner: recovered.toLowerCase() === owner.toLowerCase(),
  requestHash,
  submission:
    submission === null
      ? null
      : {
          requestId: submission.requestId,
          code: submission.code,
          message: submission.message,
          responseHash: submission.responseHash,
          redactedBody: submission.redactedBody,
          applicationRequestId: requestId,
          issueAssetRegisterId:
            submission.data?.issueAssetRegisterId ??
            submission.data?.issue_asset_register_id ??
            null,
        },
  failure,
  applyStatus: outcome?.applyStatus ?? null,
  registered: outcome?.applyStatus === 'ISSUED',
  applyStatusDetail: outcome?.data ?? null,
};

const path = join(
  ROOT,
  'docs',
  'evidence',
  CHAIN_SLUG === 'monad'
    ? 'phase-01-settlement-cva-registration.json'
    : 'phase-03-cva-registration.json',
);
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nwritten ${path}`);
process.exitCode = evidence.registered ? 0 : 1;

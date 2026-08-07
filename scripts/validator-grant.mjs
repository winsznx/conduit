#!/usr/bin/env node
/**
 * `POST /validator/grant` — REGISTER_ROLE authorization. ADR-0001, phase 01.
 *
 * The Monad cash leg is blocked on one fact: the CVA policy refuses `CashEscrow`
 * with `NoAPass(0x1645BA08…)`, so a contract cannot hold aUSDC without CVI. The
 * CCP Integration Guide for CVI Compliance V2 gives exactly one on-chain remedy,
 * `registerApass(pool, aToken, fee)` on `IAPassComplianceValidator`, and states
 * that the caller must hold `REGISTER_ROLE`, granted through this endpoint.
 *
 * Two things are unknown before this runs, and both are answered by running it:
 *
 *   1. whether our credential may grant the role at all;
 *   2. the validator's deployed address, which the guide never prints and which
 *      discovery does not return — a successful grant is a transaction, and the
 *      transaction's `to` is the validator.
 *
 * The payload shape is the gateway's own answer rather than a guess. It rejects
 * unknown fields by name, so eliminating candidates one at a time left exactly
 * `chain`, `address`, `owner_signature`, and every rejected name is recorded in
 * the evidence artifact so the next reader does not repeat the search.
 *
 * The signing scheme is the one remaining ambiguity. The guide states the rule
 * for `/validator/register` as `keccak256(chain + contract_address)` and prints
 * nothing for grant, so both readings are attempted in order: a personal_sign
 * over the literal string, then over the digest. A wrong scheme is refused as an
 * invalid signature and mutates nothing, so trying both costs one failed call.
 *
 *   node --env-file=.env scripts/validator-grant.mjs <address>
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, http, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { cleanverseClientFromEnv } from './lib/cleanverse.mjs';
import { ROOT } from './lib/run.mjs';

const CHAINS = {
  monad: { rpcEnv: 'MONAD_TESTNET_RPC_URL', nativeChainId: 10143 },
  base: { rpcEnv: 'BASE_SEPOLIA_RPC_URL', nativeChainId: 84532 },
};

const CHAIN = process.argv[3] ?? 'monad';
const grantee = process.argv[2];

if (grantee === undefined || !/^0x[0-9a-fA-F]{40}$/.test(grantee)) {
  console.error('usage: node --env-file=.env scripts/validator-grant.mjs <address> [chain]');
  process.exit(1);
}
if (CHAINS[CHAIN] === undefined) {
  console.error(`unknown chain ${CHAIN}; expected one of ${Object.keys(CHAINS).join(', ')}`);
  process.exit(1);
}

/** Read from the environment and never echoed, in argv or in output. */
const account = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);

/** Lowercased whole, as `registrationMessage` is: a checksummed address recovers a different signer. */
const plaintext = `${CHAIN}${grantee}`.toLowerCase();

const schemes = [
  { name: 'personal_sign(chain + address)', message: plaintext },
  {
    name: 'personal_sign(keccak256(chain + address))',
    message: { raw: keccak256(toHex(plaintext)) },
  },
];

const client = await cleanverseClientFromEnv();
const passthrough = { safeParse: (value) => ({ success: true, data: value }) };

console.log(`granting REGISTER_ROLE`);
console.log(`  chain    ${CHAIN}`);
console.log(`  address  ${grantee}`);
console.log(`  signer   ${account.address}`);
console.log(`  message  ${plaintext}`);

const attempts = [];
let granted = null;

for (const scheme of schemes) {
  const signature = await account.signMessage({ message: scheme.message });
  try {
    const result = await client.call(
      'validatorGrant',
      { chain: CHAIN, address: grantee, owner_signature: signature },
      passthrough,
    );
    console.log(`\n  ${scheme.name}  ACCEPTED  code=${result.code}`);
    console.log(`  data ${JSON.stringify(result.data)}`);
    attempts.push({
      scheme: scheme.name,
      accepted: true,
      code: result.code,
      requestId: result.requestId,
    });
    granted = result;
    break;
  } catch (error) {
    const code = error?.code ?? null;
    const apiMessage = error?.apiMessage ?? String(error?.message ?? error);
    console.log(`\n  ${scheme.name}  refused  code=${code ?? '-'}  ${apiMessage}`);
    attempts.push({
      scheme: scheme.name,
      accepted: false,
      code,
      apiMessage,
      requestId: error?.requestId ?? null,
    });
    // Only a signature refusal justifies trying the other scheme.
    //
    // `code === null` means the request failed at transport and the server's
    // answer is unknown — it may never have arrived, or it may have landed and
    // the response been lost. Trying again there is a blind write retry, which
    // CLAUDE.md forbids for exactly this reason: a grant that already applied
    // would be applied twice. Observed for real when a TypeError from `fetch`
    // sent this loop through both schemes against a live endpoint.
    if (code === null || code !== '0001') break;
  }
}

/**
 * A grant is a transaction, so the receipt names the validator contract the
 * guide never prints. That address is what a Factory's constructor needs.
 */
let validatorAddress = null;
const txHash = granted?.data?.tx_hash ?? null;
if (typeof txHash === 'string' && txHash.length > 0) {
  const client = createPublicClient({ transport: http(process.env[CHAINS[CHAIN].rpcEnv]) });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  validatorAddress = receipt.to;
  console.log(`\n  tx        ${txHash}`);
  console.log(`  validator ${validatorAddress}   ← from chain state, not from the guide`);
}

const evidence = {
  capturedAt: new Date().toISOString(),
  endpoint: 'POST /validator/grant',
  chain: CHAIN,
  grantee,
  signer: account.address,
  signedPlaintext: plaintext,
  payloadShape: {
    accepted: ['chain', 'address', 'owner_signature'],
    rejectedByGateway: [
      'contract_address',
      'factory_address',
      'pool_address',
      'target_address',
      'validator_address',
      'grantee_address',
      'signature',
    ],
    source: 'gateway code 10002 "Unknown field(s)" enumeration, not the guide',
  },
  attempts,
  granted: granted !== null,
  txHash,
  validatorAddress,
};

const path = join(ROOT, 'docs', 'evidence', `phase-01-validator-grant-${CHAIN}.json`);
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nwritten ${path}`);
process.exitCode = granted === null ? 1 : 0;

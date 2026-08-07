#!/usr/bin/env node
/**
 * Registers the compliance signer set and quorum. ADR-0014.
 *
 * A deployed contract starts with `complianceQuorum() == 0`, and that state
 * refuses every commit and holds every release. It is the safe direction to fail
 * and it is also useless, so this is the step that makes a deployment
 * operational.
 *
 * The signer is a separate key from the deployer, and deliberately so. They are
 * two authorities: one deploys code, the other decides whether a party may
 * receive value. Sharing a key means a compromise of the deploy machine is also a
 * compromise of every compliance decision, and no amount of process makes that
 * distinction back afterwards.
 *
 * The key is generated once, written to `.env`, and never printed. If
 * `COMPLIANCE_SIGNER_PRIVATE_KEY` already exists, it is used as is.
 *
 *   node --env-file=.env scripts/configure-compliance-signers.mjs
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { ROOT } from './lib/run.mjs';

const AUTHORITY_ABI = parseAbi([
  'function addComplianceSigner(address signer)',
  'function removeComplianceSigner(address signer)',
  'function setComplianceQuorum(uint256 quorum)',
  'function isComplianceSigner(address) view returns (bool)',
  'function complianceSignerCount() view returns (uint256)',
  'function complianceQuorum() view returns (uint256)',
  'function attestationDomainSeparator() view returns (bytes32)',
  'function maxAttestationValidity() view returns (uint64)',
]);

const TARGETS = [
  {
    label: 'SettlementCoordinator',
    chain: 'monadTestnet',
    chainId: 10143,
    rpc: process.env['MONAD_TESTNET_RPC_URL'],
    address: process.env['SETTLEMENT_COORDINATOR_ADDRESS'],
  },
  {
    label: 'CashEscrow',
    chain: 'monadTestnet',
    chainId: 10143,
    rpc: process.env['MONAD_TESTNET_RPC_URL'],
    address: process.env['CASH_ESCROW_ADDRESS'],
  },
  {
    label: 'RWACVASettlementAdapter',
    chain: 'baseSepolia',
    chainId: 84532,
    rpc: process.env['BASE_SEPOLIA_RPC_URL'],
    address: process.env['RWA_CVA_ADAPTER_ADDRESS'],
  },
];

/** Generated on first run and persisted. Never logged, here or anywhere. */
function complianceSignerKey() {
  const existing = process.env['COMPLIANCE_SIGNER_PRIVATE_KEY'];
  if (typeof existing === 'string' && /^0x[0-9a-fA-F]{64}$/.test(existing)) return existing;

  const generated = generatePrivateKey();
  appendFileSync(join(ROOT, '.env'), `COMPLIANCE_SIGNER_PRIVATE_KEY=${generated}\n`);
  console.log('generated a compliance signer key and appended it to .env');
  return generated;
}

const deployer = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const signer = privateKeyToAccount(complianceSignerKey());

if (signer.address === deployer.address) {
  console.error('the compliance signer must not be the deployer key');
  process.exit(1);
}

console.log(`compliance signer ${signer.address}`);
console.log(`owner             ${deployer.address}\n`);

const configured = [];

for (const target of TARGETS) {
  const transport = http(target.rpc);
  const pub = createPublicClient({ transport });
  const wallet = createWalletClient({
    account: deployer,
    transport,
    chain: { id: target.chainId },
  });

  const reported = await pub.getChainId();
  if (reported !== target.chainId) {
    throw new Error(`${target.label}: RPC reports chain ${reported}, expected ${target.chainId}`);
  }

  const read = (functionName, args = []) =>
    pub.readContract({ address: target.address, abi: AUTHORITY_ABI, functionName, args });

  if (!(await read('isComplianceSigner', [signer.address]))) {
    const hash = await wallet.writeContract({
      address: target.address,
      abi: AUTHORITY_ABI,
      functionName: 'addComplianceSigner',
      args: [signer.address],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${target.label.padEnd(24)} addComplianceSigner  ${hash}`);
  }

  if ((await read('complianceQuorum')) === 0n) {
    const hash = await wallet.writeContract({
      address: target.address,
      abi: AUTHORITY_ABI,
      functionName: 'setComplianceQuorum',
      args: [1n],
    });
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  ${target.label.padEnd(24)} setComplianceQuorum  ${hash}`);
  }

  const state = {
    label: target.label,
    chain: target.chain,
    address: target.address,
    signerRegistered: await read('isComplianceSigner', [signer.address]),
    signerCount: Number(await read('complianceSignerCount')),
    quorum: Number(await read('complianceQuorum')),
    maxAttestationValiditySeconds: Number(await read('maxAttestationValidity')),
    attestationDomainSeparator: await read('attestationDomainSeparator'),
  };
  configured.push(state);

  console.log(
    `  ${state.label.padEnd(24)} signers ${state.signerCount}  quorum ${state.quorum}  validity ${state.maxAttestationValiditySeconds}s`,
  );
}

const evidence = {
  capturedAt: new Date().toISOString(),
  complianceSigner: signer.address,
  owner: deployer.address,
  signerIsSeparateFromDeployer: true,
  contracts: configured,
  limitation:
    'One signer, so the quorum is 1-of-1 on testnet. Quorum is genuinely enforced and duplicate attestations from one signer are rejected, but a 1-of-1 threshold is a testnet property and is not a threshold guarantee. ASM-036.',
};

const path = join(ROOT, 'docs', 'evidence', 'phase-05-compliance-authority.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nwritten ${path}`);

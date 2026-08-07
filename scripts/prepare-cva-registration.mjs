#!/usr/bin/env node
/**
 * Prepares the custom-CVA registration request without submitting it.
 *
 * Everything that can be checked without the owner's key is checked here, so
 * the human gate is the last step rather than the first. A signature spent on a
 * contract that cannot satisfy the gateway is a signature wasted, and the first
 * deployment could not: it had no `owner()`.
 *
 *   node --env-file=.env scripts/prepare-cva-registration.mjs
 */
import { createPublicClient, http, recoverMessageAddress } from 'viem';
import { baseSepolia } from 'viem/chains';

const TOKEN = process.env.RWA_CVA_ADDRESS;
const CHAIN_SLUG = 'base';

if (TOKEN === undefined) {
  console.error('set RWA_CVA_ADDRESS');
  process.exit(1);
}

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL),
});

// 1. The owner is read from the contract, never assumed from the deployer key.
const owner = await client.readContract({
  address: TOKEN,
  abi: [
    {
      name: 'owner',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ type: 'address' }],
    },
  ],
  functionName: 'owner',
});

const policy = await client.readContract({
  address: TOKEN,
  abi: [
    {
      name: 'policy',
      type: 'function',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ type: 'address' }],
    },
  ],
  functionName: 'policy',
});

// 2. The exact bytes to sign. Lowercased whole, no separator, Cleanverse slug.
const message = `${CHAIN_SLUG}${TOKEN}`.toLowerCase();

// 3. Prove the verification path locally with a throwaway key, so a failure
//    here is a bug in our construction rather than in the owner's wallet.
const { privateKeyToAccount } = await import('viem/accounts');
const probe = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const probeSignature = await probe.signMessage({ message });
const recovered = await recoverMessageAddress({ message, signature: probeSignature });
const roundTripOk = recovered.toLowerCase() === probe.address.toLowerCase();

console.log('contract           ', TOKEN);
console.log('owner()            ', owner);
console.log('policy()           ', policy);
console.log('chain slug         ', CHAIN_SLUG);
console.log('endpoint           ', `${process.env.CLEANVERSE_BASE_URL}/atoken/register_atoken`);
console.log('EIP-191 round trip ', roundTripOk ? 'verified locally' : 'BROKEN');
console.log('');
console.log('message to sign (exact, no trailing newline):');
console.log(message);
console.log('');
console.log('expected signer    ', owner);

if (!roundTripOk) process.exit(1);

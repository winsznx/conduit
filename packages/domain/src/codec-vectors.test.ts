import { keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  hashSettlementIntent,
  type DeploymentDomain,
  type SettlementIntentTerms,
} from './intent.js';
import { encodeHeader, MESSAGE_HEADER_BYTES, PROTOCOL_VERSION } from './messages.js';
import { MessageType } from './states.js';

/**
 * Cross-language agreement with the contracts.
 *
 * `contracts/test/Codecs.t.sol` asserts these same literals from Solidity. The
 * two implementations were written independently and neither derives its
 * expectations from the other, so a change on either side fails both suites.
 *
 * Hashing is where a divergence is most dangerous and least visible. A reordered
 * EIP-712 field still produces a perfectly valid-looking digest; the failure only
 * shows up as a signature the SDK produced and the contract rejected, or as one
 * the contract accepted for terms the signer never saw.
 */

const addr = (digit: string): `0x${string}` => `0x${digit.repeat(40)}`;

const TERMS: SettlementIntentTerms = {
  version: 1,
  cashChainId: 10_143n,
  cashEscrow: addr('1'),
  cashAsset: addr('2'),
  cashAmount: 1_000_000n,
  cashPayer: addr('3'),
  cashReceiver: addr('4'),
  assetChainId: 421_614n,
  assetEscrow: addr('5'),
  assetToken: addr('6'),
  assetAmount: 50n,
  assetSeller: addr('7'),
  assetReceiver: addr('8'),
  cashPolicyHash: keccak256(toHex('cash-policy')),
  assetPolicyHash: keccak256(toHex('asset-policy')),
  prepareDeadline: 1_786_060_800n,
  commitDeadline: 1_786_064_400n,
  releaseDeadline: 1_786_068_000n,
  nonce: 42n,
};

const DEPLOYMENT: DeploymentDomain = {
  name: 'Conduit',
  version: '1',
  chainId: 10_143n,
  verifyingContract: addr('9'),
};

const SETTLEMENT_ID = '0x114267ac4c241429904aea6ea0b5d6d44b569c35aefac85c07adccb9294ccc51';

describe('EIP-712 intent hashing (shared with SettlementIntentLib.sol)', () => {
  it('produces the policy hashes the Solidity suite asserts', () => {
    expect(TERMS.cashPolicyHash).toBe(
      '0x7cfb3db32fe34e8af6e239b3715720d93be7465d546eaad49a41f39a8a4710c5',
    );
    expect(TERMS.assetPolicyHash).toBe(
      '0x44a7e3926ca90a694b32eff79cef7a47de7b09ce15c8413fd0c01da5c6839e9d',
    );
  });

  it('produces the settlement ID the Solidity suite asserts', () => {
    expect(hashSettlementIntent(TERMS, DEPLOYMENT)).toBe(SETTLEMENT_ID);
  });

  it.each([
    ['cashAmount', { cashAmount: TERMS.cashAmount + 1n }],
    ['assetReceiver', { assetReceiver: addr('a') }],
    ['nonce', { nonce: TERMS.nonce + 1n }],
    ['prepareDeadline', { prepareDeadline: TERMS.prepareDeadline + 1n }],
  ])('changes when %s changes', (_label, patch) => {
    expect(hashSettlementIntent({ ...TERMS, ...patch }, DEPLOYMENT)).not.toBe(SETTLEMENT_ID);
  });

  it('binds the chain and the verifying contract (PRD FR-003)', () => {
    // A signature from one chain cannot authorize a different chain or
    // deployment. Both live in the domain separator rather than the struct.
    expect(hashSettlementIntent(TERMS, { ...DEPLOYMENT, chainId: 421_614n })).not.toBe(
      SETTLEMENT_ID,
    );
    expect(hashSettlementIntent(TERMS, { ...DEPLOYMENT, verifyingContract: addr('b') })).not.toBe(
      SETTLEMENT_ID,
    );
  });
});

describe('message header encoding (shared with MessageCodec.sol)', () => {
  const header = {
    protocolVersion: PROTOCOL_VERSION,
    messageType: MessageType.COMMIT,
    deploymentId: keccak256(toHex('deployment-1')),
    settlementId: SETTLEMENT_ID as `0x${string}`,
    intentHash: SETTLEMENT_ID as `0x${string}`,
    sourceChainId: 10_143n,
    destinationChainId: 421_614n,
    stateVersion: 7n,
  };

  it('produces the deployment ID the Solidity suite asserts', () => {
    expect(header.deploymentId).toBe(
      '0x6c335c492f1a8d4e0ec69a3da1427251ac22a5359580966028fa5812d655d103',
    );
  });

  it('encodes to a fixed 173 bytes', () => {
    expect((encodeHeader(header).length - 2) / 2).toBe(MESSAGE_HEADER_BYTES);
  });

  it('produces the header digest the Solidity suite asserts', () => {
    expect(keccak256(encodeHeader(header))).toBe(
      '0xea3fb23e7193f33f676888d0f4c5abc10827b4aac259f177fb486b00e8b3d028',
    );
  });
});

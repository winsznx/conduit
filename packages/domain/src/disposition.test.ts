import { keccak256, toHex, type Hex, type TypedDataDomain } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  AuthorityType,
  DESTINATION_RULE,
  DispositionType,
  Leg,
  caseIdFor,
  conflictResolutionDigest,
  dispositionOrderDigest,
  redirectsValue,
  type ConflictResolution,
  type DispositionOrder,
} from './disposition.js';

/**
 * The cross-language vectors.
 *
 * Every constant below is asserted identically in
 * `contracts/test/DispositionOrderLib.t.sol`. Two independent implementations
 * agreeing on a fixed digest is the only thing that catches a field reordered in
 * one and not the other, and a reordering there is not a compile error in either
 * language — it is a signature the SDK produces and the controller silently
 * attributes to different terms.
 */

const DOMAIN: TypedDataDomain = {
  name: 'Conduit',
  version: '1',
  chainId: 84_532,
  // The live generation-2 adapter on Base, so the vector is recognisable in a
  // report rather than an arbitrary address.
  verifyingContract: '0x51c3D536e94fB5b944c2AF8946d6916543bdf93a',
};

const DEPLOYMENT_ID = '0x893ca44ecf017ba183180fb358fbc27ed570df9e56d7d35a465a9ed5cb1a9417' as Hex;
const SETTLEMENT_ID = '0x30aa1b738cab5f534452b7ef4515119232505dba674ab768520e58be59ef4a17' as Hex;

const ORDER: DispositionOrder = {
  caseId: caseIdFor(DEPLOYMENT_ID, SETTLEMENT_ID, Leg.ASSET),
  settlementId: SETTLEMENT_ID,
  deploymentId: DEPLOYMENT_ID,
  leg: Leg.ASSET,
  dispositionType: DispositionType.REBIND_RECEIVER,
  sourceEscrow: '0x51c3D536e94fB5b944c2AF8946d6916543bdf93a',
  asset: '0x7a78912533b43C483621200b4919806c0B855E5b',
  amount: 500_000n,
  currentReceiver: '0x00000000000000000000000000000000000000B1',
  destination: '0x00000000000000000000000000000000000000b2',
  destinationIdentityCommitment: keccak256(toHex('identity-commitment')),
  authority: '0x00000000000000000000000000000000000000a6',
  authorityType: AuthorityType.TRANSFER_AGENT,
  authorityPolicyId: keccak256(toHex('conduit-disposition-policy-v1')),
  authorityPolicyHash: keccak256(toHex('policy-content')),
  evidenceCommitment: keccak256(toHex('case-file')),
  complianceAttestationIds: keccak256(toHex('attestation-set')),
  notBefore: 1_754_600_000n,
  expiry: 1_755_204_800n,
  nonce: 42n,
  hostStateVersion: 3n,
};

const RESOLUTION: ConflictResolution = {
  caseId: ORDER.caseId,
  deploymentId: DEPLOYMENT_ID,
  winningOrderHash: keccak256(toHex('the winning order')),
  authority: '0x00000000000000000000000000000000000000a6',
  authorityType: AuthorityType.TRANSFER_AGENT,
  authorityPolicyId: ORDER.authorityPolicyId,
  authorityPolicyHash: ORDER.authorityPolicyHash,
  evidenceCommitment: keccak256(toHex('adjudication-file')),
  notBefore: 1_754_600_000n,
  expiry: 1_755_204_800n,
  nonce: 43n,
};

/** Pinned. Solidity asserts the same three values. */
const EXPECTED_CASE_ID = '0xc5ccafeff84d3789d9ae40a849ba1ad6a65e21362c4245f076cb470a77b17406';
const EXPECTED_ORDER_DIGEST = '0xe1352b3dd7430527001053f018f6a9e5adbb70c88f9e3dc73e96b45e52b42acc';
const EXPECTED_RESOLUTION_DIGEST =
  '0xf08fc7ff902a0d4b15ea663e1b3c02ddb42cac7ca7876f8687116656103b0140';

describe('disposition orders', () => {
  it('derives the case ID from generation, settlement and leg', () => {
    expect(ORDER.caseId).toBe(EXPECTED_CASE_ID);
  });

  it('gives the two legs of one settlement different cases', () => {
    // #then a cash order can never be filed into the asset leg's case, which is
    // what stops a conflict check from being sidestepped by naming the wrong leg
    expect(caseIdFor(DEPLOYMENT_ID, SETTLEMENT_ID, Leg.CASH)).not.toBe(
      caseIdFor(DEPLOYMENT_ID, SETTLEMENT_ID, Leg.ASSET),
    );
  });

  it('gives two generations different cases for the same settlement', () => {
    const older = '0x9303f240f88e5aba93761e010b75b13681d0c03af58d945c241cc402dadd0843' as Hex;
    expect(caseIdFor(older, SETTLEMENT_ID, Leg.ASSET)).not.toBe(ORDER.caseId);
  });

  it('produces the pinned order digest', () => {
    expect(dispositionOrderDigest(ORDER, DOMAIN)).toBe(EXPECTED_ORDER_DIGEST);
  });

  it('produces the pinned conflict-resolution digest', () => {
    expect(conflictResolutionDigest(RESOLUTION, DOMAIN)).toBe(EXPECTED_RESOLUTION_DIGEST);
  });

  it('binds the digest to the chain and the controller', () => {
    // #given the same order presented to the other chain's controller
    const onMonad = dispositionOrderDigest(ORDER, { ...DOMAIN, chainId: 10_143 });
    const otherContract = dispositionOrderDigest(ORDER, {
      ...DOMAIN,
      verifyingContract: '0x0AEBe99A17796325Da45E49Ef3Ba8BD13bbE5c86',
    });

    // #then neither signature is valid where it was not meant to be
    expect(onMonad).not.toBe(EXPECTED_ORDER_DIGEST);
    expect(otherContract).not.toBe(EXPECTED_ORDER_DIGEST);
  });

  it('changes the digest when any single field changes', () => {
    // One assertion per field would be twenty-one near-identical tests. What
    // matters is that no field is outside the preimage, and a loop over the
    // struct is the only way to state that without listing it twice.
    const baseline = dispositionOrderDigest(ORDER, DOMAIN);
    const mutations: DispositionOrder[] = [
      { ...ORDER, caseId: keccak256(toHex('other')) },
      { ...ORDER, settlementId: keccak256(toHex('other')) },
      { ...ORDER, deploymentId: keccak256(toHex('other')) },
      { ...ORDER, leg: Leg.CASH },
      { ...ORDER, dispositionType: DispositionType.AUTHORIZED_SUBSTITUTION },
      { ...ORDER, sourceEscrow: '0x00000000000000000000000000000000000000ff' },
      { ...ORDER, asset: '0x00000000000000000000000000000000000000ff' },
      { ...ORDER, amount: 500_001n },
      { ...ORDER, currentReceiver: '0x00000000000000000000000000000000000000ff' },
      { ...ORDER, destination: '0x00000000000000000000000000000000000000ff' },
      { ...ORDER, destinationIdentityCommitment: keccak256(toHex('other')) },
      { ...ORDER, authority: '0x00000000000000000000000000000000000000ff' },
      { ...ORDER, authorityType: AuthorityType.ISSUER },
      { ...ORDER, authorityPolicyId: keccak256(toHex('other')) },
      { ...ORDER, authorityPolicyHash: keccak256(toHex('other')) },
      { ...ORDER, evidenceCommitment: keccak256(toHex('other')) },
      { ...ORDER, complianceAttestationIds: keccak256(toHex('other')) },
      { ...ORDER, notBefore: ORDER.notBefore + 1n },
      { ...ORDER, expiry: ORDER.expiry + 1n },
      { ...ORDER, nonce: 43n },
      { ...ORDER, hostStateVersion: 4n },
    ];

    expect(mutations).toHaveLength(21);
    for (const mutated of mutations) {
      expect(dispositionOrderDigest(mutated, DOMAIN)).not.toBe(baseline);
    }
  });

  it('treats only the resume type as non-redirecting', () => {
    expect(redirectsValue(DispositionType.REVERIFY_AND_RESUME)).toBe(false);
    for (const [name, value] of Object.entries(DispositionType)) {
      if (name === 'REVERIFY_AND_RESUME') continue;
      expect(redirectsValue(value)).toBe(true);
    }
  });

  it('has a stated destination rule for every order type', () => {
    expect(Object.keys(DESTINATION_RULE).sort()).toEqual(Object.keys(DispositionType).sort());
  });

  it('numbers both enums the way PRD FR-012 lists them', () => {
    // Positional, and never renumbered: the values are encoded into signed
    // orders and into the registry's permission bitmasks, so a reordering turns
    // a RESTRICTED_HOLD permission into a REBIND_RECEIVER permission on any
    // contract not redeployed alongside it.
    expect(Object.values(DispositionType)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(Object.values(AuthorityType)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(DispositionType.RESTRICTED_HOLD).toBe(5);
    expect(AuthorityType.MULTISIG).toBe(6);
  });
});

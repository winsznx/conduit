/**
 * The one place a compliance attestation is hashed and signed.
 *
 * Attempt 3 died twenty-five minutes into a live settlement because there were
 * two paths here and the wrong one won. `signTypedData` was called with an
 * undefined domain and a `catch` held the correct construction as a fallback;
 * the first path did not throw, it succeeded incorrectly, so the fallback never
 * ran and the signature covered a domain no contract uses. The coordinator
 * recovered an unauthorised address and refused, which is the protocol behaving
 * correctly against a malformed proof.
 *
 * So: one construction, no fallback, no catch, and every step of what the
 * verifier does reproduced here and asserted rather than assumed.
 *
 * `ComplianceAuthority._recoverAuthorizedSigner` is the function being mirrored:
 *
 * ```solidity
 * ECDSA.recover(ComplianceAttestationLib.digest(attestationDomainSeparator, copy), signature)
 * if (!_signers[signer]) revert AttestationSignerNotAuthorized(signer);
 * ```
 *
 * and `ComplianceAttestationLib.digest` is
 * `keccak256(0x1901 ‖ separator ‖ keccak256(abi.encode(TYPEHASH, ...seven fields)))`.
 *
 * The domain separator is read from the contract *and* recomputed from the name,
 * version, chain ID and address, and the two must agree. Reading it alone proves
 * the bytes were transported; recomputing it proves they mean what the runner
 * thinks they mean, which is the difference that produced attempt 3's failure.
 * The digest is then computed a second time through `packages/domain`, so the
 * SDK a downstream integrator would use cannot drift from the script that proves
 * the deployment works.
 */
import { concatHex, encodeAbiParameters, keccak256, parseAbi, recoverAddress, toHex } from 'viem';

import { hashComplianceAttestation } from '../../packages/domain/dist/attestation.js';

/** Matches `ComplianceAttestationLib.COMPLIANCE_ATTESTATION_TYPEHASH`. */
export const ATTESTATION_TYPE_STRING =
  'ComplianceAttestation(bytes32 settlementId,bytes32 intentHash,address subject,bool eligible,uint64 issuedAt,uint64 expiresAt,bytes32 evidenceHash)';

export const ATTESTATION_TYPEHASH = keccak256(toHex(ATTESTATION_TYPE_STRING));

/** Matches `ComplianceAttestationLib.EIP712_DOMAIN_TYPEHASH`. */
export const EIP712_DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

export const EIP712_DOMAIN_TYPEHASH = keccak256(toHex(EIP712_DOMAIN_TYPE_STRING));

/** Every contract inheriting `ComplianceAuthority` is deployed with these. */
export const DOMAIN_NAME = 'Conduit';
export const DOMAIN_VERSION = '1';

export const AUTHORITY_ABI = parseAbi([
  'function attestationDomainSeparator() view returns (bytes32)',
  'function maxAttestationValidity() view returns (uint64)',
  'function isComplianceSigner(address) view returns (bool)',
  'function complianceSignerCount() view returns (uint256)',
  'function complianceQuorum() view returns (uint256)',
]);

/** `ComplianceAttestationLib.domainSeparator`, recomputed off chain. */
export function domainSeparatorOf({ name, version, chainId, verifyingContract }) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toHex(name)),
        keccak256(toHex(version)),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}

/** `ComplianceAttestationLib.hashStruct`. */
export function structHashOf(attestation) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bool' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'bytes32' },
      ],
      [
        ATTESTATION_TYPEHASH,
        attestation.settlementId,
        attestation.intentHash,
        attestation.subject,
        attestation.eligible,
        attestation.issuedAt,
        attestation.expiresAt,
        attestation.evidenceHash,
      ],
    ),
  );
}

/** `ComplianceAttestationLib.digest`. */
export function digestOf(separator, attestation) {
  return keccak256(concatHex(['0x1901', separator, structHashOf(attestation)]));
}

/** The calldata tuple `ComplianceProof.attestations[i]` decodes to. */
export function attestationTuple(attestation) {
  return [
    attestation.settlementId,
    attestation.intentHash,
    attestation.subject,
    attestation.eligible,
    attestation.issuedAt,
    attestation.expiresAt,
    attestation.evidenceHash,
  ];
}

/**
 * Reads the verifier's own domain and proves it is the domain we can construct.
 *
 * A mismatch means one of four things is not what the manifest says: the
 * contract address, the chain, the domain name, or the version. All four are
 * indistinguishable from a wrong signer at the call site — the revert is
 * `AttestationSignerNotAuthorized` either way — so they are separated here,
 * before anything is signed.
 */
export async function readAttestationDomain(chain, verifyingContract) {
  const [onChain, maxValidity, quorum, signerCount, chainId] = await Promise.all([
    chain.pub.readContract({
      address: verifyingContract,
      abi: AUTHORITY_ABI,
      functionName: 'attestationDomainSeparator',
    }),
    chain.pub.readContract({
      address: verifyingContract,
      abi: AUTHORITY_ABI,
      functionName: 'maxAttestationValidity',
    }),
    chain.pub.readContract({
      address: verifyingContract,
      abi: AUTHORITY_ABI,
      functionName: 'complianceQuorum',
    }),
    chain.pub.readContract({
      address: verifyingContract,
      abi: AUTHORITY_ABI,
      functionName: 'complianceSignerCount',
    }),
    chain.pub.getChainId(),
  ]);

  const recomputed = domainSeparatorOf({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract,
  });

  if (recomputed !== onChain) {
    throw new Error(
      `attestation domain mismatch at ${verifyingContract} on chain ${chainId}: ` +
        `contract reports ${onChain}, "${DOMAIN_NAME}"/"${DOMAIN_VERSION}" gives ${recomputed}`,
    );
  }

  return { separator: onChain, chainId, maxValidity, quorum, signerCount, verifyingContract };
}

/**
 * Signs one attestation for one subject at one verifying contract.
 *
 * Everything the contract will check is checked first, in the order it checks
 * it, and any failure throws here rather than as a revert after a long wait.
 * The returned proof is single-attestation; callers merge them.
 */
export async function signAttestation({ domain, signer, attestation }) {
  const window = attestation.expiresAt - attestation.issuedAt;
  if (window > domain.maxValidity) {
    throw new Error(
      `attestation window ${window}s exceeds the contract's immutable ` +
        `maxAttestationValidity of ${domain.maxValidity}s`,
    );
  }
  if (attestation.expiresAt < attestation.issuedAt) {
    throw new Error('attestation window is inverted');
  }

  const digest = digestOf(domain.separator, attestation);

  // The SDK's independent implementation must produce the same digest. One
  // implementation agreeing with itself proves nothing; this is the same
  // cross-check the Solidity and TypeScript suites pin with a fixed vector,
  // run against the live domain rather than a constant.
  const viaDomainPackage = hashComplianceAttestation(
    {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    attestation,
  );
  if (viaDomainPackage !== digest) {
    throw new Error(
      `digest disagreement: scripts/lib/attestation.mjs ${digest}, packages/domain ${viaDomainPackage}`,
    );
  }

  const signature = await signer.sign({ hash: digest });

  const recovered = await recoverAddress({ hash: digest, signature });
  if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`attestation recovers to ${recovered}, expected ${signer.address}`);
  }

  return { attestation, digest, signature, recovered };
}

/**
 * Every single-field mutation of an attestation, for proving the digest binds
 * each one.
 *
 * A field silently left out of the preimage is a field an attacker chooses
 * freely. The contract suite fuzzes this; the preflight runs it against the
 * live domain separator so a redeployed contract with a different domain cannot
 * pass on the strength of a unit test.
 */
export function singleFieldMutations(attestation) {
  const other = `0x${'11'.repeat(32)}`;
  const otherAddress = '0x000000000000000000000000000000000000dEaD';
  return [
    ['settlementId', { ...attestation, settlementId: other }],
    ['intentHash', { ...attestation, intentHash: other }],
    ['subject', { ...attestation, subject: otherAddress }],
    ['eligible', { ...attestation, eligible: !attestation.eligible }],
    ['issuedAt', { ...attestation, issuedAt: attestation.issuedAt + 1n }],
    ['expiresAt', { ...attestation, expiresAt: attestation.expiresAt + 1n }],
    ['evidenceHash', { ...attestation, evidenceHash: other }],
  ];
}

/**
 * The domain a *different* contract expects, for proving the binding holds.
 *
 * Attempt 3's signature was valid over a domain nothing uses. This constructs
 * one deliberately, so the preflight can show the verifier rejects it rather
 * than discovering that property in production.
 */
export function foreignDomain(domain, { chainId, verifyingContract, version } = {}) {
  const foreign = {
    name: DOMAIN_NAME,
    version: version ?? DOMAIN_VERSION,
    chainId: chainId ?? domain.chainId,
    verifyingContract: verifyingContract ?? domain.verifyingContract,
  };
  return { ...domain, separator: domainSeparatorOf(foreign), describes: foreign };
}

/**
 * The compliance authority, as an endpoint.
 *
 * `issueCommit`, `releaseCash`, `releaseAsset` and `executeOrder` each demand a
 * quorum of attestations signed by an address the contract's registered signer
 * set contains. A browser cannot produce one — the signer is an authority, not a
 * participant — so the Worker holds that key and mints an attestation only after
 * asking Cleanverse, live, about the subject in question.
 *
 * ## What this changes about the trust story, and what it does not
 *
 * This Worker now holds a private key. It is not a settlement key: it cannot
 * move value, cannot sign an intent, cannot decide a settlement, and cannot make
 * a transaction happen. It signs one sentence — "Cleanverse said this address is
 * eligible for this settlement at this time, and here is the hash of the answer"
 * — and the contract requires that alongside a canonical protocol state a
 * participant's own wallet produced. Compromising it buys an attacker the
 * ability to lie about eligibility, which is the compliance authority's whole
 * power and exactly why the registry, the quorum and the 900-second window exist
 * on chain. It buys no custody.
 *
 * The alternative was a browser that cannot commit, which is not a product.
 * Recorded as ADR-0021.
 *
 * ## Refusal is signed too
 *
 * A `validator/verify` answering `valid:false` is a decision, and it is minted
 * as an `eligible:false` attestation rather than as an error, because the audit
 * package has to record the refusal rather than an absence. An *outage* is never
 * signed at all: nobody was asked, so there is nothing to attest.
 */

import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  checkAttestation,
  hashComplianceAttestation,
  type ComplianceAttestation,
} from '@conduit-protocol/domain';
import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  recoverAddress,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { checkEligibility, isAddress, type EligibilityResult } from './eligibility.js';
import {
  ADAPTER_ABI,
  BASE_SEPOLIA,
  COORDINATOR_ABI,
  ESCROW_ABI,
  MONAD_TESTNET,
} from './onchain.js';
import { deploymentConfig, targetForChain, type DeploymentConfig } from './deployment.js';
import type { Env } from './data.js';

/** Which contract will check the signature. The domain binds it, so it matters. */
export type AttestationPurpose = 'commit' | 'cash-release' | 'asset-release' | 'disposition';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export interface AttestationRequest {
  readonly settlementId: string;
  readonly intentHash: string;
  readonly purpose: AttestationPurpose;
  readonly subjects: readonly string[];
}

export interface MintedAttestation {
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  readonly subject: Address;
  readonly eligible: boolean;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly evidenceHash: Hex;
  readonly signature: Hex;
}

export interface AttestationResponse {
  readonly ok: boolean;
  readonly purpose: AttestationPurpose;
  readonly chainId: number;
  readonly verifyingContract: Address;
  readonly attestations: readonly MintedAttestation[];
  readonly eligibility: readonly {
    subject: string;
    status: string;
    reason: string;
    detail: string;
    checkedAt: string;
    answer?: string | undefined;
  }[];
  /** Set when at least one check failed to complete. Never a refusal. */
  readonly unavailable: boolean;
  readonly signer: Address;
  /** Seconds. The contract's own immutable, read back rather than assumed. */
  readonly maxValidity: number;
}

export interface AttestationFailure {
  readonly status: number;
  readonly body: unknown;
}

function fail(status: number, code: string, message: string, detail?: string): AttestationFailure {
  return {
    status,
    body: { error: { code, message, ...(detail === undefined ? {} : { detail }) } },
  };
}

/** Where each purpose is checked, and on which chain. */
function verifyingContractFor(
  purpose: AttestationPurpose,
  config: DeploymentConfig,
): { chainId: number; address: Address } {
  switch (purpose) {
    case 'commit':
      return { chainId: MONAD_TESTNET, address: config.coordinator };
    case 'cash-release':
      return { chainId: MONAD_TESTNET, address: config.cashEscrow };
    case 'asset-release':
    case 'disposition':
      return { chainId: BASE_SEPOLIA, address: config.rwaAdapter };
  }
}

function rpcFor(env: Env, chainId: number): string {
  return chainId === MONAD_TESTNET ? env.MONAD_RPC_URL : env.BASE_RPC_URL;
}

export function readClient(env: Env, chainId: number): PublicClient {
  return createPublicClient({ transport: http(rpcFor(env, chainId)) });
}

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

/**
 * The domain separator, recomputed from what the manifest claims.
 *
 * Reading it from the contract proves the bytes were transported. Recomputing it
 * proves they mean what this code thinks they mean, and the difference between
 * the two is what a live run once spent twenty-five minutes discovering: a
 * signature valid over a domain nothing uses recovers to a stranger, and the
 * revert says `AttestationSignerNotAuthorized` either way.
 */
async function readDomain(
  client: PublicClient,
  chainId: number,
  verifyingContract: Address,
  abi: typeof COORDINATOR_ABI | typeof ESCROW_ABI | typeof ADAPTER_ABI,
): Promise<{ separator: Hex; maxValidity: bigint }> {
  const [separator, maxValidity] = await Promise.all([
    client.readContract({
      address: verifyingContract,
      abi,
      functionName: 'attestationDomainSeparator',
    }),
    client.readContract({
      address: verifyingContract,
      abi,
      functionName: 'maxAttestationValidity',
    }),
  ]);

  const recomputed = keccak256(
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
        keccak256(toHex(DOMAIN_NAME)),
        keccak256(toHex(DOMAIN_VERSION)),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );

  if (recomputed !== separator) {
    throw new Error(
      `attestation domain mismatch at ${verifyingContract} on chain ${String(chainId)}: ` +
        `contract reports ${separator}, the deployment's name and version give ${recomputed}`,
    );
  }
  return { separator, maxValidity };
}

function abiFor(purpose: AttestationPurpose) {
  switch (purpose) {
    case 'commit':
      return COORDINATOR_ABI;
    case 'cash-release':
      return ESCROW_ABI;
    case 'asset-release':
    case 'disposition':
      return ADAPTER_ABI;
  }
}

/**
 * Mints the proof for one call.
 *
 * Every subject is asked about separately and deduplicated, because the
 * coordinator asks about the payer and the receiver as two questions and
 * `_countAttestations` refuses two copies of one signer's opinion about one
 * subject — correctly, since that is not a quorum of two.
 */
export async function mintAttestations(
  env: Env,
  request: unknown,
): Promise<AttestationResponse | AttestationFailure> {
  const config = deploymentConfig(env);
  if (config === undefined) {
    return fail(503, 'not_configured', 'no deployment addresses are configured');
  }

  const key = env.COMPLIANCE_SIGNER_PRIVATE_KEY;
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return fail(
      503,
      'no_compliance_signer',
      'this deployment cannot mint compliance attestations',
      'The compliance authority key is not configured on this Worker, so no attestation can be ' +
        'produced here. Chain state is unaffected; a CLI holding the key can still commit.',
    );
  }

  const parsed = request as Partial<AttestationRequest>;
  const purpose = parsed.purpose;
  if (
    purpose !== 'commit' &&
    purpose !== 'cash-release' &&
    purpose !== 'asset-release' &&
    purpose !== 'disposition'
  ) {
    return fail(400, 'invalid_request', 'purpose must name a call this authority attests for');
  }
  if (typeof parsed.settlementId !== 'string' || !HEX32.test(parsed.settlementId)) {
    return fail(400, 'invalid_request', 'settlementId must be a 32-byte hex value');
  }
  if (typeof parsed.intentHash !== 'string' || !HEX32.test(parsed.intentHash)) {
    return fail(400, 'invalid_request', 'intentHash must be a 32-byte hex value');
  }
  const subjects = [...new Set((parsed.subjects ?? []).map((subject) => subject.toLowerCase()))];
  if (subjects.length === 0 || subjects.length > 4 || !subjects.every(isAddress)) {
    return fail(400, 'invalid_request', 'subjects must be one to four addresses');
  }

  const settlementId = parsed.settlementId.toLowerCase() as Hex;
  const intentHash = parsed.intentHash.toLowerCase() as Hex;
  const where = verifyingContractFor(purpose, config);
  const target = targetForChain(config, where.chainId);
  if (target === undefined) {
    return fail(400, 'invalid_request', `no eligibility target for chain ${String(where.chainId)}`);
  }

  let domain: { separator: Hex; maxValidity: bigint };
  try {
    domain = await readDomain(
      readClient(env, where.chainId),
      where.chainId,
      where.address,
      abiFor(purpose),
    );
  } catch (error) {
    console.error('attestation domain read failed', error);
    return fail(
      502,
      'domain_unreadable',
      'the verifying contract could not be read',
      'Without its own domain separator nothing can be signed for it. This is an RPC or ' +
        'configuration failure, not a compliance decision.',
    );
  }

  const signer = privateKeyToAccount(key as Hex);
  const issuedAt = BigInt(Math.floor(Date.now() / 1000) - 30);
  // Comfortably inside the immutable window and short enough that a proof cannot
  // outlive the transaction it was minted for.
  const window = domain.maxValidity > 300n ? domain.maxValidity - 300n : domain.maxValidity;

  const decisions: EligibilityResult[] = [];
  for (const subject of subjects) {
    decisions.push(await checkEligibility(env, target, subject));
  }

  const unavailable = decisions.some(
    (decision) => decision.status === 'UNAVAILABLE' || decision.status === 'INVALID_REQUEST',
  );

  const eligibility = decisions.map((decision) => ({
    subject: decision.subject,
    status: decision.status,
    reason: decision.reason,
    detail: decision.detail,
    checkedAt: decision.checkedAt,
    answer: decision.answer,
  }));

  // An outage produces no attestation at all. Signing `eligible:false` here
  // would put a refusal on the record that nobody made.
  if (unavailable) {
    return {
      ok: false,
      purpose,
      chainId: where.chainId,
      verifyingContract: where.address,
      attestations: [],
      eligibility,
      unavailable: true,
      signer: signer.address,
      maxValidity: Number(domain.maxValidity),
    };
  }

  const attestations: MintedAttestation[] = [];
  for (const decision of decisions) {
    const evidenceHash = (decision.evidenceHash ?? `0x${'0'.repeat(64)}`) as Hex;
    const attestation: ComplianceAttestation = {
      settlementId,
      intentHash,
      subject: decision.subject as Address,
      eligible: decision.status === 'ELIGIBLE',
      issuedAt,
      expiresAt: issuedAt + window,
      evidenceHash,
    };

    const problems = checkAttestation(attestation, {
      settlementId,
      intentHash,
      maxValidity: domain.maxValidity,
      now: BigInt(Math.floor(Date.now() / 1000)),
    });
    if (problems.length > 0) {
      return fail(500, 'attestation_invalid', `refusing to sign: ${problems.join(', ')}`);
    }

    const digest = hashComplianceAttestation(
      {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        chainId: where.chainId,
        verifyingContract: where.address,
      },
      attestation,
    );
    const signature = await signer.sign({ hash: digest });

    // The signature is checked before it leaves, against the same digest the
    // contract will recover from. A locally correct signature over the wrong
    // domain recovers to a stranger, and only this comparison catches it here
    // rather than as a revert after a twenty-five minute wait.
    const recovered = await recoverAddress({ hash: digest, signature });
    if (recovered.toLowerCase() !== signer.address.toLowerCase()) {
      return fail(500, 'attestation_invalid', 'the attestation did not recover to its own signer');
    }

    attestations.push({
      settlementId,
      intentHash,
      subject: attestation.subject,
      eligible: attestation.eligible,
      issuedAt: issuedAt.toString(),
      expiresAt: (issuedAt + window).toString(),
      evidenceHash,
      signature,
    });
  }

  return {
    ok: attestations.every((attestation) => attestation.eligible),
    purpose,
    chainId: where.chainId,
    verifyingContract: where.address,
    attestations,
    eligibility,
    unavailable: false,
    signer: signer.address,
    maxValidity: Number(domain.maxValidity),
  };
}

export function isAttestationFailure(
  value: AttestationResponse | AttestationFailure,
): value is AttestationFailure {
  return 'status' in value;
}

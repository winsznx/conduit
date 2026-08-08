import { describe, expect, it } from 'vitest';

import type { ChainScopedAddress } from '@conduit-protocol/domain';
import type { Address, Hex } from 'viem';

import {
  caseIdFor,
  outcomeOfCases,
  reconstructDisposition,
  type DispositionReader,
  type ReconstructedDisposition,
} from './disposition.js';
import { DeploymentGeneration, type DeploymentManifest } from './registry.js';

/**
 * Reconstructing a disposition from state alone.
 *
 * The reader below is a fixture rather than a chain, and that is the point: this
 * verifies that the reconstruction needs nothing but `eth_call` against a
 * manifest. A version that reached for event logs would work here and then
 * silently certify whatever fitted inside a hundred-block window on Monad, which
 * is the failure the settlement verifier already made once.
 */

const GEN = '0x893ca44ecf017ba183180fb358fbc27ed570df9e56d7d35a465a9ed5cb1a9417' as Hex;
const SETTLEMENT = '0x30aa1b738cab5f534452b7ef4515119232505dba674ab768520e58be59ef4a17' as Hex;
const ZERO: Hex = `0x${'00'.repeat(32)}`;

const CONTROLLER: Address = '0x00000000000000000000000000000000000000C1';
const REGISTRY: Address = '0x00000000000000000000000000000000000000c2';
const AGENT: Address = '0x00000000000000000000000000000000000000a6';
const CUSTODY: Address = '0x00000000000000000000000000000000000000C0';
const POLICY_ID: Hex = `0x${'55'.repeat(32)}`;
const POLICY_HASH: Hex = `0x${'66'.repeat(32)}`;
const ORDER_HASH: Hex = `0x${'77'.repeat(32)}`;

function generationWith(roles: Record<string, string>): DeploymentGeneration {
  const manifest: DeploymentManifest = {
    deploymentId: GEN,
    protocolVersion: 1,
    gitCommit: 'test',
    solcVersion: '0.8.36',
    chainConfigs: {
      baseSepolia: {
        nativeChainId: 84_532,
        wormholeChainId: 10_004,
        rpcUrlEnvVar: 'B',
        finalityBlocks: 512,
      },
    },
    contracts: Object.fromEntries(
      Object.entries(roles).map(([role, address]) => [
        role,
        { chain: 'baseSepolia', address: address as `0x${string}` },
      ]),
    ),
    bytecodeHashes: Object.fromEntries(
      Object.keys(roles).map((role) => [role, `0x${'11'.repeat(32)}`]),
    ),
    wormhole: {
      baseSepolia: {
        coreAddress: '0xaBf89de706B583424328B54dD05a8fC986750Da8',
        wormholeChainId: 10_004,
        consistencyLevel: 1,
      },
    },
    finalityProfile: { settlement: 'FINALIZED', observation: 'INSTANT' },
    complianceProfile: { maxAttestationValiditySeconds: 900, quorum: 1 },
  };
  return DeploymentGeneration.fromManifests([{ name: 'base.json', manifest }]);
}

/** `DispositionController.Case`, as a tuple, in the contract's field order. */
function executedCase(overrides: Partial<Record<number, unknown>> = {}): unknown[] {
  const tuple: unknown[] = [
    4, // state: EXECUTED
    1, // leg: ASSET
    SETTLEMENT,
    POLICY_ID,
    POLICY_HASH,
    `0x${'88'.repeat(32)}`, // leadTermsKey
    ORDER_HASH,
    1_754_600_000n, // filedAt
    1, // signatures
    ORDER_HASH, // executedOrderHash
    5, // executedType: RESTRICTED_HOLD
    CUSTODY,
    500_000n,
    `0x${'99'.repeat(32)}`, // executedComplianceDigest
  ];
  for (const [index, value] of Object.entries(overrides)) tuple[Number(index)] = value;
  return tuple;
}

function reader(
  caseTuple: unknown[],
  options: { registryPolicyHash?: Hex; authorityType?: number; active?: boolean } = {},
): DispositionReader {
  return {
    read: (identity: ChainScopedAddress, functionName: string) => {
      if (functionName === 'caseOf') return Promise.resolve(caseTuple);
      if (functionName === 'authoritiesOf') return Promise.resolve([AGENT]);
      if (functionName === 'policyHash') {
        return Promise.resolve(options.registryPolicyHash ?? POLICY_HASH);
      }
      if (functionName === 'authorityOf') {
        return Promise.resolve([
          options.authorityType ?? 3,
          options.active ?? true,
          1_754_000_000n,
        ]);
      }
      return Promise.reject(new Error(`unexpected read ${functionName} on ${identity.address}`));
    },
  };
}

const FULL_ROLES = {
  DispositionController: CONTROLLER,
  AuthorityRegistry: REGISTRY,
};

describe('reconstructDisposition', () => {
  it('derives the case ID the controller derives', async () => {
    // #then the two legs of one settlement never share a case
    const cash = await caseIdFor(GEN, SETTLEMENT, 0);
    const asset = await caseIdFor(GEN, SETTLEMENT, 1);
    expect(cash).not.toBe(asset);

    // #and this is the same value the Solidity and domain tests pin
    expect(asset).toBe('0xc5ccafeff84d3789d9ae40a849ba1ad6a65e21362c4245f076cb470a77b17406');
  });

  it('reconstructs an executed disposition from contract state alone', async () => {
    const result = await reconstructDisposition(
      SETTLEMENT,
      'ASSET',
      84_532,
      generationWith(FULL_ROLES),
      reader(executedCase()),
    );

    expect(result).toBeDefined();
    expect(result?.state).toBe('EXECUTED');
    expect(result?.executedType).toBe('RESTRICTED_HOLD');
    expect(result?.executedDestination).toBe(CUSTODY);
    expect(result?.executedAmount).toBe('500000');
    expect(result?.executedOrderHash).toBe(ORDER_HASH);
    expect(result?.executedComplianceDigest).toBe(`0x${'99'.repeat(32)}`);
    expect(result?.policyHash).toBe(POLICY_HASH);
    expect(result?.authorities).toEqual([
      { address: AGENT, authorityType: 'TRANSFER_AGENT', stillActive: true },
    ]);
  });

  /**
   * A generation that predates the kernel is not a generation whose settlement
   * was never dispositioned — it is one where no disposition was possible. The
   * live generation-1 hold is exactly this, and conflating the two would make
   * the most important sentence in that settlement's report the wrong one.
   */
  it('reports no kernel rather than no disposition when the controller is absent', async () => {
    const result = await reconstructDisposition(
      SETTLEMENT,
      'ASSET',
      84_532,
      generationWith({ ConduitRWACVA: '0x7a78912533b43C483621200b4919806c0B855E5b' }),
      reader(executedCase()),
    );
    expect(result).toBeUndefined();
  });

  it('treats an unknown case as no case', async () => {
    const result = await reconstructDisposition(
      SETTLEMENT,
      'ASSET',
      84_532,
      generationWith(FULL_ROLES),
      reader(executedCase({ 0: 0, 9: ZERO })),
    );
    expect(result).toBeUndefined();
  });

  it('leaves the executed fields empty while a case is still open', async () => {
    const result = await reconstructDisposition(
      SETTLEMENT,
      'ASSET',
      84_532,
      generationWith(FULL_ROLES),
      reader(executedCase({ 0: 1, 9: ZERO })),
    );
    expect(result?.state).toBe('OPEN');
    expect(result?.executedType).toBeUndefined();
    expect(result?.executedDestination).toBeUndefined();
    expect(result?.executedComplianceDigest).toBeUndefined();
  });

  /**
   * An order binds the policy's content hash, so a policy edited afterwards does
   * not retroactively change what was authorized. It does change what a reader
   * would find if they went looking, and saying so is the difference between a
   * report and a snapshot.
   */
  it('notices that the policy changed after the orders were signed', async () => {
    const result = await reconstructDisposition(
      SETTLEMENT,
      'ASSET',
      84_532,
      generationWith(FULL_ROLES),
      reader(executedCase(), { registryPolicyHash: `0x${'ee'.repeat(32)}` }),
    );
    expect(result?.policyUnchangedSinceFiling).toBe(false);
    expect(result?.policyHash).toBe(POLICY_HASH);
  });

  it('reports a signer revoked since it signed, rather than omitting it', async () => {
    const result = await reconstructDisposition(
      SETTLEMENT,
      'ASSET',
      84_532,
      generationWith(FULL_ROLES),
      reader(executedCase(), { active: false }),
    );
    expect(result?.authorities[0]?.stillActive).toBe(false);
    expect(result?.authorities[0]?.authorityType).toBe('TRANSFER_AGENT');
  });
});

describe('outcomeOfCases', () => {
  const base: ReconstructedDisposition = {
    leg: 'ASSET',
    caseId: ZERO,
    controller: { chainId: 84_532, address: CONTROLLER },
    state: 'EXECUTED',
    policyId: POLICY_ID,
    policyHash: POLICY_HASH,
    policyUnchangedSinceFiling: true,
    filedAt: '1754600000',
    signatures: 1,
    authorities: [],
    leadOrderHash: ORDER_HASH,
    executedOrderHash: ORDER_HASH,
    executedType: 'REBIND_RECEIVER',
    executedDestination: CUSTODY,
    executedAmount: '500000',
    executedComplianceDigest: ZERO,
  };

  it('says nothing when no case exists on either leg', () => {
    expect(outcomeOfCases([undefined, undefined])).toBe('NONE');
  });

  it('reports a rebind as a disposition rather than a delivery', () => {
    expect(outcomeOfCases([undefined, base])).toBe('DISPOSITION_FINAL');
  });

  /**
   * Restricted custody is reported ahead of the rest when any leg reached it.
   * It is the one outcome where no party to the trade received the value, and
   * folding it into "dispositioned" would describe a settlement that completed.
   */
  it('reports restricted custody ahead of an ordinary disposition', () => {
    const custody = { ...base, leg: 'CASH' as const, executedType: 'RESTRICTED_HOLD' as const };
    expect(outcomeOfCases([custody, base])).toBe('RESTRICTED_HOLD_FINAL');
  });

  /**
   * A contest outranks everything, including a leg that already executed: it
   * means two authorities disagree about value that is still stuck, and no
   * report should lead with the half that resolved.
   */
  it('reports a contest ahead of everything else', () => {
    const contested = { ...base, leg: 'CASH' as const, state: 'CONTESTED' as const };
    expect(outcomeOfCases([contested, base])).toBe('CONTESTED');
  });

  it('says nothing when a case exists but has not executed', () => {
    expect(outcomeOfCases([{ ...base, state: 'OPEN' }])).toBe('NONE');
  });
});

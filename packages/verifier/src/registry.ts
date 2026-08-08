import { contractKey, ContractRegistry, type ChainScopedAddress } from '@conduit-protocol/domain';

import type { Address, Hex } from 'viem';

/**
 * Deployment manifests, loaded into an identity the verifier can trust.
 *
 * A manifest is per chain and names its contracts by role, so within one file
 * nothing collides. Across files everything can: the live deployment has
 * `0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE` as the SettlementCoordinator on
 * Monad and the RWACVASettlementAdapter on Base, and a registry keyed by role
 * name across manifests, or by bare address, would answer confidently and
 * wrongly.
 *
 * So a manifest is resolved into `(chainId, address)` on the way in, using the
 * `chainConfigs` entry the contract's `chain` field points at. A contract whose
 * chain is not configured is rejected rather than defaulted.
 */

export interface ManifestChainConfig {
  readonly nativeChainId: number;
  readonly wormholeChainId: number;
  readonly rpcUrlEnvVar: string;
  readonly finalityBlocks: number;
}

export interface DeploymentManifest {
  readonly deploymentId: Hex;
  readonly protocolVersion: number;
  readonly gitCommit: string;
  readonly solcVersion: string;
  readonly chainConfigs: Readonly<Record<string, ManifestChainConfig>>;
  readonly contracts: Readonly<Record<string, { chain: string; address: Address }>>;
  readonly bytecodeHashes: Readonly<Record<string, Hex>>;
  readonly wormhole: Readonly<
    Record<string, { coreAddress: Address; wormholeChainId: number; consistencyLevel: number }>
  >;
  readonly finalityProfile: { settlement: string; observation: string };
  readonly complianceProfile: { maxAttestationValiditySeconds: number; quorum: number };
}

/** One deployed contract, with everything needed to check it against a chain. */
export interface RegisteredContract {
  readonly role: string;
  readonly identity: ChainScopedAddress;
  readonly wormholeChainId: number;
  readonly expectedCodeHash: Hex;
  readonly deploymentId: Hex;
  readonly rpcUrlEnvVar: string;
  readonly manifestName: string;
}

export class DeploymentGeneration {
  readonly deploymentId: Hex;
  readonly protocolVersion: number;
  private readonly registry = new ContractRegistry<RegisteredContract>();
  /**
   * Roles are unique per chain, never globally. Two generations of the same
   * role on two chains is normal, and so is one role appearing on both.
   */
  private readonly byRole = new Map<string, RegisteredContract>();
  private readonly cores = new ContractRegistry<{ wormholeChainId: number }>();

  constructor(deploymentId: Hex, protocolVersion: number) {
    this.deploymentId = deploymentId;
    this.protocolVersion = protocolVersion;
  }

  /**
   * Every generation present, grouped by deployment ID.
   *
   * A redeployment is a new generation, not a replacement: the contracts are
   * non-upgradeable, the old ones stay on chain holding the settlements they
   * decided, and a verifier asked about one of those settlements has to read the
   * generation it belongs to. Merging generations would let a superseded
   * contract answer for a live one, which is the migration failure this guards
   * against — and the deployment ID is what separates them, on chain in every
   * message header and here in every lookup.
   */
  static allFrom(
    manifests: readonly { name: string; manifest: DeploymentManifest }[],
  ): readonly DeploymentGeneration[] {
    const byId = new Map<Hex, { name: string; manifest: DeploymentManifest }[]>();
    for (const entry of manifests) {
      const group = byId.get(entry.manifest.deploymentId) ?? [];
      group.push(entry);
      byId.set(entry.manifest.deploymentId, group);
    }
    return [...byId.values()].map((group) => DeploymentGeneration.fromManifests(group));
  }

  static fromManifests(
    manifests: readonly { name: string; manifest: DeploymentManifest }[],
  ): DeploymentGeneration {
    if (manifests.length === 0) throw new Error('no manifests supplied');

    const [first] = manifests;
    if (first === undefined) throw new Error('no manifests supplied');

    const generation = new DeploymentGeneration(
      first.manifest.deploymentId,
      first.manifest.protocolVersion,
    );

    for (const { name, manifest } of manifests) {
      // A deployment generation is defined by its ID. Two manifests with
      // different IDs describe different generations and must not be merged:
      // that is how a superseded contract ends up authorised in a report.
      if (manifest.deploymentId !== generation.deploymentId) {
        throw new Error(
          `${name}: deploymentId ${manifest.deploymentId} does not match ${generation.deploymentId}`,
        );
      }
      if (manifest.protocolVersion !== generation.protocolVersion) {
        throw new Error(
          `${name}: protocolVersion ${String(manifest.protocolVersion)} does not match`,
        );
      }
      generation.absorb(name, manifest);
    }

    return generation;
  }

  private absorb(manifestName: string, manifest: DeploymentManifest): void {
    for (const [role, entry] of Object.entries(manifest.contracts)) {
      const chain = manifest.chainConfigs[entry.chain];
      if (chain === undefined) {
        throw new Error(
          `${manifestName}: ${role} is on chain "${entry.chain}", which is not configured`,
        );
      }
      const codeHash = manifest.bytecodeHashes[role];
      if (codeHash === undefined) {
        throw new Error(`${manifestName}: ${role} has no bytecode hash`);
      }

      const registered: RegisteredContract = {
        role,
        identity: { chainId: chain.nativeChainId, address: entry.address },
        wormholeChainId: chain.wormholeChainId,
        expectedCodeHash: codeHash,
        deploymentId: manifest.deploymentId,
        rpcUrlEnvVar: chain.rpcUrlEnvVar,
        manifestName,
      };

      this.registry.add(registered.identity, registered);

      const roleKey = `${String(chain.nativeChainId)}:${role}`;
      if (this.byRole.has(roleKey)) {
        throw new Error(
          `${manifestName}: ${role} appears twice on chain ${String(chain.nativeChainId)}`,
        );
      }
      this.byRole.set(roleKey, registered);
    }

    for (const [chainName, core] of Object.entries(manifest.wormhole)) {
      const chain = manifest.chainConfigs[chainName];
      if (chain === undefined) continue;
      const identity = { chainId: chain.nativeChainId, address: core.coreAddress };
      if (!this.cores.has(identity)) {
        this.cores.add(identity, { wormholeChainId: core.wormholeChainId });
      }
    }
  }

  /** By role *and* chain. There is no by-role-alone lookup, deliberately. */
  role(chainId: number, role: string): RegisteredContract {
    const found = this.byRole.get(`${String(chainId)}:${role}`);
    if (found === undefined) {
      throw new Error(`no ${role} on chain ${String(chainId)} in deployment ${this.deploymentId}`);
    }
    return found;
  }

  /**
   * By role and chain, when the role may legitimately be absent.
   *
   * @remarks Generation 1 predates the Disposition Kernel and has no
   * `DispositionController`; generation 2 as first deployed has none either.
   * A verifier asked about a settlement on such a generation must report that
   * there was no kernel, not throw — those are different answers, and only one
   * of them is a fact about the settlement. `role` still throws, because
   * asking for a coordinator that should exist and finding none is a broken
   * manifest rather than an absent capability.
   */
  tryRole(chainId: number, role: string): RegisteredContract | undefined {
    return this.byRole.get(`${String(chainId)}:${role}`);
  }

  at(identity: ChainScopedAddress): RegisteredContract | undefined {
    return this.registry.get(identity);
  }

  coreFor(chainId: number): ChainScopedAddress {
    const found = this.cores.all().find((entry) => entry.identity.chainId === chainId);
    if (found === undefined) throw new Error(`no Wormhole core for chain ${String(chainId)}`);
    return found.identity;
  }

  wormholeChainIdFor(chainId: number): number {
    const found = this.registry.all().find((entry) => entry.identity.chainId === chainId);
    if (found === undefined) throw new Error(`chain ${String(chainId)} is not in this deployment`);
    return found.value.wormholeChainId;
  }

  contracts(): readonly RegisteredContract[] {
    return this.registry.all().map((entry) => entry.value);
  }

  /**
   * Contracts sharing a bare address across chains.
   *
   * Reported rather than rejected. The collision is legitimate, it is deployed,
   * and a verification report that does not name it invites a reader to assume
   * two identical strings are one contract.
   */
  addressCollisions(): readonly (readonly { role: string; key: string }[])[] {
    return this.registry.collisions().map((group) =>
      group.map((identity) => ({
        role: this.registry.get(identity)?.role ?? 'unknown',
        key: contractKey(identity),
      })),
    );
  }
}

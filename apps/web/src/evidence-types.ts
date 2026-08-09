/**
 * The shape `scripts/build-evidence-index.mjs` must produce.
 *
 * Hand-written, and the generated module is annotated with it. That direction
 * matters: a run artifact that grows a field, or loses one, fails the typecheck
 * at the generated file rather than becoming `undefined` on a page halfway
 * through rendering somebody's evidence.
 */

export interface EvidenceTransaction {
  readonly stage: string;
  readonly key: string;
  readonly hash: string;
  readonly chainId: number;
}

export interface EvidenceMessage {
  readonly messageType: string;
  readonly sequence: string;
  readonly emitter: string;
  readonly emitterChainId: number;
  readonly publishedTx: string;
  readonly finalitySeconds: number | null;
}

export interface EvidenceComplianceSource {
  readonly endpoint: string;
  readonly answer: string;
  readonly responseHash: string;
}

export interface EvidenceCompliance {
  readonly at: string;
  readonly subject: string;
  readonly chain: string;
  readonly eligible: boolean;
  readonly evidenceHash: string;
  readonly sources: readonly EvidenceComplianceSource[];
}

export interface EvidenceRuleTransition {
  readonly label: string;
  readonly hash: string;
  readonly before: string;
  readonly after: string;
}

export interface EvidenceRun {
  readonly settlementId: string;
  readonly generation: number;
  readonly title: string;
  readonly summary: string;
  readonly outcome: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly source: string;
  readonly addresses: Readonly<Record<string, string>>;
  readonly transactions: readonly EvidenceTransaction[];
  readonly messages: readonly EvidenceMessage[];
  readonly compliance: readonly EvidenceCompliance[];
  readonly ruleTransitions: readonly EvidenceRuleTransition[];
  readonly disposition: { readonly type: string; readonly hash: string } | null;
  readonly adversarial: readonly { readonly attempt: string; readonly refusedWith: string }[];
  /**
   * Balance snapshots, keyed by whatever the run called them.
   *
   * The happy path records `opening`/`closing`; the compliance-change scenario
   * records `before`/`after` around the policy move. Both are conservation
   * evidence and neither is more canonical, so the shape stays open rather than
   * forcing one run's vocabulary onto the other.
   */
  readonly conservation: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly limitations: readonly string[];
  readonly failure: { readonly classification: string; readonly message: string } | null;
}

export interface EvidenceVerification {
  readonly settlementId: string;
  readonly deploymentId: string;
  readonly classification: string;
  readonly canonicalState: string;
  readonly verifiedAt: string;
  readonly passed: number;
  readonly total: number;
  readonly trustRoot: string;
  readonly searchedBlockRanges: Readonly<Record<string, { from: string; to: string }>>;
  readonly source: string;
  readonly messages: readonly {
    readonly messageType: string;
    readonly sequence: string;
    readonly emitterChainId: number;
    readonly emitter: string;
    readonly vaaHash: string | null;
    readonly finality: string;
    readonly consumed: boolean;
  }[];
}

export interface EvidenceManifest {
  readonly file: string;
  readonly deploymentId: string;
  readonly gitCommit: string;
  readonly solcVersion: string;
  readonly timestamp: string;
  readonly contracts: readonly {
    readonly role: string;
    readonly chain: string;
    readonly address: string;
    readonly codeHash: string | null;
  }[];
  readonly finalityProfile: Readonly<Record<string, string>>;
  readonly complianceProfile: Readonly<Record<string, string | number | boolean>>;
  readonly cleanverseAssetSnapshotHash: string | null;
}

export interface EvidenceIndex {
  readonly runs: readonly EvidenceRun[];
  readonly verifications: readonly EvidenceVerification[];
  readonly manifests: readonly EvidenceManifest[];
}

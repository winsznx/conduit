/**
 * View models and the words the product uses for its own states.
 *
 * The copy here is product truth and predates the visual system; `design.md`
 * changed how these states look and changed nothing about what they mean. The
 * sentences are carried over unedited.
 */

export interface SettlementView {
  readonly settlementId: string;
  readonly deploymentId: string;
  readonly generation: number;
  readonly canonicalState: string;
  readonly decision: string;
  readonly verifierClass: string | undefined;
  readonly cash: LegView;
  readonly asset: LegView;
  readonly messages: readonly MessageView[];
  readonly compliance: readonly ComplianceView[];
  readonly disposition: DispositionView | undefined;
  readonly conservation: readonly [string, string][];
  readonly termsKnown: boolean;
}

export interface LegView {
  readonly chain: string;
  readonly chainId: number;
  readonly asset: string;
  readonly assetSymbol: string;
  readonly amount: string;
  readonly outcome: string;
  readonly counterparty: string;
}

export interface MessageView {
  readonly messageType: string;
  readonly sequence: string;
  readonly finality: string;
  readonly emitter: string;
  readonly wormholeChainId: number;
  readonly consumed: boolean;
  readonly finalitySeconds: number | undefined;
}

export interface ComplianceView {
  readonly subject: string;
  readonly eligible: boolean;
  readonly at: string;
  readonly source: string;
  readonly evidenceHash: string;
}

export interface DispositionView {
  readonly caseId: string;
  readonly leg: string;
  readonly state: string;
  readonly dispositionType: string | undefined;
  readonly destination: string | undefined;
  readonly authorities: readonly { address: string; authorityType: string }[];
  readonly policyHash: string;
}

export interface DeploymentView {
  readonly deploymentId: string;
  readonly generation: number;
  readonly gitCommit: string;
  readonly solcVersion: string;
  readonly supersededBy: string | undefined;
  readonly contracts: readonly {
    role: string;
    address: string;
    chainId: number;
  }[];
}

/**
 * How each state should read to somebody looking at their own money.
 *
 * `HELD` gets the longest sentence because it is the state most likely to be
 * misread. Under `design.md` no state carries a colour, so this sentence is now
 * doing all of the work it used to share with a yellow badge.
 */
export const STATE_MEANING: Readonly<Record<string, { says: string }>> = Object.freeze({
  NONE: { says: 'No settlement with this identifier has been prepared.' },
  CASH_PREPARED: { says: 'Cash is locked. Waiting on the asset leg.' },
  ASSET_PREPARED: { says: 'The asset is reserved. Waiting on the cash leg.' },
  READY: {
    says: 'Both legs are prepared. Commitment waits on economic finality and a fresh compliance answer.',
  },
  COMMIT_ISSUED: {
    says: 'Committed. From here there is no refund — both legs execute or the value is held.',
  },
  ABORT_ISSUED: { says: 'Aborted before commitment. Both legs return to their owners.' },
  SETTLED: { says: 'Both legs executed. The trade is complete.' },
  ABORTED: { says: 'Returned to both parties. Nothing moved between them.' },
  HELD: {
    says:
      'Committed value awaiting a lawful resolution. One leg executed and the other cannot be ' +
      'delivered under current compliance rules. This is not a failure and not a refund: the ' +
      'commitment stands, the value is accounted for, and it moves only through an authorised ' +
      'disposition.',
  },
  CONTESTED: {
    says:
      'Two authorised parties have proposed different resolutions. Nothing moves until the ' +
      'authority policy resolves the conflict.',
  },
});

/**
 * The verifier's own classifications, kept visually distinct from chain state.
 *
 * ADR-0017: `SETTLED` is a Solidity enum and `SETTLED_FINAL` is a conclusion
 * this software drew. The page labels which is which in words, because the
 * monochrome badge system deliberately cannot encode it in colour.
 */
export const CLASS_MEANING: Readonly<Record<string, string>> = Object.freeze({
  SETTLED_FINAL: 'Independently verified: both legs delivered to the parties the intent named.',
  DISPOSITION_FINAL:
    'Independently verified: terminal through an authorised disposition, not through ordinary delivery.',
  RESTRICTED_HOLD_FINAL:
    'Independently verified: terminal in registered restricted custody. No party to the trade received the value.',
  CONTESTED: 'Two authorised orders disagree. Nothing may move until the policy resolves it.',
  HELD_PENDING_DISPOSITION: 'Committed and undelivered, with no disposition resolving it yet.',
  SETTLED_PENDING_VERIFICATION:
    'The coordinator reports SETTLED, but at least one independent check did not pass.',
  NOT_SETTLED: 'The coordinator’s own state is not SETTLED.',
});

/** The canonical order a settlement moves through, for the timeline. */
export const LIFECYCLE: readonly { key: string; title: string; detail: string }[] = Object.freeze([
  { key: 'PREPARED', title: 'Both legs prepared', detail: 'Cash escrowed, asset reserved' },
  { key: 'FINALITY', title: 'Economic finality', detail: 'The remote state a commit rests on' },
  { key: 'COMPLIANCE', title: 'Fresh compliance', detail: 'Answered again at commit time' },
  { key: 'COMMIT', title: 'Commit', detail: 'Irreversible. No refund exists after this point' },
  { key: 'DELIVERY', title: 'Delivery', detail: 'Both legs execute, or the value is held' },
]);

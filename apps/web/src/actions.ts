/**
 * What has happened, what is waiting, and what this wallet can do next.
 *
 * The backbone of the settlement workspace. Given a snapshot of canonical
 * protocol state — the coordinator's own record, the escrow leg, the token's
 * reservation, the adapter's binding, the messages in flight — this decides the
 * single next action and whether the connected account may take it.
 *
 * ## Everything here is derived from chain state
 *
 * Not from the projection, not from what the browser did a moment ago, and not
 * from a step counter. The application database never authorizes value movement
 * (CLAUDE.md), so it is not an input to authorization here either: it supplies
 * the terms and the two intent signatures, both of which the coordinator
 * re-verifies on chain, and nothing else.
 *
 * ## Why a pure function
 *
 * Because it is the part that must be provable. A resolver that reads a network
 * cannot be tested exhaustively; this one is a table from state to action and
 * `actions.test.ts` walks it. Every branch that enables a value-moving button is
 * a branch with a test.
 */

import type { Address, Hex } from 'viem';

import type {
  CashLegRecord,
  DispositionCaseRecord,
  ReservationRecord,
  SettlementRecord,
} from './onchain.js';
import { BASE_SEPOLIA, MONAD_TESTNET, ZERO_ADDRESS } from './onchain.js';

export type ActionKind =
  | 'AWAITING_SIGNATURES'
  | 'RESERVE_ASSET'
  | 'LOCK_CASH'
  | 'AWAITING_ASSET_PREPARATION'
  | 'AWAITING_CASH_PREPARATION'
  | 'WAITING_FOR_FINALITY'
  | 'RECORD_ASSET_PREPARED'
  | 'FRESH_COMPLIANCE_REQUIRED'
  | 'COMMIT_REQUIRED'
  | 'READY_TO_COMMIT'
  | 'EXECUTE_CASH_RELEASE'
  | 'EXECUTE_ASSET_RELEASE'
  | 'WAITING_FOR_REMOTE_RESOLUTION'
  | 'HELD_DISPOSITION_REQUIRED'
  | 'CONTEST_WINDOW'
  | 'DISPOSITION_CONTESTED'
  | 'DISPOSITION_EXECUTABLE'
  | 'SETTLEMENT_COMPLETE'
  | 'VERIFICATION_INCOMPLETE'
  | 'DEADLINE_PASSED'
  | 'ABORTED';

/** The concrete write an action runs, or none when nothing is executable. */
export type ActionCall =
  | 'reserve-asset'
  | 'lock-cash'
  | 'record-asset-prepared'
  | 'run-fresh-compliance'
  | 'issue-commit'
  | 'release-cash'
  | 'release-asset'
  | 'report-resolution'
  | 'record-leg-resolved'
  | 'file-disposition'
  | 'execute-disposition'
  | 'run-verifier';

/** Who the protocol permits. `anyone` is a real permission, not a shrug. */
export type Actor = 'payer' | 'seller' | 'anyone' | 'nobody';

export interface NextAction {
  readonly kind: ActionKind;
  readonly title: string;
  readonly detail: string;
  readonly actor: Actor;
  /** The chain the write goes to, absent when there is no write. */
  readonly chainId?: number;
  readonly call?: ActionCall;
  /** Whether the connected wallet may run it right now. */
  readonly enabled: boolean;
  /** Why not, when it is not. Always a specific sentence, never "unavailable". */
  readonly blocked?: string;
}

export interface Terms {
  readonly cashAmount: bigint;
  readonly cashPayer: Address;
  readonly cashReceiver: Address;
  readonly assetAmount: bigint;
  readonly assetSeller: Address;
  readonly assetReceiver: Address;
  readonly prepareDeadline: bigint;
  readonly commitDeadline: bigint;
  readonly releaseDeadline: bigint;
}

/** One cross-chain message, as far as it has been observed. */
export interface MessageObservation {
  readonly messageType: string;
  readonly sequence: string;
  readonly emitter: Address;
  readonly emitterChainId: number;
  readonly txHash?: Hex;
  /** When the source transaction was included. */
  readonly includedAt?: string;
  /** True once the guardian set has signed at the finality the peer requires. */
  readonly finalized: boolean;
  readonly finalizedAt?: string;
  /** True once the destination contract has burned the VAA. */
  readonly consumed: boolean;
}

/**
 * A commit-time compliance answer held by this session.
 *
 * `maxAttestationValidity` is an immutable 900 seconds and observed Base
 * finality has run past 1400, so an answer minted before the wait cannot
 * authorize a commit after it. The expiry is carried here so the resolver can
 * refuse a proof that has aged out rather than letting the chain refuse it.
 */
export interface FreshCompliance {
  readonly eligible: boolean;
  readonly checkedAt: string;
  readonly expiresAt: number;
  readonly refusals: readonly { subject: string; status: string; detail: string }[];
  /** True when the deployment could not reach Cleanverse. Not a refusal. */
  readonly unavailable: boolean;
}

export interface Snapshot {
  readonly terms: Terms;
  readonly signatures: { readonly payer: boolean; readonly seller: boolean };
  /** The coordinator's record. Absent means nothing has been prepared at all. */
  readonly settlement: SettlementRecord | undefined;
  readonly cashLeg: CashLegRecord | undefined;
  readonly reservation: ReservationRecord | undefined;
  readonly intendedReceiver: Address | undefined;
  readonly messages: {
    readonly assetPrepared?: MessageObservation;
    readonly commit?: MessageObservation;
    readonly assetResolution?: MessageObservation;
  };
  readonly holdings: {
    readonly availableAsset?: bigint;
    readonly cashBalance?: bigint;
    readonly cashAllowance?: bigint;
  };
  readonly fresh: FreshCompliance | undefined;
  /** Set once `issueCommit` has been simulated successfully against the node. */
  readonly commitSimulated: boolean;
  readonly dispositionCase: DispositionCaseRecord | undefined;
  readonly contestWindowSeconds: number;
  /** The verifier's independent classification, when a run exists. */
  readonly verifierClass: string | undefined;
  readonly account: Address | undefined;
  readonly nowSeconds: number;
}

function same(left: string | undefined, right: string | undefined): boolean {
  return left?.toLowerCase() === right?.toLowerCase() && left !== undefined;
}

/** Which roles the connected account plays. Both is normal in a self-trade. */
export function rolesOf(terms: Terms, account: Address | undefined): readonly Actor[] {
  const roles: Actor[] = [];
  if (same(account, terms.cashPayer)) roles.push('payer');
  if (same(account, terms.assetSeller)) roles.push('seller');
  return roles;
}

function authorized(snapshot: Snapshot, actor: Actor): boolean {
  if (actor === 'nobody') return false;
  if (snapshot.account === undefined) return false;
  if (actor === 'anyone') return true;
  return rolesOf(snapshot.terms, snapshot.account).includes(actor);
}

function notConnected(actor: Actor): string {
  return actor === 'anyone'
    ? 'Connect a wallet to submit this transaction. Anyone may submit it; the protocol does not care who relays.'
    : 'Connect a wallet to continue.';
}

function wrongAccount(actor: Actor, terms: Terms): string {
  const who = actor === 'payer' ? terms.cashPayer : terms.assetSeller;
  return `Only ${who} can take this step. It is the ${actor} named in the signed terms, and the contract checks that rather than trusting this page.`;
}

/**
 * Wraps an action with the authorization decision.
 *
 * The refusal sentence is built here, once, so no call site can invent a vaguer
 * one — and so an action that is disabled always says which address would not
 * be disabled.
 */
function gated(
  snapshot: Snapshot,
  action: Omit<NextAction, 'enabled' | 'blocked'> & { readonly blocked?: string },
): NextAction {
  if (action.blocked !== undefined) {
    return { ...action, enabled: false, blocked: action.blocked };
  }
  if (action.call === undefined) return { ...action, enabled: false };
  if (snapshot.account === undefined) {
    return { ...action, enabled: false, blocked: notConnected(action.actor) };
  }
  if (!authorized(snapshot, action.actor)) {
    return { ...action, enabled: false, blocked: wrongAccount(action.actor, snapshot.terms) };
  }
  return { ...action, enabled: true };
}

/** A leg is on the Base side once the reservation exists and is announced. */
function assetPreparedOnBase(snapshot: Snapshot): boolean {
  const reservation = snapshot.reservation;
  if (reservation === undefined || reservation.owner === ZERO_ADDRESS) return false;
  return (
    reservation.announced &&
    snapshot.intendedReceiver !== undefined &&
    snapshot.intendedReceiver !== ZERO_ADDRESS
  );
}

function contestOpenUntil(snapshot: Snapshot): number {
  const filedAt = snapshot.dispositionCase?.filedAt ?? 0n;
  return Number(filedAt) + snapshot.contestWindowSeconds;
}

/**
 * The one next action.
 *
 * Order matters and is the protocol's own order: terminal first, then the
 * committed path, then the ready path, then preparation. Each branch reads
 * canonical state and never a flag this page set.
 */
export function nextAction(snapshot: Snapshot): NextAction {
  const settlement = snapshot.settlement;
  const state = settlement?.state ?? 'NONE';

  // ── Terminal ──────────────────────────────────────────────────────────────

  if (state === 'SETTLED') {
    if (snapshot.verifierClass === undefined) {
      return gated(snapshot, {
        kind: 'VERIFICATION_INCOMPLETE',
        title: 'Verify independently',
        detail:
          'The coordinator reports SETTLED. That is its own enum, and it is not the same claim as an ' +
          'independent verification: SETTLED_FINAL is a conclusion drawn by reading two chains and a ' +
          'guardian set, and no run has drawn it for this settlement yet.',
        actor: 'anyone',
        call: 'run-verifier',
      });
    }
    return gated(snapshot, {
      kind: 'SETTLEMENT_COMPLETE',
      title: 'Settled',
      detail:
        'Both legs executed and an independent verification agrees. Nothing further is required, and ' +
        'nothing can undo it.',
      actor: 'nobody',
    });
  }

  if (state === 'ABORTED' || state === 'ABORT_ISSUED') {
    return gated(snapshot, {
      kind: 'ABORTED',
      title: 'Aborted',
      detail: 'This settlement was aborted before commitment. Both legs return to their owners.',
      actor: 'nobody',
    });
  }

  // ── Held, and the disposition that is the only way out ────────────────────

  if (state === 'HELD' || state === 'CONTESTED') {
    const held = snapshot.dispositionCase;
    if (held === undefined || held.state === 'NONE') {
      return gated(snapshot, {
        kind: 'HELD_DISPOSITION_REQUIRED',
        title: 'Open a disposition case',
        detail:
          'Committed value could not be delivered under current compliance rules. The commitment stands ' +
          'and the released leg is not refunded. The held value moves only through an order signed by a ' +
          'registered authority.',
        actor: 'anyone',
        chainId: BASE_SEPOLIA,
        call: 'file-disposition',
      });
    }
    if (held.state === 'CONTESTED') {
      return gated(snapshot, {
        kind: 'DISPOSITION_CONTESTED',
        title: 'Contested',
        detail:
          'Two authorised orders name different outcomes. Nothing executes until a resolver with the ' +
          'authority class the policy requires picks one.',
        actor: 'nobody',
      });
    }
    if (held.state === 'EXECUTED') {
      return gated(snapshot, {
        kind: 'WAITING_FOR_REMOTE_RESOLUTION',
        title: 'Report the resolution',
        detail:
          'The disposition executed on the asset chain. The coordinator has not heard it yet, and the ' +
          'settlement stays HELD until it does.',
        actor: 'anyone',
        chainId: BASE_SEPOLIA,
        call: 'report-resolution',
      });
    }
    const openUntil = contestOpenUntil(snapshot);
    if (held.state === 'OPEN' && snapshot.nowSeconds < openUntil) {
      return gated(snapshot, {
        kind: 'CONTEST_WINDOW',
        title: 'Contest window open',
        detail:
          `An order is filed and rests until ${new Date(openUntil * 1000).toISOString()}. Without the wait, ` +
          'whichever relayer submitted first would decide the outcome, and two authorities who genuinely ' +
          'disagree would be adjudicated by gas price.',
        actor: 'nobody',
      });
    }
    return gated(snapshot, {
      kind: 'DISPOSITION_EXECUTABLE',
      title: 'Execute the disposition',
      detail:
        'The contest window has closed with one filed outcome. Execution re-reads the held leg and the ' +
        'host state version, and takes a fresh compliance proof at the moment of transfer.',
      actor: 'anyone',
      chainId: BASE_SEPOLIA,
      call: 'execute-disposition',
    });
  }

  // ── Committed: deliver both legs ──────────────────────────────────────────

  if (settlement?.decision === 'COMMIT') {
    if (settlement.cashOutcome === 'NONE') {
      return gated(snapshot, {
        kind: 'EXECUTE_CASH_RELEASE',
        title: 'Execute the cash release',
        detail:
          'The escrow reads the coordinator’s decision and pays the receiver. Permissionless: the escrow ' +
          'checks a compliance quorum for the receiver, not the identity of whoever sends the transaction.',
        actor: 'anyone',
        chainId: MONAD_TESTNET,
        call: 'release-cash',
      });
    }

    const reservation = snapshot.reservation;
    if (reservation !== undefined && !reservation.released && settlement.assetOutcome === 'NONE') {
      const commit = snapshot.messages.commit;
      if (!commit?.finalized) {
        return gated(snapshot, {
          kind: 'WAITING_FOR_FINALITY',
          title: 'Waiting for Monad economic finality',
          detail:
            'COMMIT was published. The adapter on Base refuses a VAA below FINALIZED, so the delivery ' +
            'waits for the guardian set to sign at that level rather than at first observation.',
          actor: 'nobody',
        });
      }
      return gated(snapshot, {
        kind: 'EXECUTE_ASSET_RELEASE',
        title: 'Execute the asset release',
        detail:
          'The adapter consumes the finalized COMMIT and delivers the reserved units. If Cleanverse ' +
          'refuses the receiver at this moment the leg is held rather than reverted, because a revert ' +
          'would leave the VAA unconsumed and the settlement stuck.',
        actor: 'anyone',
        chainId: BASE_SEPOLIA,
        call: 'release-asset',
      });
    }

    if (settlement.assetOutcome === 'NONE') {
      const resolution = snapshot.messages.assetResolution;
      if (resolution === undefined) {
        return gated(snapshot, {
          kind: 'WAITING_FOR_REMOTE_RESOLUTION',
          title: 'Report what the token did',
          detail:
            'The asset leg resolved on Base. The coordinator learns the outcome from an authenticated ' +
            'message rather than from a relayer’s word, so the adapter has to publish it.',
          actor: 'anyone',
          chainId: BASE_SEPOLIA,
          call: 'report-resolution',
        });
      }
      if (!resolution.finalized) {
        return gated(snapshot, {
          kind: 'WAITING_FOR_FINALITY',
          title: 'Waiting for Base economic finality',
          detail:
            'The asset leg reported its outcome. The coordinator refuses that message below FINALIZED, ' +
            'so the settlement’s terminal state waits for the guardian set.',
          actor: 'nobody',
        });
      }
      return gated(snapshot, {
        kind: 'WAITING_FOR_REMOTE_RESOLUTION',
        title: 'Record the asset outcome',
        detail:
          'The finalized resolution message is available. Consuming it on Monad is what moves the ' +
          'settlement to its terminal state.',
        actor: 'anyone',
        chainId: MONAD_TESTNET,
        call: 'record-leg-resolved',
      });
    }

    return gated(snapshot, {
      kind: 'WAITING_FOR_REMOTE_RESOLUTION',
      title: 'Both legs resolved',
      detail: 'The coordinator has both outcomes and is settling.',
      actor: 'nobody',
    });
  }

  // ── Ready: finality reached, commit is the next decision ──────────────────

  if (state === 'READY') {
    if (snapshot.nowSeconds > Number(snapshot.terms.commitDeadline)) {
      return gated(snapshot, {
        kind: 'DEADLINE_PASSED',
        title: 'The commit window has closed',
        detail:
          'Both legs are prepared but the commit deadline has passed, so the coordinator will refuse a ' +
          'COMMIT. The settlement can only be aborted, and both legs return to their owners.',
        actor: 'nobody',
      });
    }

    const fresh = snapshot.fresh;

    // The outage arm comes first, and the ordering is the whole point. An
    // unavailable answer carries no attestation, so it also carries no expiry —
    // and checking the expiry first would report the one thing that must never
    // be reported as "just ask again": nobody was asked, and nobody refused.
    if (fresh?.unavailable === true) {
      return gated(snapshot, {
        kind: 'FRESH_COMPLIANCE_REQUIRED',
        title: 'Compliance did not answer',
        detail:
          'Cleanverse could not be reached, so nobody was refused and nobody was cleared. An outage is ' +
          'the absence of a decision, and Conduit will not treat it as one.',
        actor: 'anyone',
        chainId: MONAD_TESTNET,
        call: 'run-fresh-compliance',
        blocked: 'No compliance decision exists. Ask again rather than committing on silence.',
      });
    }
    if (fresh === undefined || fresh.expiresAt <= snapshot.nowSeconds) {
      return gated(snapshot, {
        kind: 'FRESH_COMPLIANCE_REQUIRED',
        title: 'Run fresh compliance',
        detail:
          'Both legs are prepared and the source state is final. Compliance is asked again, now, with no ' +
          'application cache. The prepare-time answer cannot authorize this: attestations expire after ' +
          '900 seconds and the wait for Base finality is longer than that.',
        actor: 'anyone',
        chainId: MONAD_TESTNET,
        call: 'run-fresh-compliance',
      });
    }
    if (!fresh.eligible) {
      const first = fresh.refusals[0];
      return gated(snapshot, {
        kind: 'FRESH_COMPLIANCE_REQUIRED',
        title: 'Compliance refuses this settlement',
        detail:
          first === undefined
            ? 'A participant is not eligible at commit time.'
            : `${first.subject} — ${first.status}. ${first.detail}`,
        actor: 'anyone',
        chainId: MONAD_TESTNET,
        call: 'run-fresh-compliance',
        blocked:
          'COMMIT is not offered while a participant is refused. Committing here would create an ' +
          'obligation that cannot be delivered.',
      });
    }
    if (!snapshot.commitSimulated) {
      return gated(snapshot, {
        kind: 'COMMIT_REQUIRED',
        title: 'Checking the commit against the coordinator',
        detail:
          'A fresh compliance answer exists and is signed. The coordinator is being asked whether it ' +
          'accepts the proof before a wallet is asked to send anything.',
        actor: 'anyone',
        chainId: MONAD_TESTNET,
        call: 'issue-commit',
        blocked: 'Simulating the commit against the deployed coordinator.',
      });
    }
    return gated(snapshot, {
      kind: 'READY_TO_COMMIT',
      title: 'Commit settlement',
      detail:
        'Both legs are prepared, the source state is final, compliance answered again, and the ' +
        'coordinator accepts the proof. COMMIT is the irreversible settlement decision.',
      actor: 'anyone',
      chainId: MONAD_TESTNET,
      call: 'issue-commit',
    });
  }

  // ── Preparation ───────────────────────────────────────────────────────────

  const bothSigned = snapshot.signatures.payer && snapshot.signatures.seller;
  const nothingPrepared = settlement === undefined || state === 'NONE';

  if (!bothSigned && nothingPrepared && !assetPreparedOnBase(snapshot)) {
    const missing = snapshot.signatures.payer ? 'seller' : 'payer';
    return gated(snapshot, {
      kind: 'AWAITING_SIGNATURES',
      title: `Waiting for the ${missing} to sign`,
      detail:
        'The coordinator checks both intent signatures at COMMIT. Preparing a leg before the other party ' +
        'has agreed would lock value in a settlement that can only abort, so Conduit does not offer it.',
      actor: 'nobody',
    });
  }

  if (snapshot.nowSeconds > Number(snapshot.terms.prepareDeadline)) {
    return gated(snapshot, {
      kind: 'DEADLINE_PASSED',
      title: 'The preparation window has closed',
      detail:
        'The prepare deadline in the signed terms has passed. Neither leg can be prepared against these ' +
        'terms; compose a new settlement.',
      actor: 'nobody',
    });
  }

  // The asset leg goes first. Base finality is the long pole — observed between
  // 999 and 1485 seconds on this deployment — and starting it last would add
  // that wait to the end rather than overlapping it with the cash leg.
  if (!assetPreparedOnBase(snapshot)) {
    const available = snapshot.holdings.availableAsset;
    const short =
      available !== undefined && available < snapshot.terms.assetAmount
        ? `The seller holds ${available.toString()} unreserved base units and this settlement needs ` +
          `${snapshot.terms.assetAmount.toString()}. Reserved units are excluded: they belong to other settlements.`
        : undefined;
    return gated(snapshot, {
      kind: 'RESERVE_ASSET',
      title: 'Reserve the asset',
      detail:
        'The seller reserves the units against this settlement id and the adapter announces the leg. ' +
        'Announcing closes the seller’s unilateral exit: from that point only a canonical ABORT frees them.',
      actor: 'seller',
      chainId: BASE_SEPOLIA,
      call: 'reserve-asset',
      ...(short === undefined ? {} : { blocked: short }),
    });
  }

  if (!settlement?.cashPrepared) {
    const balance = snapshot.holdings.cashBalance;
    const short =
      balance !== undefined && balance < snapshot.terms.cashAmount
        ? `The payer holds ${balance.toString()} base units and this settlement needs ` +
          `${snapshot.terms.cashAmount.toString()}.`
        : undefined;
    return gated(snapshot, {
      kind: 'LOCK_CASH',
      title: 'Lock the settlement cash',
      detail:
        'The payer’s units enter CashEscrow, which asserts the exact balance delta it received and tells ' +
        'the coordinator directly. The coordinator never takes a relayer’s word that cash arrived.',
      actor: 'payer',
      chainId: MONAD_TESTNET,
      call: 'lock-cash',
      ...(short === undefined ? {} : { blocked: short }),
    });
  }

  // Both legs exist on their own chains. What is left is the crossing.
  const prepared = snapshot.messages.assetPrepared;
  if (!settlement.assetPrepared) {
    if (prepared === undefined) {
      return gated(snapshot, {
        kind: 'AWAITING_ASSET_PREPARATION',
        title: 'Locating the ASSET_PREPARED message',
        detail:
          'The asset leg is prepared on Base and published a message. Its sequence lives in an event ' +
          'rather than in contract state, so it is recovered from the transaction that published it.',
        actor: 'nobody',
      });
    }
    if (!prepared.finalized) {
      return gated(snapshot, {
        kind: 'WAITING_FOR_FINALITY',
        title: 'Waiting for Base economic finality',
        detail:
          'ASSET_PREPARED was observed within seconds. The coordinator refuses it below FINALIZED, and ' +
          'that threshold is an immutable in the deployed bytecode rather than a policy this page applies.',
        actor: 'nobody',
      });
    }
    return gated(snapshot, {
      kind: 'RECORD_ASSET_PREPARED',
      title: 'Consume the finalized message',
      detail:
        'The finalized ASSET_PREPARED VAA is available. Consuming it on Monad is what makes the ' +
        'settlement READY. Anyone may relay it; the coordinator verifies the guardian signatures, the ' +
        'emitter, the deployment and the message type itself.',
      actor: 'anyone',
      chainId: MONAD_TESTNET,
      call: 'record-asset-prepared',
    });
  }

  return gated(snapshot, {
    kind: 'AWAITING_CASH_PREPARATION',
    title: 'Waiting',
    detail: `The coordinator reports ${state}.`,
    actor: 'nobody',
  });
}

export interface Fact {
  readonly label: string;
  readonly detail: string;
  readonly done: boolean;
}

/**
 * What has happened, in the order it happens.
 *
 * Separate from the next action on purpose: a person looking at their own money
 * needs to see the whole ladder, not only the rung they are on.
 */
export function history(snapshot: Snapshot): readonly Fact[] {
  const settlement = snapshot.settlement;
  const reservation = snapshot.reservation;
  const asset = snapshot.messages.assetPrepared;
  const commit = snapshot.messages.commit;

  // The coordinator verifies both intent signatures when it accepts a COMMIT, so
  // a COMMIT on chain proves them whether or not this deployment's intent store
  // kept a copy. Absence from the store is a gap in the store, not a missing
  // signature.
  const committed = settlement?.decision === 'COMMIT';
  const signaturesStored = snapshot.signatures.payer && snapshot.signatures.seller;
  const signedDetail = signaturesStored
    ? 'The payer and the seller each signed the same digest, and that digest is the settlement id.'
    : committed
      ? 'The coordinator verified both signatures when it accepted COMMIT. This deployment’s store kept no copy.'
      : snapshot.signatures.payer || snapshot.signatures.seller
        ? `payer ${snapshot.signatures.payer ? 'signed' : 'not signed'}, seller ${snapshot.signatures.seller ? 'signed' : 'not signed'}`
        : 'neither signature is stored for this settlement yet';

  const facts: Fact[] = [
    {
      label: 'Both parties signed',
      detail: signedDetail,
      done: signaturesStored || committed,
    },
    {
      label: 'Asset reserved and announced',
      detail:
        reservation !== undefined && reservation.owner !== ZERO_ADDRESS
          ? `${reservation.amount.toString()} base units reserved${reservation.announced ? ', announced' : ''}`
          : 'no reservation on this settlement id',
      done: assetPreparedOnBase(snapshot),
    },
    {
      label: 'Cash escrowed',
      detail:
        snapshot.cashLeg === undefined || snapshot.cashLeg.state === 'NONE'
          ? 'the escrow holds nothing for this settlement'
          : `${snapshot.cashLeg.amount.toString()} base units, leg ${snapshot.cashLeg.state}`,
      done: settlement?.cashPrepared === true,
    },
    {
      label: 'ASSET_PREPARED finalized and consumed',
      detail:
        asset === undefined
          ? 'no message observed yet'
          : `sequence ${asset.sequence}, ${asset.finalized ? 'finalized' : 'awaiting economic finality'}`,
      done: settlement?.assetPrepared === true,
    },
    {
      label: 'Fresh compliance at commit time',
      detail:
        snapshot.fresh === undefined
          ? committed
            ? 'The coordinator accepted a compliance attestation with COMMIT. It was not asked again in this visit.'
            : 'not asked in this visit'
          : snapshot.fresh.unavailable
            ? 'Cleanverse did not answer — that is not a refusal'
            : snapshot.fresh.eligible
              ? `every participant eligible at ${snapshot.fresh.checkedAt}`
              : 'a participant is refused',
      done: snapshot.fresh?.eligible === true || settlement?.decision === 'COMMIT',
    },
    {
      label: 'COMMIT issued',
      detail:
        settlement?.decision === 'COMMIT'
          ? commit === undefined
            ? 'the canonical decision exists'
            : `published as sequence ${commit.sequence}`
          : 'no canonical decision yet',
      done: settlement?.decision === 'COMMIT',
    },
    {
      label: 'Cash released',
      detail: settlement === undefined ? 'unknown' : `leg outcome ${settlement.cashOutcome}`,
      done: settlement?.cashOutcome === 'RELEASED',
    },
    {
      label: 'Asset released',
      detail: settlement === undefined ? 'unknown' : `leg outcome ${settlement.assetOutcome}`,
      done: settlement?.assetOutcome === 'RELEASED',
    },
  ];

  return facts;
}

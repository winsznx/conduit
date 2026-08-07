import { ApassStatus } from './codes.js';

/**
 * A-Pass normalization. PRD 2.1.
 *
 * Cleanverse exposes a narrower native state than earlier Conduit drafts
 * assumed: `status` is only `1` (active) or `2` (frozen), plus an
 * `expirationTime`. There is no native `revoked`, `lapsed`, `grace`, or
 * `restored`. Conduit derives the richer view here, in one place, so no caller
 * invents its own reading of the same two fields.
 */

export const NormalizedApassStatus = {
  /** No A-Pass record for the wallet. */
  MISSING: 'MISSING',
  /** `status == 1` and not yet expired. */
  ACTIVE: 'ACTIVE',
  /** Active, but inside the warning window. Still eligible. */
  EXPIRING: 'EXPIRING',
  /** `expirationTime <= now`. */
  EXPIRED: 'EXPIRED',
  /** `status == 2`. */
  FROZEN: 'FROZEN',
  /** The API, the chain, or the verification result was unavailable. */
  UNKNOWN: 'UNKNOWN',
} as const;

export type NormalizedApassStatusValue =
  (typeof NormalizedApassStatus)[keyof typeof NormalizedApassStatus];

/**
 * PRD 2.1: `RESTRICTED = MISSING | EXPIRED | FROZEN | UNKNOWN`.
 *
 * `UNKNOWN` is in that set by default, which is what "fail closed" means here:
 * an unreachable API denies settlement rather than permitting it. A policy may
 * in principle treat `UNKNOWN` differently, and PRD 2.1 says the default is
 * fail-closed, so that is the only behaviour implemented.
 */
const RESTRICTED: ReadonlySet<NormalizedApassStatusValue> = new Set([
  NormalizedApassStatus.MISSING,
  NormalizedApassStatus.EXPIRED,
  NormalizedApassStatus.FROZEN,
  NormalizedApassStatus.UNKNOWN,
]);

export function isRestricted(status: NormalizedApassStatusValue): boolean {
  return RESTRICTED.has(status);
}

export interface ApassRecord {
  readonly status: number;
  /** Unix seconds, UTC. */
  readonly expirationTime: number;
  readonly tier: number;
  readonly subTier: number;
  readonly group: string;
  readonly subGroup: string;
  readonly currentKycHash: string;
  readonly countries: readonly string[];
}

export interface NormalizeOptions {
  /** Unix seconds. Injected rather than read from the clock so results are reproducible. */
  readonly now: number;
  /** Seconds before expiry at which an active pass is reported as EXPIRING. */
  readonly warningWindowSeconds: number;
}

export interface NormalizedApass {
  readonly status: NormalizedApassStatusValue;
  readonly restricted: boolean;
  readonly expiresAt: number | undefined;
  readonly secondsUntilExpiry: number | undefined;
}

/**
 * Evaluation order is FROZEN, then EXPIRED, then EXPIRING, then ACTIVE.
 *
 * PRD 2.1 lists the states as definitions rather than as an evaluation order,
 * and two of them can hold at once: a pass may be both frozen and past its
 * expiry. Either label yields `restricted`, so the settlement decision is
 * identical, but the label reaches the audit package and a held-case operator
 * reads it.
 *
 * Frozen wins because it is an administrative action taken against this wallet,
 * while expiry is the passage of time. Telling an operator "expired" about a
 * wallet somebody deliberately froze would point the investigation at a renewal
 * that will not fix anything.
 */
export function normalizeApass(
  record: ApassRecord | undefined,
  options: NormalizeOptions,
): NormalizedApass {
  if (record === undefined) {
    return {
      status: NormalizedApassStatus.MISSING,
      restricted: true,
      expiresAt: undefined,
      secondsUntilExpiry: undefined,
    };
  }

  const { now, warningWindowSeconds } = options;
  const expiresAt = record.expirationTime;
  const secondsUntilExpiry = expiresAt - now;

  const status = ((): NormalizedApassStatusValue => {
    if (record.status === ApassStatus.FROZEN) return NormalizedApassStatus.FROZEN;
    if (expiresAt <= now) return NormalizedApassStatus.EXPIRED;
    if (record.status !== ApassStatus.ACTIVE) return NormalizedApassStatus.UNKNOWN;
    return secondsUntilExpiry <= warningWindowSeconds
      ? NormalizedApassStatus.EXPIRING
      : NormalizedApassStatus.ACTIVE;
  })();

  return {
    status,
    restricted: isRestricted(status),
    expiresAt,
    secondsUntilExpiry,
  };
}

/**
 * PRD 2.1: "`RESTORED` is an event, not a persistent Cleanverse status."
 *
 * Nothing in the API reports a restoration. It is only visible as a transition
 * between two observations Conduit made itself, which is why this takes a
 * previous status rather than reading a field.
 */
export function isRestorationEvent(
  previous: NormalizedApassStatusValue | undefined,
  current: NormalizedApassStatusValue,
): boolean {
  if (previous === undefined) return false;

  const wasRestricted =
    previous === NormalizedApassStatus.FROZEN || previous === NormalizedApassStatus.EXPIRED;
  const isNowUsable =
    current === NormalizedApassStatus.ACTIVE || current === NormalizedApassStatus.EXPIRING;

  return wasRestricted && isNowUsable;
}

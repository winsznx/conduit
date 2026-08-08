# Threat register

Every threat in PRD 14.3, bound to the fundamental invariants of PRD 14.4 that it would break
and to the phase whose gate must demonstrate the control.

This file is a skeleton. Phase 00 delivers the register and the binding; the analysis, the
adversarial tests, and the residual-risk statements land in the phases named below and are
completed in phase 09. A row that stays `NOT ANALYSED` past its phase is a failed gate, not a
backlog item.

Status values: `NOT ANALYSED`, `ANALYSED`, `MITIGATED`, `ACCEPTED`. An `ACCEPTED` row requires a
written waiver in [docs/security-waivers](../security-waivers/README.md).

## Register

| ID   | Threat (PRD 14.3)                         | Surface     | Invariants at risk | Gate phase | Status       |
| ---- | ----------------------------------------- | ----------- | ------------------ | ---------- | ------------ |
| T-01 | forged Cleanverse response                | Cleanverse  | I8, I11            | 05         | NOT ANALYSED |
| T-02 | stolen API key                            | Cleanverse  | I8                 | 01         | NOT ANALYSED |
| T-03 | AES key disclosure                        | Cleanverse  | I8                 | 01         | NOT ANALYSED |
| T-04 | webhook spoofing                          | Cleanverse  | I11                | 05         | NOT ANALYSED |
| T-05 | webhook replay                            | Cleanverse  | I11                | 05         | NOT ANALYSED |
| T-06 | response-code confusion                   | Cleanverse  | I8                 | 01         | NOT ANALYSED |
| T-07 | stale compliance attestation              | Attestation | I8                 | 05         | NOT ANALYSED |
| T-08 | compromised compliance signer             | Attestation | I8                 | 09         | NOT ANALYSED |
| T-09 | signer collusion                          | Attestation | I8                 | 09         | NOT ANALYSED |
| T-10 | VAA replay                                | Wormhole    | I6                 | 02         | NOT ANALYSED |
| T-11 | wrong emitter                             | Wormhole    | I6, I12            | 02         | NOT ANALYSED |
| T-12 | wrong chain                               | Wormhole    | I6, I12            | 02         | NOT ANALYSED |
| T-13 | wrong deployment                          | Wormhole    | I6, I7             | 02         | NOT ANALYSED |
| T-14 | stale VAA                                 | Wormhole    | I5, I6             | 02         | NOT ANALYSED |
| T-15 | guardian-set transition                   | Wormhole    | I6                 | 09         | NOT ANALYSED |
| T-16 | reorg                                     | Chain       | I6, I10            | 06         | NOT ANALYSED |
| T-17 | source release followed by refund         | Settlement  | I1, I4, I5         | 04         | NOT ANALYSED |
| T-18 | destination release followed by refund    | Settlement  | I2, I4, I5         | 04         | NOT ANALYSED |
| T-19 | duplicate settlement ID                   | Settlement  | I3, I7             | 04         | NOT ANALYSED |
| T-20 | signature replay                          | Settlement  | I3                 | 04         | NOT ANALYSED |
| T-21 | EIP-1271 malicious wallet                 | Settlement  | I3                 | 04         | NOT ANALYSED |
| T-22 | token callback reentrancy                 | Token       | I1, I2             | 04         | NOT ANALYSED |
| T-23 | fee-on-transfer token                     | Token       | I1                 | 03         | NOT ANALYSED |
| T-24 | paused A-Token                            | Cleanverse  | I8                 | 05         | NOT ANALYSED |
| T-25 | paused Validator pool                     | Cleanverse  | I8                 | 05         | NOT ANALYSED |
| T-26 | expired A-Pass between prepare and commit | Cleanverse  | I8                 | 05         | NOT ANALYSED |
| T-27 | frozen recipient after commit             | Disposition | I8, I9             | 07         | NOT ANALYSED |
| T-28 | operator griefing                         | Disposition | I9                 | 07         | NOT ANALYSED |
| T-29 | relayer censorship                        | Relayer     | I12                | 06         | NOT ANALYSED |
| T-30 | gas exhaustion                            | Chain       | I10                | 09         | NOT ANALYSED |
| T-31 | malicious substitute receiver             | Disposition | I8, I9             | 07         | NOT ANALYSED |
| T-32 | conflicting disposition orders            | Disposition | I9                 | 07         | NOT ANALYSED |
| T-33 | database projection divergence            | Off-chain   | I11                | 06         | NOT ANALYSED |
| T-34 | report download URL expiry                | Evidence    | I13                | 08         | NOT ANALYSED |
| T-35 | PII leakage in logs                       | Off-chain   | I13                | 09         | NOT ANALYSED |
| T-36 | unauthorized admin upgrade                | Governance  | I10                | 09         | NOT ANALYSED |
| T-37 | accidental token rescue                   | Governance  | I1, I2             | 09         | NOT ANALYSED |

## Invariants under protection (PRD 14.4)

| ID  | Invariant                                                              |
| --- | ---------------------------------------------------------------------- |
| I1  | cash locked = cash released + cash returned + cash held + protocol fee |
| I2  | asset locked = asset released + asset returned + asset held            |
| I3  | settlement receives at most one COMMIT or one ABORT                    |
| I4  | no refund after COMMIT                                                 |
| I5  | no release after terminal ABORT                                        |
| I6  | every accepted VAA is valid, expected, and consumed once               |
| I7  | both legs bind the same intent hash                                    |
| I8  | no terminal destination is used without current eligibility            |
| I9  | held value remains claimable only through Disposition Kernel           |
| I10 | state transitions are monotonic                                        |
| I11 | application database cannot authorize on-chain value movement          |
| I12 | relayer cannot forge remote state                                      |
| I13 | no evidence artifact is represented as a different report type         |

Every invariant above is referenced by at least one threat row, and `tests/docs.test.ts`
fails if that stops being true or if a threat is dropped from this register while the PRD
still lists it.

---

# v1.1 override supplement

`CONDUIT_PRD_v1.1_OVERRIDE.md`, adopted in [ADR-0004](../adr/0004-prd-v1-1-override-adoption.md),
replaces escrow custody on the Arbitrum leg with a token-native reservation inside a real
Cleanverse CVA, and names Cloudflare Workers plus Supabase as the runtime. Neither change is
covered by PRD 14.3, because both postdate it.

The reservation model trades one failure class for another. Escrow custody fails by holding the
wrong balance, which is easy to assert. Reservation fails by letting a seller spend units that
are notionally reserved, which requires that _every_ path out of an ERC-20 balance respects the
reservation — including paths added later.

## Asset-leg states (override section 11)

The reservation invariants below constrain movement between these states, so they are named here
rather than left implicit. The canonical state machine lands in `packages/domain` in phase 04.

```text
UNRESERVED → RESERVED → COMMITTED → RELEASED
                 │           │
                 │           ├─→ HELD → DISPOSED
                 │           └─→ DISPOSED
                 └─→ CANCELLED        (pre-COMMIT only)
```

`CANCELLED` is reachable only before canonical COMMIT. After COMMIT the only exits are
`RELEASED` and `HELD`, and `HELD` leaves only through `DISPOSED`.

## Reservation invariants (override sections 5 and 11)

| ID  | Invariant                                                                       |
| --- | ------------------------------------------------------------------------------- |
| R1  | transferable balance = balanceOf(owner) − totalReserved(owner)                  |
| R2  | a reservation is cancellable only before canonical COMMIT                       |
| R3  | a reservation is releasable only after canonical COMMIT                         |
| R4  | reserved units never return to freely spendable seller balance after COMMIT     |
| R5  | every actual CVA transfer passes `policy.canTransfer` at the moment of transfer |

R4 is the asset-side mirror of I4. Together they close the double-payout window on both legs.

## Register

| ID   | Threat                                                                                    | Surface     | Invariants at risk | Gate phase | Status       |
| ---- | ----------------------------------------------------------------------------------------- | ----------- | ------------------ | ---------- | ------------ |
| V-01 | reserved units spent through an ERC-20 path that skips reservation accounting             | CVA token   | R1, I2             | 03         | NOT ANALYSED |
| V-02 | reservation cancelled after canonical COMMIT                                              | CVA token   | R2, R4, I4         | 03         | NOT ANALYSED |
| V-03 | reservation released without a canonical COMMIT proof                                     | CVA token   | R3, I6             | 03         | NOT ANALYSED |
| V-04 | reservation dispositioned more than once                                                  | Disposition | R4, I9             | 07         | NOT ANALYSED |
| V-05 | custom CVA logic reaching `_update` without calling `policy.canTransfer`                  | CVA token   | R5, I8             | 03         | NOT ANALYSED |
| V-06 | RuleV2 change altering the economic terms a signed intent already bound                   | CCP policy  | I7, I8             | 05         | NOT ANALYSED |
| V-07 | legacy country array treated as the canonical RuleV2 `poolCountryBitmap`                  | CCP policy  | I8                 | 05         | NOT ANALYSED |
| V-08 | CVA registration signature replayed against a different chain or token address            | Cleanverse  | I8                 | 03         | NOT ANALYSED |
| V-09 | Supabase service-role credential reaching browser code or a client bundle                 | Off-chain   | I11                | 06         | NOT ANALYSED |
| V-10 | Cloudflare Worker secret exposed through a build artifact, log, or preview deployment     | Off-chain   | I11, I13           | 06         | NOT ANALYSED |
| V-11 | Cloudflare Queue at-least-once delivery executing a non-idempotent settlement side effect | Off-chain   | I3, I10            | 06         | NOT ANALYSED |

V-07 deserves a note. Override section 4 says the compatibility API may still expose country
arrays while RuleV2 represents them as a bitmap, and explicitly forbids inventing bit positions.
A wrong bit position does not fail loudly — it silently authorizes or denies the wrong
jurisdiction, which is invariant I8 breaking while every test still passes. ASM-020 keeps it
open until the official policy contract supplies the mapping.

## Realised defect classes

Every row above describes a threat somebody imagined. The five below reached
deployed contracts. They are kept as their own section because a threat that was
real once is a different kind of evidence from one that was anticipated, and
because each of them now carries an invariant a future change has to break
loudly rather than quietly.

`contracts/test/ExploitRegressions.t.sol` proves each as an attack rather than
as a repair: the exploit is driven to the exact point where the guard stands,
shown to be otherwise complete, and then shown refused. A test that only
exercises the fixed path proves the fixed path works; it does not prove the
guard is what stops the attack, and it fails uninformatively when someone
removes the guard for a plausible reason.

| ID   | Realised defect                                                                        | Surface       | Invariants that were breakable | Status                              |
| ---- | -------------------------------------------------------------------------------------- | ------------- | ------------------------------ | ----------------------------------- |
| D-01 | phantom cash preparation: `recordCashPrepared` permissionless and the producer missing | Coordinator   | I1, I2, I11                    | CLOSED — ADR-0016, regression A     |
| D-02 | cross-chain knowledge race on reservation cancellation                                 | CVA token     | R2, R4, I4                     | CLOSED — ADR-0016, regression B     |
| D-03 | caller-supplied resolution truth: `reportResolution(bool released)`                    | Asset adapter | I1, I10, I11, I13              | CLOSED — ADR-0016, regression C     |
| D-04 | HELD value with no reachable disposition path                                          | Both legs     | I9                             | CLOSED — ADR-0016, regression D     |
| D-05 | cross-chain address collision treated as one identity                                  | Off-chain     | I13                            | CLOSED — ADR-0018, identity.test.ts |

### D-01 — phantom cash preparation

**Required invariant.** READY is unreachable unless the cash escrow has actually
locked the exact amount the intent names, and the authorized production path is
what records it.

Both halves are load-bearing. Restricting the caller is worthless if the
permitted caller can report cash it does not hold, so `prepareCash` takes the
cash and reports in the same transaction with an exact balance delta:
`cashPrepared == true` implies the escrow holds the amount. Wiring the producer
is worthless if anyone else may also call, so the coordinator refuses every
other caller.

### D-02 — cross-chain knowledge race on reservation cancellation

**Required invariant.** Once a reservation has been announced into the canonical
settlement protocol, unilateral cancellation is impossible. Only a canonical
pre-COMMIT ABORT may unwind it.

`committed` is the asset chain's _knowledge_ of the COMMIT and arrives with a
relayer. The COMMIT exists earlier and the cash moves against it immediately, so
any gate that waits for local knowledge leaves a window an untrusted relayer
times. The announcement is the last moment this chain can be certain no COMMIT
exists, so the gate sits there.

`SETTLEMENT_ROLE` bypasses the announcement gate, which is correct for an ABORT
arriving through the adapter and catastrophic if a party ever holds it. The
preflight checks against the live deployment that no EOA does.

### D-03 — caller-supplied resolution truth

**Required invariant.** A terminal resolution is derived from authenticated
contract state or from the message type itself, never from a caller-supplied
boolean describing what supposedly happened.

The consumer cannot defend against this and the regression proves it: a false
ASSET_RELEASED from the real peer, on the real chain, for a real committed
settlement, at FINALIZED, passes every transport check there is. Canonical state
then reads SETTLED against an undelivered bond, and the true report is refused
afterwards with `LegAlreadyResolved` — the correct state permanently locked out
by the false one. The defence has to be at the producer.

### D-04 — HELD value with no reachable disposition path

**Required invariant.** Every HELD state has at least one reachable, authorized
resolution path, and taking it preserves: no post-COMMIT refund, exact
conservation, and a compliance check on the eventual receiver.

`resolveHeldCash` and `resolveHeldAsset` are FR-012's `REVERIFY_AND_RESUME`. The
destination is the one the intent named and is not a parameter, so neither can
rebind a receiver or substitute an asset; the other five order types need the
authority registry phase 07 delivers.

### D-05 — cross-chain address collision

**Required invariant.** Identity is `(chainId, address)`, or for a Wormhole
emitter `(wormholeChainId, bytes32)`. Never an address alone.

The live deployment has `0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE` as the
SettlementCoordinator on Monad Testnet and the RWACVASettlementAdapter on Base
Sepolia, because the deployer's nonce lined up across two chains. Anything
keying a contract, peer, balance, event, cache entry, idempotency key, explorer
link, or row by address alone conflates two different contracts with two
different roles, silently. See ADR-0018.

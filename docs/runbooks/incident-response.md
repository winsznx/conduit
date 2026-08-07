# Runbook: incident response

**Status:** skeleton — alert-to-action map fixed, thresholds and dashboards added in phase 09
**Required by:** PRD 16.3, PRD 19 phase 09
**Last drill:** never

## Alert to first action

PRD 16.3 fixes the alert list. This table fixes what each one means before anyone has to decide
under pressure.

| Alert                                | First action                                                                           | Escalates to                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Value held above threshold           | Open the disposition cases and check each one has an authority path                    | [emergency-revocation](./emergency-revocation.md) if unexplained |
| Settlement stuck beyond SLA          | Read chain state directly; the database may be the stuck component                     | —                                                                |
| Compliance signer quorum unavailable | Halt commits; do not lower quorum                                                      | [key-rotation](./key-rotation.md)                                |
| Cleanverse error-rate spike          | Check whether failures are business codes or transport; `valid:false` is not an outage | —                                                                |
| Wormhole VAA unavailable             | Confirm publish succeeded on the source chain before assuming transport failure        | —                                                                |
| Chain cursor lag                     | Check RPC provider disagreement before restarting the indexer                          | —                                                                |
| Database outbox backlog              | Check for poison jobs in dead-letter state                                             | —                                                                |
| Contract pause                       | Confirm who paused and why, on-chain                                                   | [emergency-revocation](./emergency-revocation.md)                |
| Signer-set change                    | Confirm it matches a scheduled rotation                                                | [emergency-revocation](./emergency-revocation.md)                |
| Emitter configuration change         | Treat as compromise until proven scheduled                                             | [emergency-revocation](./emergency-revocation.md)                |
| Balance / accounting mismatch        | Stop. Verify I1 and I2 from chain state before any action                              | [emergency-revocation](./emergency-revocation.md)                |
| Public verifier disagreement         | Trust the verifier, not the application                                                | —                                                                |

## Standing rules

- **Chain state is the incident record.** The application database is a projection (invariant
  I11). Any incident narrative built from the database alone is unverified.
- **A worker timeout never authorizes a refund** (PRD FR-008). If a leg looks stuck, the answer
  is canonical coordinator state, not a timeout.
- **`valid:false` from `validator/verify` is a correct answer**, not an API failure. Treating it
  as an outage is threat T-06, response-code confusion.
- **Held is a safe state.** Value in `HELD` is accounted for and conserved. Resolving it
  incorrectly is worse than leaving it held.

## Timeline discipline

Every incident produces, in UTC:

- first alert timestamp;
- settlements and disposition cases touched, by ID;
- every operator action with its transaction hash;
- the terminal state each affected settlement reached;
- what changed in the threat register as a result.

## To be completed

Thresholds, dashboard links, on-call rotation, and the staging drill result. PRD 19 phase 09
requires a staging incident drill before the phase can pass.

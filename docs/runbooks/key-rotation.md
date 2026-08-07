# Runbook: key rotation

**Status:** skeleton — procedure fixed, commands added by the phase that creates each key
**Required by:** PRD 17.4
**Last drill:** never

## Key classes

PRD 17.4 and PRD 8.2 require separated roles. No EOA holds more than one.

| Key                | Holds                              | Rotation path                                                               | Introduced |
| ------------------ | ---------------------------------- | --------------------------------------------------------------------------- | ---------- |
| Deployer           | Deployment authority only          | New key, redeploy through `SettlementFactory`                               | Phase 04   |
| Owner              | `Ownable2Step` on core contracts   | `transferOwnership` → `acceptOwnership`, multisig in staging and production | Phase 04   |
| Compliance signers | Quorum for `ComplianceAttestation` | On-chain signer-set registry update behind a timelock                       | Phase 05   |
| Relayer            | Gas only, no protocol authority    | Replace freely; no on-chain change needed                                   | Phase 06   |
| Evidence worker    | Reads Cleanverse, writes artifacts | Replace credential, re-run verification                                     | Phase 08   |
| Cleanverse API key | Server-side secret                 | Reissue with Cleanverse, update secrets manager                             | Phase 01   |

## Preconditions

1. The replacement key exists in KMS/HSM and its public identity is known.
2. No settlement is in `COMMIT_ISSUED` or `HELD` awaiting an action from the key being rotated.
3. The timelock delay for the affected role is understood and scheduled.
4. `docs/implementation-status.md` records the current phase state.

## Procedure

1. Announce the rotation window and the affected role.
2. Add the new identity alongside the old one where the role supports coexistence — compliance
   signers do, the contract owner does not.
3. Wait out the timelock. Do not shorten it.
4. Verify the new identity produces an accepted signature or transaction on a non-production
   path first.
5. Remove the old identity.
6. Confirm removal on-chain, not only in the application database — invariant I11 means the
   database is not evidence.
7. Update the deployment manifest and `docs/adr/` if the signer set is part of a published
   configuration.
8. Record the rotation in the audit log.

## Never, during rotation

- Never leave the compliance signer set below quorum. PRD 16.3 alerts on it, and settlement
  halts rather than degrading.
- Never rotate the owner and the compliance signer set in the same window; a failure in one
  becomes unattributable.
- Never grant the relayer key protocol authority "temporarily" to unblock a rotation. Invariant
  I12 says the relayer cannot forge remote state, and a temporary exception is a permanent one.
- Never rotate a key while a disposition case is `CONTESTED`.

## Verification

- The old identity's signature is rejected on-chain.
- The new identity's signature is accepted on-chain.
- `settlement_state_total` shows no settlement stuck across the window.
- The public verifier reaches the same terminal answer before and after.

## To be completed

Exact commands, KMS key identifiers, timelock durations, and the staging drill result. Phase 09
cannot pass until this runbook has been executed end to end in staging.

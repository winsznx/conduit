# @conduit-protocol/verifier

Database-independent settlement verifier.

| Field           | Value                            |
| --------------- | -------------------------------- |
| Specification   | PRD FR-014                       |
| Implemented in  | Phase 08                         |
| Phase 00 status | Structure only, no product logic |

Phase 00 ships this workspace with an entry point, a strict TypeScript project,
and workspace linkage so the repository-wide typecheck, lint, and test gates
cover it from the first commit. See [docs/implementation-status.md](../../docs/implementation-status.md).

## What a verification proves, and what it does not

A verification reads the deployment manifests, two chain RPCs and the Wormhole
guardian set. It reads no application database, and `SETTLED_FINAL` is its own
classification rather than a value any contract stores — ADR-0017.

It proves, from those sources alone:

```text
the deployed code hashes match the committed manifests
the coordinator's canonical state, and that both legs agree with it
that every message it found is authentic, final, and consumed exactly once
that every message the canonical state implies was actually found
that no block range it needed went unread
```

It does not prove that the compliance attestation behind a COMMIT was honestly
obtained. The contract checks that an authorised signer asserted eligibility and
that the assertion was bound to this settlement and still in date; nothing on
chain can check that the signer asked Cleanverse, or that Cleanverse answered
that way. The `evidenceHash` committed on chain lets a reader who already holds
the response confirm it was not swapped afterwards, which is a narrower and real
guarantee.

With the current deployment's quorum of one, that gap is a trust assumption in
the operator of the attestation signer. It is recorded as T-08 and T-09 in
[the threat register](../../docs/threat-model/threat-register.md) and waived
explicitly in
[docs/security-waivers/attestation-signer-quorum.md](../../docs/security-waivers/attestation-signer-quorum.md).

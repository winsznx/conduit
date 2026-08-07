# Evidence

PRD FR-013 lists what every settlement must produce, and PRD 9.7 fixes the artifact labels that
may never be interchanged.

## Artifact labels

| Label                           | Source                                                    | Never                                                |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `CLEANVERSE_TRANSACTION_REPORT` | `download_travel_rule` with an A-Token transfer hash      | labelled as a Travel Rule report                     |
| `CLEANVERSE_TRAVEL_RULE_REPORT` | `download_travel_rule` with a withdrawal transaction hash | produced for anything but a real withdrawal          |
| `CONDUIT_COMPLIANCE_ENVELOPE`   | Conduit, from hashed Cleanverse responses                 | described as a Cleanverse-native cross-chain package |
| `CONDUIT_SETTLEMENT_AUDIT`      | Conduit                                                   | presented as an independent attestation              |

PRD 2.3 is explicit: Cleanverse V5.6 documents no generic cross-chain Travel Rule endpoint. No
UI, README, demo, or submission text may claim otherwise unless a later official endpoint is
demonstrated. Invariant I13 makes mislabelling a protocol violation, not a copy error.

## What lives here

Committed:

- this README;
- evidence _schemas_ and their fixtures, from phase 08.

Not committed:

- generated artifacts. They are content-addressed and published to object storage per PRD 17.3,
  and `docs/evidence/artifacts/` is gitignored. Committing them would put a hash-addressed
  artifact under a mutable path, and PRD 18 requires evidence to be content-addressed.

## Phase 00 state

Empty by design. Phase 08 delivers `query_txs` integration, report download, artifact hashing,
the claim ledger, the PDF audit, the public proof page, and the CLI verifier.

The gate that already exists: `tests/docs.test.ts` and `scripts/check-deployment-manifests.mjs`
run from the first commit, so the manifest that the public verifier consumes is schema-checked
before the first one is written.

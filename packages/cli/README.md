# @conduit-protocol/cli

The `conduit` command line. PRD FR-015.

| Field           | Value                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| Specification   | PRD FR-001, PRD FR-015                                                  |
| Added by        | [ADR-0005](../../docs/adr/0005-cli-package-and-runtime-dependencies.md) |
| Phase 01 status | `doctor` implemented                                                    |

## Commands

```bash
conduit doctor [--json] [--wallet <address>...] [--cash-chain <key>]
```

`doctor` probes what the current credentials and networks can actually do, and exits non-zero
when a required capability is missing. That exit code is the point: a doctor that always
succeeds is a report nobody reads, and CI needs it to be able to fail.

Each check names the rows in [docs/assumptions.md](../../docs/assumptions.md) it speaks to, so a
run is readable as progress against the twelve mandatory unresolved questions in PRD 23.

Credentials are reported as configured-or-not with a character count. No value is ever printed.

## Not yet implemented

`create-intent`, `inspect`, `relay`, `verify`, and `export-audit` arrive with the subsystems they
drive, in phases 04 through 08. They are absent rather than stubbed, so `--help` never advertises
a verb that does nothing.

## Why this is a separate package

Shipping the binary from `packages/sdk` would put `commander` in the dependency tree of every
consumer that imports the SDK to build an intent. See ADR-0005.

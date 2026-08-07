# ADR-0005: CLI package and the first runtime dependencies

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 01
**Supersedes:** —
**Superseded by:** —

## Context

Phase 01 adds the first code that is not repository plumbing, which forces two decisions the
PRD does not settle.

**Where the CLI lives.** PRD FR-015 requires a `conduit` binary with `doctor`, `create-intent`,
`inspect`, `relay`, `verify`, and `export-audit`, and separately requires an
`@conduit-protocol/sdk` library. PRD 11.1 fixes the workspace list and contains neither an
`apps/cli` nor a `packages/cli`.

**Which runtime dependencies.** PRD 11.1 names viem, PostgreSQL, OpenTelemetry, and Foundry. It
does not name a schema validator, HTTP framework, logger, or CLI parser, and the v1.1 override
adds Cloudflare Workers as the API and worker runtime, which rules out anything Node-only.

## Decision

**Add `packages/cli` as a fourteenth workspace.** The alternative — shipping the binary from
`packages/sdk` — would put `commander` in the dependency tree of every consumer that imports the
SDK to build an intent. PRD 11.1's tree is the required layout, not a closed set, and
`tests/repo-structure.test.ts` asserts the required directories exist without forbidding others.

**Dependencies, all exact-pinned per ADR-0002:**

| Package                          | Dependency                             | Why                                                                                                                                     |
| -------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `config`, `cleanverse`, `domain` | `zod` 4.4.3                            | PRD 9.3 requires schema validation of every Cleanverse response before its `code` is read, and PRD 12 requires it on every API mutation |
| `cleanverse`                     | none beyond zod                        | AES-CBC comes from `node:crypto`; a dependency for it would widen the surface around key material for no gain                           |
| `observability`                  | `pino` 10.3.1, `@opentelemetry/*`      | PRD 16.4 requires structured JSON logs, PRD 16.1 requires one trace from browser to evidence generation                                 |
| `domain`, `wormhole`, `verifier` | `viem` 2.55.11                         | named by PRD 11.1; its EIP-712 and keccak primitives are the same ones the contracts use                                                |
| `db`                             | `postgres` 3.4.9, `drizzle-orm` 0.45.2 | `postgres` speaks the wire protocol Hyperdrive fronts; Drizzle keeps migrations in the repository as the override requires              |
| `api`                            | `hono` 4.13.0                          | runs unmodified on Workers, which Express does not                                                                                      |
| `cli`                            | `commander` 15.0.0                     | —                                                                                                                                       |
| root (dev)                       | `fast-check` 4.9.0                     | PRD 3.1 requires property tests                                                                                                         |

## Evidence

- `tests/version-pinning.test.ts` rejects any range in any workspace manifest, so every version
  above is exact and stays exact.
- `tests/workspaces.test.ts` asserts the workspace list, so adding `packages/cli` is a visible
  change rather than a silent one.

## Consequences

- Fourteen workspaces instead of thirteen. The list in `tests/workspaces.test.ts` and PRD 11.1's
  tree now differ by one entry, deliberately and in one place.
- Choosing Workers-compatible libraries early avoids a rewrite at phase 06. It also means no
  package may reach for a Node-only API without checking the Workers runtime first.
- `zod` becomes load-bearing for the CLAUDE.md rule that a Cleanverse HTTP 200 is not business
  success: the parser validates the envelope before any caller reads `code`.

## Alternatives rejected

**Ship the CLI from `packages/sdk`.** Puts a CLI parser in every SDK consumer's tree.

**Express or Fastify for the API.** Both assume Node internals that Workers does not provide.
The override names Workers, so the framework choice follows rather than fights it.

**A hand-rolled validator instead of zod.** Response parsing is where the "HTTP 200 is not
success" invariant is enforced. That is the last place to put bespoke code.

## Assumptions touched

Opens [ASM-024](../assumptions.md): the Cleanverse authentication header names are not stated in
PRD 9, so the client sends the API ID as a configurable header and the request body carries the
AES-encrypted payload. Confirmed against the live sandbox in phase 01.

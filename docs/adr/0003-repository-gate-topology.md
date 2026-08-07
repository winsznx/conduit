# ADR-0003: Repository gate topology

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 00
**Supersedes:** —
**Superseded by:** —

## Context

The PRD 19 phase 00 gate is `fresh clone → one bootstrap command → all empty-suite checks
green`. PRD 15.5 lists what CI must run. CLAUDE.md fixes the order: format, lint, typecheck,
unit, integration, contract, invariant, security scans, end-to-end, then status update.

Three failure modes have to be designed out before any product code exists.

**A local run and a CI run meaning different things.** If CI is a separate list of steps, it
drifts from what contributors run, and "green locally" stops predicting anything.

**A missing tool reading as a pass.** A step that skips when its binary is absent produces the
same green output as a step that ran and found nothing. That is the shape of every quiet
regression.

**Empty suites proving nothing.** A phase 00 test suite that asserts `true === true` satisfies
the letter of the gate and none of its purpose.

## Decision

**One script is the gate.** `scripts/verify.mjs` defines sixteen steps. `pnpm verify` runs it,
and every CI job runs the same script with `--only=<step>`. There is no second list.

**Every step blocks.** A step whose tool is missing fails with the install command, and never
skips. Trivy and Checkov are not installed locally by default, so those steps fall back to
digest-pinned Docker images rather than disappearing.

**Bootstrap is the entry point.** `pnpm bootstrap` verifies the toolchain, installs from the
frozen lockfile, restores Solidity dependencies at locked revisions, builds contracts with
warnings as errors, then runs the gate. It imports nothing from `node_modules`, so it works on a
clone where nothing is installed.

**Empty suites assert the repository, not tautologies.** With no product logic to test, the
suites test the things that exist and would otherwise rot silently: the PRD 11.1 layout, every
pin agreeing across every file that mirrors it, exact-version enforcement, SHA-pinned actions,
all thirteen workspaces resolving by published name after a build, and documentation coverage
measured against the PRD text itself.

That last point is the load-bearing one. `tests/docs.test.ts` parses `CONDUIT_PRD_v1.0.md` and
requires every PRD 19 phase in the status file, every PRD 23 question in the assumptions
register, every PRD 14.3 threat in the threat register, and every PRD 14.4 invariant bound to at
least one threat. Documentation coverage becomes a build failure rather than a review habit.

**Ordering is a dependency, not a preference.** Typecheck runs before the unit suite because
`tests/workspaces.test.ts` imports each package by its published name, which requires
`tsc --build` to have emitted `dist`. The step order in `verify.mjs` is the contract.

**Snapshots exist before the code they guard.** Gas and storage-layout snapshots cover only the
build probe today. They are wired now so phase 04 inherits a working gate instead of adding one
under deadline.

## Evidence

- `pnpm bootstrap` on a fresh clone of this commit completes with all sixteen steps green.
- Every step reports `PASS` or `FAIL` with a duration in the gate summary; there is no `SKIP`
  outcome in the script.
- `.github/workflows/ci.yml` invokes `scripts/verify.mjs --only=<step>` for each job.

### The silent pass this design already caught

The first fresh-clone run of this gate reported sixteen green steps, and two of them were lying.

The clone sat outside Docker Desktop's shared paths. A bind mount Docker cannot read does not
error — it presents an empty directory — so Trivy and Checkov each analysed nothing, found
nothing, and exited zero. The summary said `PASS` twice for work that never happened.

Container-based steps now probe the mount before scanning and fail with the fix when the
repository is invisible. The general lesson is written into the design rather than the incident:
a tool exiting zero is not evidence it ran, and any step that delegates to an external process
has to prove the process could see its input.

## Consequences

- Contributors need Slither and gitleaks locally, or the gate fails with install instructions.
  This is deliberate: the alternative is a green local run that CI contradicts.
- Docker is required for the container and IaC steps unless Trivy and Checkov are installed
  natively.
- Adding a check means adding it in one place. Forgetting to mirror it into CI is not possible.

## Alternatives rejected

**A `Makefile` orchestrating pnpm scripts.** Another dependency and another dialect for the
same graph, with worse Windows behaviour and no structured summary.

**Turborepo or Nx task graph.** Real value once builds are expensive. Today it would add a
pinned dependency and a cache to reason about, to order sixteen sequential steps.

**Skipping unavailable tools with a warning.** Rejected outright. PRD 15.5: "No security tool
result may be silenced without a documented waiver in `docs/security-waivers/`." A skip is a
silence with no waiver.

## Assumptions touched

None.

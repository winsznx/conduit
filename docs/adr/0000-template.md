# ADR-0000: Template

**Status:** Template
**Date:** 2026-08-07
**Phase:** —
**Supersedes:** —
**Superseded by:** —

## Context

What forced a decision. Cite the PRD section, the Cleanverse API behaviour, the chain
observation, or the conflict between sources. If two sources disagree, state both positions
verbatim before resolving them.

## Decision

What was decided, in the present tense, as a single unambiguous statement.

## Evidence

The concrete artifacts that justify the decision. For anything touching an external system,
this section must contain live results, not reasoning:

- exact request or transaction, redacted;
- response or revert;
- transaction hashes and chain IDs;
- test names that now cover the behaviour.

An ADR that changes custody, settlement, or compliance behaviour without evidence in this
section is not `Accepted`.

## Consequences

What becomes easier, what becomes harder, and what is now forbidden. Name the invariants
(PRD 14.4) this decision protects or puts at risk.

## Alternatives rejected

Each with the reason it was rejected. "Not considered" is not a reason.

## Assumptions touched

Rows in [docs/assumptions.md](../assumptions.md) that this ADR moves, and their new state.

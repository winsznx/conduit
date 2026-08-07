# Security waivers

PRD 15.5: _"No security tool result may be silenced without a documented waiver in
`docs/security-waivers/`."_

## Current waivers

| Waiver                                                   | Tool     | Scope                                           | Expires    |
| -------------------------------------------------------- | -------- | ----------------------------------------------- | ---------- |
| [gitleaks-env-templates.md](./gitleaks-env-templates.md) | gitleaks | worktree scan of `.env` and `.env.example` only | 2026-11-07 |

`tests/docs.test.ts` fails if a waiver file appears without a status and an expiry, or if an
expiry has passed.

## When a waiver is required

Any of these needs a file here before it merges:

- a Slither detector excluded, globally or per-line;
- a `pnpm audit` advisory ignored;
- a Trivy or Checkov check suppressed;
- a gitleaks finding baselined;
- an ESLint rule disabled in product code;
- a threat register row moved to `ACCEPTED`.

A step removed from `scripts/verify.mjs` is not a waiver, it is a gate change, and needs an ADR.

## Format

One file per waiver, named `<tool>-<identifier>.md`:

```markdown
# Waiver: <tool> <rule or advisory id>

**Status:** Active | Expired
**Opened:** YYYY-MM-DD
**Expires:** YYYY-MM-DD
**Scope:** exact files, lines, or packages

## Finding

What the tool reported, verbatim.

## Why it does not apply

The specific reason, tied to code. "False positive" alone is not a reason.

## Invariants checked

Which PRD 14.4 invariants this could have touched, and why none is at risk.

## Compensating control

The test, review, or design property that covers what the tool would have caught.

## Removal condition

What has to change for this waiver to be deleted.
```

## Rules

1. Every waiver expires. An expired waiver fails the build; renewing it is a new decision.
2. A waiver covers a specific finding at a specific scope. Tool-wide suppression is never a
   waiver.
3. A waiver touching custody, settlement, or compliance behaviour needs an ADR, not just a file
   here.
4. Waivers are reviewed at every phase gate, and phase 09 requires no critical or high unwaived
   security issue — which also means no waiver hiding one.

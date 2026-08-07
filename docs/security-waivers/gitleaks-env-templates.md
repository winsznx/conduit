# Waiver: gitleaks generic-api-key on `.env` and `.env.example`

**Status:** Active
**Opened:** 2026-08-07
**Expires:** 2026-11-07
**Scope:** the worktree scan only (`gitleaks dir .`): the paths `.env`, `.env.example`, and
`contracts/lib/`, plus findings whose matched text is an EVM address. The history scan
(`gitleaks git .`) runs with no allowlist.

## Finding

```text
.env          rule=generic-api-key  line=17
.env.example  rule=generic-api-key  line=111
```

Raised when the Cleanverse sandbox credentials were first placed in a local `.env`.

## Why it does not apply

**`.env`** holds real credentials and is gitignored, so it cannot reach a commit. The worktree
scan's purpose is to catch a secret before it is committed; a file git will not accept is
outside that purpose. The history scan, which covers everything that has actually been
committed, runs unrestricted and reports clean across all four commits.

**`.env.example`** is committed and its content genuinely matters. The finding is a false
positive: `generic-api-key` matched the variable _name_ `CLOUDFLARE_API_TOKEN` on a line whose
value is empty. Every assignment in that file is empty by construction.

**`contracts/lib/`** holds vendored Solidity dependencies as git submodules, pinned by commit in
`foundry.lock`. This repository stores a pointer, not the files, so nothing there can enter our
history — which `gitleaks git .` confirms independently by reporting clean. OpenZeppelin ships
test mnemonics and keys in its own fixtures; those are public by design and theirs to manage.
Installing it raised 180 findings at once, none of them ours.

**EVM addresses** are public by construction. `generic-api-key` fired twice on
`docs/evidence/phase-01-monad-cash-token.json`, matching the field name `accesscore_address`
beside a contract address the evidence exists to publish. The exclusion is scoped to the exact
shape `0x` followed by forty hex characters, so a real credential sitting near an address is
still reported.

## Invariants checked

None at risk. Neither path can carry a credential into a commit, and no protocol behaviour
depends on either file. PRD 9.1's rule that the API key never reaches a browser is enforced by
package boundaries, not by this scan.

## Compensating control

Two tests in `tests/repo-structure.test.ts`, both stronger than the heuristic they replace:

- `never commits an environment file that could carry a real secret` asserts `.gitignore` still
  contains `.env` and still un-ignores `.env.example`. If somebody removes that protection, the
  build fails rather than this allowlist quietly becoming dangerous.
- `documents every environment variable by name only, with no values` asserts that every
  assignment in `.env.example` has an empty value. A real credential pasted into the template
  fails the suite immediately, regardless of whether gitleaks would have matched its shape.

`gitleaks git .` remains unrestricted, so anything that does reach history is still caught.

## Removal condition

Delete this waiver and the `[allowlist]` block in `.gitleaks.toml` when either becomes true:

- gitleaks gains a flag to respect `.gitignore` during a directory scan, which removes the need
  for the `.env` entry;
- the `generic-api-key` rule stops matching empty assignments, which removes the need for the
  `.env.example` entry.

Re-run `gitleaks dir . --no-banner --redact` with the allowlist removed to check.

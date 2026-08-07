# Waiver: gitleaks generic-api-key on `.env` and `.env.example`

**Status:** Active
**Opened:** 2026-08-07
**Expires:** 2026-11-07
**Scope:** the worktree scan only (`gitleaks dir .`), for exactly two paths: `.env` and
`.env.example`. The history scan (`gitleaks git .`) runs with no allowlist.

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

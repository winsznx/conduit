# scripts

Repository automation. Every script here is plain ESM that runs on the pinned Node without a
build step, and the two entry points import nothing from `node_modules` so they work on a clone
where nothing is installed.

| Script                                                             | Purpose                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------- |
| [bootstrap.mjs](./bootstrap.mjs)                                   | The one bootstrap command from the PRD 19 phase 00 gate         |
| [verify.mjs](./verify.mjs)                                         | The repository gate — sixteen blocking steps, also what CI runs |
| [verify-toolchain.mjs](./verify-toolchain.mjs)                     | Asserts this machine matches `toolchain.json`                   |
| [storage-layout.mjs](./storage-layout.mjs)                         | Writes and checks the storage-layout snapshot (PRD 15.1)        |
| [check-deployment-manifests.mjs](./check-deployment-manifests.mjs) | Validates manifests against the PRD 17.3 schema                 |
| [lib/run.mjs](./lib/run.mjs)                                       | Shared process helpers                                          |

## Two kinds of toolchain check

`verify-toolchain.mjs` checks the **environment**: is the installed Node, pnpm, and Foundry what
`toolchain.json` says. `tests/toolchain.test.ts` checks the **repository**: do `package.json`,
`.node-version`, `foundry.toml`, `foundry.lock`, the workflows, `docker-compose.yml`, and
`versions.tf` all agree with `toolchain.json`.

Keeping them apart means a mismatch always reports as either "this machine is wrong" or "this
repository is inconsistent", never an ambiguous blend of the two.

## Adding a gate step

Add it to the `STEPS` array in `verify.mjs`, then add a job to `.github/workflows/ci.yml` that
calls `node scripts/verify.mjs --only=<id>`. The step definition stays in one place; CI only
selects from it. See ADR-0003.

A step that cannot run because its tool is missing must **fail** with an install instruction. It
must never skip — PRD 15.5 forbids silencing a security tool without a documented waiver, and a
skip is a silence with no waiver.

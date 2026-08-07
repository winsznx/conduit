# contracts/deployments

Every deployment writes one manifest here, in the shape PRD 17.3 fixes and
[`deployment-manifest.schema.json`](./deployment-manifest.schema.json) encodes.

## Why the manifest is load-bearing

CLAUDE.md: _"Contract addresses come from deployment manifests."_ PRD FR-014 goes further — the
public verifier accepts a settlement ID, optional RPC overrides, and an optional expected
manifest hash, and must reach a terminal answer without trusting the application database.

That makes this directory the bootstrap point for independent verification. A manifest that
lies, or that cannot be checked, breaks the entire proof chain regardless of how correct the
contracts are.

## Gate

`scripts/check-deployment-manifests.mjs` runs on every commit as step 15 of `pnpm verify`. It
validates each manifest against the schema and additionally requires:

- `solcVersion` equal to the compiler pinned in `toolchain.json`;
- a bytecode hash for every deployed contract;
- every contract's `chain` present in `chainConfigs`.

Phase 00 has zero manifests, and the check reports that. It starts blocking the moment phase 01
writes one.

## Reproducibility

`foundry.toml` sets `bytecode_hash = "none"` and `cbor_metadata = false`, so a verifier that
recompiles from the `gitCommit` in a manifest reaches the same runtime bytecode as the
deployment. Without that, `bytecodeHashes` would only be checkable by whoever performed the
deploy — which is not verification.

## Naming

`<network>-<deploymentId-prefix>.json`, for example `monad-testnet-0x1a2b3c4d.json`. One file per
deployment. Manifests are append-only: a redeploy is a new `deploymentId` and a new file, because
PRD 8.2 makes core contracts non-upgradeable and every intent binds exact addresses.

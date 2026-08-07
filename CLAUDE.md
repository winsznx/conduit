# CLAUDE.md — Conduit

## Mission

Build Conduit exactly as defined in `CONDUIT_PRD_v1.0.md`.

Conduit coordinates Cleanverse A-Token cash on Monad Testnet with a restricted RWA on Arbitrum Sepolia under one settlement intent, Wormhole-authenticated state, real Cleanverse eligibility, and deterministic disposition.

## Source-of-truth order

1. Deployed contract state and verified transaction evidence
2. Cleanverse API V5.6 supplied by the project owner
3. `CONDUIT_PRD_v1.0.md`
4. Accepted ADRs under `docs/adr/`
5. Official Wormhole and chain registries pinned in the repository
6. Code comments
7. Tests
8. README

When sources conflict, stop, document the conflict, and create an ADR. Do not silently choose.

## Non-negotiable invariants

- No refund after COMMIT.
- No release without canonical COMMIT.
- No accepted VAA from an unexpected chain, emitter, deployment, or version.
- Every VAA is consumed at most once.
- Cash and asset conservation always hold.
- A Cleanverse HTTP 200 is not automatically business success.
- `validator/verify` with `valid:false` is non-eligible, not an API failure.
- `verify_apass` requires result code 4.
- No raw PII is stored or logged.
- No API key reaches the browser.
- No mock CVA in the final proof.
- No generic “CCP” claim without a documented endpoint.
- No report may be mislabeled.
- No product state may regress.
- Application database state never authorizes value movement.
- Relayers are untrusted for correctness.
- All user and authority signatures are domain-separated and replay-protected.
- Core contracts are non-upgradeable; new versions deploy separately.

## Work method

Before editing:

1. read the PRD;
2. read `docs/implementation-status.md`;
3. read current phase ADRs;
4. inspect existing tests and deployed manifests;
5. state the exact phase gate being worked toward.

During implementation:

- one phase at a time;
- small coherent commits;
- tests written with or before behavior;
- no TODO-only implementations;
- no swallowed errors;
- no `any` without a written justification;
- no floating dependency versions;
- no disabled security check without a waiver;
- no secret values in fixtures;
- no fake external-success branch in production code;
- all retries idempotent;
- all chain and Cleanverse identifiers normalized centrally.

After implementation:

1. format;
2. lint;
3. typecheck;
4. unit tests;
5. integration tests;
6. contract tests;
7. invariant tests;
8. security scans;
9. end-to-end tests for the phase;
10. update implementation status and evidence.

## Required status report

```text
PHASE:
STATUS: PASS | FAIL | BLOCKED
COMMIT:
FILES CHANGED:
CONTRACT DEPLOYMENTS:
TEST COUNTS:
LIVE TRANSACTIONS:
EVIDENCE LINKS:
SECURITY FINDINGS:
KNOWN LIMITATIONS:
NEXT PHASE:
```

A phase is not PASS because code compiles. It is PASS only when the PRD gate has real evidence.

## Repository rules

- TypeScript strict mode.
- Solidity compiler exact-pinned.
- pnpm lockfile committed.
- Foundry lock/remappings committed.
- Environment validation at process start.
- Contract addresses come from deployment manifests.
- Cleanverse A-Token address comes from discovery snapshot.
- Chain IDs must be checked against RPC at startup.
- All timestamps are UTC.
- All hashes are lowercase `0x` hex.
- All address comparisons use normalized checksum or lowercase canonical form consistently.
- Database migrations are forward-only in shared environments.
- Public APIs have schema validation and idempotency.
- Workers use transactional outbox and idempotent handlers.
- All external calls have timeout, structured error, and trace context.

## Cleanverse rules

- AES helper exists only in `packages/cleanverse`.
- Never log encrypted plaintext, ciphertext, key, or decrypted sensitive response.
- Preserve `X-Request-ID`.
- Parse response body even on HTTP 200.
- Reads may retry only under policy.
- Writes do not blind-retry.
- Wait for Validator write transaction confirmation before another mutation.
- Commit-time checks bypass application cache.
- Store redacted response plus full-response hash.
- Webhooks verify HMAC against raw bytes before JSON parsing.
- Webhook delivery IDs are idempotency keys.

## Wormhole rules

- Use core contract addresses from pinned official registry snapshot.
- Verify `parseAndVerifyVM`.
- Verify emitter chain, emitter address, deployment ID, protocol version, message type, settlement ID, and intent hash.
- Mark VAA consumed before token transfer.
- Never trust off-chain VAA parsing alone.
- Never authorize refund from worker timeout.
- Anyone may relay valid VAAs.

## Contract rules

- Checks-effects-interactions.
- `SafeERC20`.
- `nonReentrant`.
- Exact balance deltas.
- Reject fee-on-transfer and rebasing behavior.
- Explicit custom errors.
- Emit state-transition events.
- No admin bypass of recipient eligibility.
- No rescue of active settlement assets.
- Every terminal state is irreversible.

## Documentation rules

Maintain:

- `docs/implementation-status.md`
- `docs/assumptions.md`
- `docs/adr/`
- `docs/threat-model/`
- `docs/runbooks/`
- `contracts/deployments/`

An unresolved assumption must remain visibly unresolved. Never write it as a confirmed capability.

## Stop conditions

Stop and mark BLOCKED only when:

- a required external API or network capability fails with a minimal reproducer;
- credentials lack a required role;
- real A-Token contract custody is impossible without Cleanverse authorization;
- Wormhole VAA cannot complete in either direction;
- official documentation conflicts in a way that affects custody or settlement safety.

A blocked report must contain:

- exact request or transaction;
- redacted response or revert;
- expected behavior;
- actual behavior;
- smallest reproducer;
- exact support question;
- safe alternate design from the PRD.

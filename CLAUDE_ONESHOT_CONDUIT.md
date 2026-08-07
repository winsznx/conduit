# Claude Code One-Shot Execution Prompt — Conduit

Read these files completely before doing anything:

1. `CLAUDE.md`
2. `CONDUIT_PRD_v1.1_OVERRIDE.md`
3. `CONDUIT_PRD_v1.0.md`
4. all existing `docs/adr/*`
5. `docs/implementation-status.md` if present

The v1.1 override wins wherever it conflicts with v1.0.

## Execution mode

Build the complete product end-to-end in one continuous execution.

The phase structure in the PRD is an evidence order, NOT a request to stop after each phase.

Continue automatically from one phase into the next whenever its gate passes.

Do not ask me to confirm routine engineering decisions.
Do not reduce scope.
Do not move required functionality into a roadmap.
Do not replace live final integrations with mocks.
Do not use deadline pressure as a design constraint.

## Human interaction policy

I will personally attend only actions that require my blockchain wallet or final visual specification.

You may pause only for one of these:

### HUMAN_GATE_DEPLOY

Use when a contract must be deployed with my wallet.

Before stopping:

- compile;
- run all relevant unit/fuzz/invariant tests;
- simulate deployment;
- determine exact chain;
- verify RPC chain ID;
- calculate constructor/initializer args;
- generate deployment script;
- estimate gas;
- document expected bytecode hash;
- document post-deploy validation.

Then output only the gate block plus a short explanation:

```text
HUMAN_GATE_DEPLOY
Network:
Chain ID:
Contract:
Artifact:
Constructor/initializer:
Expected owner:
Exact command:
Expected result:
Post-deploy checks the agent will run:
Paste back:
```

Never request my private key.

### HUMAN_GATE_SIGN

Use for an owner signature such as Cleanverse custom CVA registration.

Generate the exact plaintext message first.

For Cleanverse CVA registration it must follow the current official guide:
EIP-191 personal_sign over lowercase(chain + atoken_address).

Output:

```text
HUMAN_GATE_SIGN
Purpose:
Exact plaintext:
Expected signer:
Signature standard:
Exact safe signing command/instruction:
Paste back:
```

Never request my private key or seed phrase.

### HUMAN_GATE_DESIGN

Final production UI must wait for my `design.md`.

Until then you may implement:

- route skeletons;
- protocol-facing view models;
- accessibility structure;
- test IDs;
- unstyled functional E2E surfaces.

Do not invent final brand, typography, layout, colors, motion, illustration, or component visual language.

When protocol/backend/evidence flows are ready for final UI, output:

```text
HUMAN_GATE_DESIGN
Backend/protocol status:
Pages ready for design:
Place design.md at repository root and reply CONTINUE.
```

After `design.md` appears, read it in full and finish the complete web application without asking routine design questions unless the file is logically contradictory.

### HUMAN_GATE_EXTERNAL_BLOCKER

Use only when an external system demonstrably prevents progress.

Before stopping:

- reproduce the failure at least twice where safe;
- rule out local configuration error;
- save redacted request/response or transaction evidence;
- identify the exact documented expectation;
- propose the safest architecture-compatible fallback.

Output:

```text
HUMAN_GATE_EXTERNAL_BLOCKER
Capability:
Expected:
Actual:
Minimal reproducer:
Evidence:
Why local debugging is exhausted:
Exact support question:
Safe fallback:
```

## New official Cleanverse CCP requirements

The new CCP CVA Integration Guide is authoritative for custom CVAs.

Implement the v1.1 architecture:

- Arbitrum RWA leg is a real Cleanverse CVA.
- Use the custom-contract path.
- Use RuleV2 only for new on-chain policy integration.
- Custom token must call `policy.canTransfer(token, from, to, amount)` before actual transfers.
- Use a token-native settlement reservation so the seller cannot double-spend the RWA while the token remains in the seller wallet before commit.
- After deployment, register the CVA through Cleanverse using owner_signature.
- Configure RuleV2 after registration.
- Prove an eligible transfer.
- Prove an ineligible transfer.
- Prove reservation conservation.
- Never silently substitute a generic ERC-3643 mock for the final demo.

RuleV2:

```solidity
struct RuleV2 {
    bytes2 allowedGroup;
    bytes2 allowedSubGroup;
    uint8 minTier;
    uint8 minSubTier;
    uint256 poolCountryBitmap;
}
```

Treat any legacy API country-array representation as compatibility input, not the canonical on-chain model.

## Cleanverse credentials

The sandbox `api-id` and Base64 `api-key` are available in local secrets/environment.

Rules:

- never print either value;
- never put either value in source control;
- never expose them to browser bundles;
- validate their presence by boolean/length only;
- use the exact AES behavior required by API v5.6;
- scrub command output and test snapshots;
- commit `.env.example`, never the real `.env`;
- when moving to Cloudflare, store them as Worker secrets.

## Contracts

Core settlement safety remains:

- no refund after canonical COMMIT;
- no release without canonical COMMIT;
- no VAA replay;
- verify Wormhole on-chain, not just off-chain;
- exact chain/emitter/deployment/version checks;
- exact cash conservation;
- exact RWA reservation conservation;
- all terminal states monotonic;
- recipient policy checked at actual release;
- post-COMMIT ineligibility becomes HELD, never refundable;
- Disposition Kernel resolves held value.

Use the current official Wormhole registry pinned into the repository.
Do not switch transport because of convenience.

## Cash CVA

First attempt the real discovered sandbox CVA on Monad.

Run the real custody seam test.

If direct CashEscrow custody is supported, use it.

If it fails because contract custody is incompatible with CCP policy:

1. document the failure;
2. attempt the v1.1 custom settlement-CVA reservation fallback on Monad;
3. only use an institutional settlement wallet if both sponsor-native approaches are impossible, and disclose that trust boundary.

Do not claim a custom test settlement CVA has fiat backing unless that is proven.

## Arbitrum RWA CVA

Implement `ConduitRWACVA` with:

- OpenZeppelin v5-compatible ERC20 behavior;
- AccessControl;
- mint/burn as required;
- Cleanverse `IATokenPolicy`;
- RuleV2 management wrappers;
- reservation accounting;
- no spending of reserved balance;
- Wormhole-authenticated release;
- current compliance verification;
- Disposition Kernel integration;
- explicit events;
- exact custom errors;
- complete fuzz/invariant suite.

The reservation mechanism must not bypass CCP.
Every actual transfer still calls `policy.canTransfer`.

## Off-chain system

Implement fully:

- strict TypeScript monorepo;
- SDK;
- CLI;
- Cleanverse client;
- API;
- PostgreSQL schema;
- transactional outbox;
- indexer for both chains;
- Wormhole relayer;
- compliance attestation worker;
- evidence worker;
- public verifier;
- claim ledger;
- audit PDF generation;
- observability;
- runbooks;
- CI;
- staging infrastructure.

## Cloudflare + Supabase production target

Use:

```text
Next.js App Router
@opennextjs/cloudflare
Cloudflare Workers
Supabase Postgres
Cloudflare Hyperdrive when useful/compatible for Worker connection pooling
Cloudflare R2
Cloudflare Queues
Cloudflare Worker secrets
```

Requirements:

- Supabase is the managed PostgreSQL provider;
- do not provision D1 or another paid Cloudflare database just to keep everything on one vendor;
- keep PostgreSQL for transactional protocol projections/outbox;
- keep migrations in the repository;
- validate migrations locally and/or against a disposable Supabase environment before production;
- never expose the Supabase service-role credential to browser code;
- use Hyperdrive only as a connection layer when it improves Worker-to-Supabase behavior;
- R2 stores evidence reports, audit PDFs, manifests and claim ledgers;
- Queues are at-least-once, therefore consumers must be idempotent;
- database outbox remains authoritative for critical job creation;
- Cloudflare local/preview/staging/production configs are separate;
- do not deploy final visual web before `design.md`.

You may create Cloudflare config and preview deployments automatically if authenticated.
Do not overwrite a production deployment without an explicit production deploy command or configured release gate.

## Local-first Git and GitHub policy

Work locally first.

- Initialize git immediately if needed.
- Commit coherent milestones locally as you progress.
- Do not create a PR for each phase.
- Do not stop for code review ceremony.
- Do not wait on GitHub Actions before continuing.
- Do not append `Co-authored-by`, Claude attribution, AI attribution, or any other co-author trailer.
- Use concise conventional commit messages.
- Do not push secrets or local `.env` files.

The complete build and debugging loop is local.

Before creating/pushing the GitHub repository, run and pass the local release gate, including:

```text
format
lint
typecheck
all TypeScript tests
all Solidity tests
fuzz tests
stateful invariants
integration tests
database migration validation
worker/indexer tests
Playwright E2E
secret scan
dependency audit
security/static scans
production web build
OpenNext Cloudflare build
wrangler validation
wrangler deploy --dry-run where supported
Supabase migration validation
contract deployment simulations
configuration dry-runs
```

GitHub Actions are optional execution automation for reproducibility and may be added near the end. If created:

- make them call the same commands already proven locally;
- do not use Actions as the primary debugging loop;
- do not wait for Actions to continue unrelated work;
- do not weaken local tests just to make CI green.

### Final GitHub publication

Only after the local release gate passes:

1. run `gh auth status`;
2. use whichever GitHub account is already authenticated;
3. create `conduit` under that account unless it already exists;
4. make it public for hackathon submission unless the user has explicitly changed repository visibility;
5. push the existing local history;
6. set a precise repository description;
7. add relevant topics;
8. set the demo/homepage URL when available;
9. verify the default branch and release commit;
10. verify the repository and complete git history contain no secrets.

Do not add a pull-request-only workflow or branch-protection dependency that slows the build without increasing safety.

## Writing and voice files

Before generating public-facing writing, check the Claude/project root for:

```text
writing.md
voice.md
WRITING.md
VOICE.md
```

If any are present, read them fully before writing.

Apply them to:

- README;
- repository description;
- docs prose;
- user-facing copy;
- architecture explanations;
- demo text;
- release notes;
- changelog;
- submission text;
- comments with explanatory prose.

They are writing constraints, not technical authorities. Never let them override the PRD, Cleanverse docs, security facts, contract behavior, or test evidence.

Avoid generic AI filler and hackathon-slop prose.

## Testing

Do not stop at “tests pass.”

Required:

- Solidity unit tests;
- fuzz tests;
- stateful invariants;
- adversarial VAA tests;
- Cleanverse business-code tests;
- RuleV2 tests;
- reservation double-spend tests;
- post-commit freeze tests;
- wrong emitter tests;
- replay tests;
- worker crash/retry tests;
- outbox idempotency tests;
- indexer reorg tests;
- public verifier from an empty DB;
- Playwright happy path;
- Playwright held/disposition path;
- security scans;
- secret scan;
- dependency audit;
- deployment-manifest reproducibility.

Fix failures rather than lowering thresholds.

## Evidence discipline

After each internal phase gate:

- update `docs/implementation-status.md`;
- commit the phase locally;
- never add a co-author trailer;
- store test counts;
- store live transaction IDs where applicable;
- update assumptions;
- create ADRs for architecture changes.

Do not create a PR for the phase.
Do not push merely to obtain CI feedback.
Do not stop to report each phase to me.
Accumulate the results and continue.

At a human gate, show the cumulative phase status before the gate.

## Final completion report

When everything except optional production-mainnet actions is complete, return:

```text
CONDUIT V1 COMPLETE

FINAL COMMIT:
REPOSITORY:
DEPLOYMENTS:
CLEANVERSE CVAS:
RULEV2 POLICIES:
WORMHOLE PROOFS:
HAPPY-PATH SETTLEMENT:
FAILURE-PATH SETTLEMENT:
DISPOSITION PROOF:
PUBLIC VERIFIER:
SDK:
CLI:
WEB:
CLOUDFLARE PREVIEW:
AUDIT ARTIFACTS:
TEST COUNTS:
SECURITY SCANS:
KNOWN TRUST ASSUMPTIONS:
KNOWN LIMITATIONS:
JUDGE VERIFICATION PATH:
```

Do not call the build complete unless every required acceptance criterion in v1.0 plus the v1.1 override is either PASS or is explicitly impossible because of a demonstrated external platform limitation.

Start now from the current repository state.

# infra/docker

Local development dependencies for the `local` environment in PRD 17.1.

```bash
docker compose -f infra/docker/docker-compose.yml up -d
docker compose -f infra/docker/docker-compose.yml down -v
```

## What runs

| Service          | Purpose                                           | PRD        |
| ---------------- | ------------------------------------------------- | ---------- |
| `postgres`       | Settlement projection, outbox, evidence metadata  | 11.6, 11.7 |
| `otel-collector` | Local OTLP endpoint for traces, metrics, and logs | 16.1       |

## Pinning

Both images are referenced by `sha256` digest rather than tag, so a pull today and a pull
after the tag is republished fetch identical bytes. Digests live in
[toolchain.json](../../toolchain.json) and `tests/toolchain.test.ts` fails if this file and
that manifest disagree.

## Phase 00 state

Nothing in this repository connects to these services yet. `packages/db` gains the schema and
forward-only migrations in phase 06. The compose file exists now so the container
configuration is under the Trivy scan from the first commit rather than from the commit that
first needs a database.

The Postgres password here is a local-only literal. Staging and production read credentials from
Cloudflare Worker secrets, per PRD 17.4 and v1.1 override section 13.

## Local Postgres versus Supabase local

The v1.1 override makes Supabase the managed Postgres provider and asks for local Supabase
development "where practical" for schema and migration validation. That is a phase 06 decision,
taken when there is a schema to validate.

Plain Postgres is the right local dependency until then: it is one pinned image rather than the
full Supabase stack, and phase 00 has no migrations, no row-level security, and no Supabase
client to exercise. Whichever wins, protocol truth stays on-chain and the database stays a
projection — invariant I11 does not move because the provider does.

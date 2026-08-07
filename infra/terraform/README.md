# infra/terraform

Provisioning for the `staging` and `production` environments described in PRD 17.1 and 17.2.

## Phase 00 state

Only `versions.tf` exists. It pins the Terraform CLI exactly and declares no providers.

PRD 17.2 lists what must be provisioned:

- container runtime
- PostgreSQL
- object storage for evidence
- KMS / Secrets Manager
- OpenTelemetry collector
- metrics and alerting
- private networking
- WAF / rate limiting
- encrypted backups
- retention policies

PRD 17.2 does not name a cloud, but `CONDUIT_PRD_v1.1_OVERRIDE.md` section 13 does: Cloudflare
Workers with `@opennextjs/cloudflare`, Supabase Postgres, Hyperdrive as the Worker connection
layer where compatible, R2 for evidence artifacts, and Queues for asynchronous work. **ASM-014**
is `RESOLVED` on that basis, recorded in
[ADR-0004](../../docs/adr/0004-prd-v1-1-override-adoption.md).

What is still open is how provisioning splits between tools. Cloudflare and Supabase both have
Terraform providers, but Wrangler owns Worker configuration and secrets, and the Supabase CLI
owns migrations. Declaring a provider here before that split is decided would encode a choice
nobody has made. Tracked as **ASM-023**, decided by an ADR before the first resource lands in
phase 09.

Two constraints already apply to whatever is chosen:

- Worker secrets hold the Cleanverse credentials and the database connection material. They
  never enter a repository file, a build artifact, or a preview deployment (threat V-10).
- The Supabase service-role credential never reaches browser code (threat V-09), and backup or
  point-in-time-recovery claims must match the plan actually in use (ASM-022).

## Gate coverage today

`pnpm verify` runs Checkov against this directory on every commit. With no resources it
reports zero findings, and it starts blocking the moment a misconfigured resource appears.
That ordering is intentional: the scanner is in place before the thing it scans.

## Local development

Local development does not use Terraform. See [infra/docker](../docker/README.md).

-- Take the projection off the public API surface entirely.
--
-- ## What was wrong
--
-- Migration 0001 created nineteen tables in `public`. Supabase runs an event
-- trigger that grants `anon` and `authenticated` full privileges on anything
-- created there, and PostgREST serves `public` on the anon key — which is a
-- *published* credential, shipped to browsers by design. The state after 0001,
-- read back from the catalogue:
--
-- ```text
--   RLS                       OFF on all 19 tables, 0 policies
--   anon grants               DELETE, INSERT, SELECT, TRUNCATE, UPDATE, …
--   266 grant rows to anon and authenticated
--   USAGE on schema public    granted to both
-- ```
--
-- Anyone holding the project URL and the anon key could have truncated
-- `settlements`. Nothing about that is theoretical; it is the default, and the
-- default is only safe for tables that were designed to be world-readable.
--
-- These tables were not. They are a projection of chain state and Cleanverse
-- responses, written by one server-side Worker and read by one API. No browser
-- ever touches them directly, so nothing is lost by making them unreachable
-- from the API layer.
--
-- ## Three independent locks
--
-- Any one of these would close it. All three are applied, because the failure
-- mode of getting this wrong is silent and total, and because Supabase's event
-- trigger will happily re-grant on the next table someone creates.
--
--   1. the tables move to a schema PostgREST does not expose;
--   2. `anon` and `authenticated` lose every privilege, including future ones;
--   3. row-level security is enabled with no policies, so even a re-granted
--      role reads nothing.
--
-- `ENABLE` rather than `FORCE`: the owning role bypasses RLS, and the Worker
-- connects as the owner. `FORCE` would lock out the application along with the
-- attacker, which is a different bug and not a safer one.

-- ── 1. Out of the schema PostgREST serves ───────────────────────────────────
--
-- `schema_migrations` is absent from this list on purpose. The first attempt
-- moved it too, and the transaction died on its own bookkeeping: the tables
-- relocated, then `INSERT INTO schema_migrations` could not find the table it
-- had just moved, and Postgres rolled the whole migration back. The runner owns
-- that table and creates it in `conduit` before any migration runs.

CREATE SCHEMA IF NOT EXISTS conduit;

ALTER TABLE public.deployments            SET SCHEMA conduit;
ALTER TABLE public.deployment_contracts   SET SCHEMA conduit;
ALTER TABLE public.intents                SET SCHEMA conduit;
ALTER TABLE public.settlements            SET SCHEMA conduit;
ALTER TABLE public.settlement_legs        SET SCHEMA conduit;
ALTER TABLE public.messages               SET SCHEMA conduit;
ALTER TABLE public.vaas                   SET SCHEMA conduit;
ALTER TABLE public.compliance_attestations SET SCHEMA conduit;
ALTER TABLE public.authority_policies     SET SCHEMA conduit;
ALTER TABLE public.disposition_orders     SET SCHEMA conduit;
ALTER TABLE public.disposition_cases      SET SCHEMA conduit;
ALTER TABLE public.indexed_events         SET SCHEMA conduit;
ALTER TABLE public.indexer_cursors        SET SCHEMA conduit;
ALTER TABLE public.indexer_gaps           SET SCHEMA conduit;
ALTER TABLE public.evidence_artifacts     SET SCHEMA conduit;
ALTER TABLE public.verification_runs      SET SCHEMA conduit;
ALTER TABLE public.outbox                 SET SCHEMA conduit;
ALTER TABLE public.worker_jobs            SET SCHEMA conduit;

-- ── 2. No privileges, now or later ──────────────────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON SCHEMA public FROM anon, authenticated;

REVOKE ALL ON ALL TABLES IN SCHEMA conduit FROM anon, authenticated, PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA conduit FROM anon, authenticated, PUBLIC;
REVOKE ALL ON SCHEMA conduit FROM anon, authenticated, PUBLIC;

-- The event trigger fires on creation, so revoking once is not enough. Default
-- privileges are what stop the next table from arriving world-writable.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA conduit REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA conduit REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- ── 3. Row-level security, deny by default ──────────────────────────────────
--
-- No policies are created. A table with RLS enabled and no policy returns zero
-- rows to every role that does not own it and does not hold BYPASSRLS. That is
-- the correct posture for a projection nobody should be querying directly.

ALTER TABLE conduit.deployments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.deployment_contracts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.intents                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.settlements             ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.settlement_legs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.messages                ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.vaas                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.compliance_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.authority_policies      ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.disposition_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.disposition_cases       ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.indexed_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.indexer_cursors         ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.indexer_gaps            ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.evidence_artifacts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.verification_runs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.outbox                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE conduit.worker_jobs             ENABLE ROW LEVEL SECURITY;

-- ── What is deliberately absent ─────────────────────────────────────────────
--
-- There is no `GRANT ... TO service_role` here. The application connects as the
-- owning role over a direct Postgres connection, not through PostgREST, so it
-- needs no API-layer grant at all. Adding one would put the projection back on
-- the API surface for the convenience of a client that does not exist.
--
-- There is also no policy granting public read to `settlements`. A reader who
-- wants a settlement's state should call the API, which serves the projection
-- alongside the verifier's classification and the caveats that belong with it —
-- or better, run the verifier themselves against the chains. A raw table is the
-- one view of this data with no context attached.

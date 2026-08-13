-- STORY-010: the five database roles (migration owner + four runtime roles)
-- plus the break-glass incident-response role, their grants, and the
-- login-instrumentation half of break-glass alerting. This is the last piece
-- of EPIC-01's data-layer foundation before STORY-011 turns on RLS.
-- Spec: security-and-tenancy.md §2 "Database roles",
--       §4 "Tenant context propagation and the pooling constraint".
--
-- CORRECTION 1 (recorded in this story's Technical Notes for
-- security-and-tenancy.md §2 to pick up): the reference's
-- `GRANT ... ON ALL TABLES IN SCHEMA public` only reaches tables that exist
-- AT GRANT TIME. Every migration from here on is expand-only (STORY-011
-- onward adds more tables), so without `ALTER DEFAULT PRIVILEGES` a newly
-- created table would carry ZERO runtime-role privileges the instant it
-- lands.
--
-- CORRECTION 1a (post-review, fix pass): only the PLAIN
-- `ALTER DEFAULT PRIVILEGES IN SCHEMA public` variant (applying to objects
-- created hereafter by CURRENT_ROLE, i.e. whichever role actually runs this
-- migration) is included below. A `FOR ROLE nominara_owner` variant was
-- attempted and removed: `GRANT nominara_owner TO CURRENT_USER` fails in the
-- two production migration-identity models that actually exist —
-- self-grant when the migration session already IS nominara_owner, or
-- "permission denied to grant role" when it's a separate non-superuser
-- migrator — and even granted, `ALTER DEFAULT PRIVILEGES FOR ROLE
-- nominara_owner` still requires INHERITED membership (`has_privs_of_role`),
-- which every role in this project deliberately lacks (all NOINHERIT). It
-- would only ever have worked because local migrations happen to run as the
-- docker-compose superuser. This repo's ACTUAL migration model today (README
-- gap G-4: local dev runs as the compose superuser, production
-- identity/mechanism undecided) is exactly "every migration runs as the same
-- connecting role" — which the plain variant below already covers
-- correctly. The `FOR ROLE nominara_owner` production variant is deferred
-- until a future story (likely alongside real Terraform/production
-- infrastructure) decides production's migration-identity model; see
-- STORY-010's Technical Notes and README "Disclosed gaps" G-4 for the
-- explicit, disclosed limitation this leaves.
--
-- CORRECTION 2: the reference's `GRANT INSERT, SELECT ON audit_log` is
-- necessary but not sufficient — audit_log.seq is bigserial, and inserting
-- into a bigserial column requires USAGE on its underlying sequence
-- (audit_log_seq_seq), or the insert fails with "permission denied for
-- sequence". Added below, with its own ALTER DEFAULT PRIVILEGES so a future
-- serial/identity column isn't silently un-insertable either.
--
-- Statement ordering matches the reference exactly: the blanket
-- GRANT ... ON ALL TABLES runs BEFORE the audit_log/user_credentials
-- REVOKEs, so the REVOKEs are not immediately overwritten by the grant that
-- precedes them.
--
-- Idempotency: CREATE ROLE is cluster-scoped, unlike every other statement in
-- this migration chain, which is database-scoped. test/integration/
-- migrations.spec.ts (and every other integration spec in this repo) resets
-- a *database* inside the same cluster and re-applies the full chain, many
-- times, across many separate test files — a bare CREATE ROLE would raise
-- 42710 "role already exists" the second time any test migrates from empty.
-- Every role creation below is therefore guarded by a DO block, followed by
-- an unconditional ALTER ROLE that converges attributes even when the role
-- already existed with different ones.
--
-- No passwords are ever set here. Local dev passwords come from
-- src/db/dev-credentials.ts, sourced from environment variables; test-fixture
-- passwords are set inside the test container. See this story's disclosed
-- gap G-2 (no Secrets Manager locally) for how production issues them.

-- ============================================================================
-- Roles
-- ============================================================================

-- Migration/DDL owner. Owns all objects in production. NEVER used by a
-- running service — NOLOGIN makes that true by construction, not by a health
-- check (src/db/roles.ts's assertNotMigrationOwner is the runtime backstop).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_owner') THEN
    CREATE ROLE nominara_owner NOLOGIN NOINHERIT;
  END IF;
END $$;
ALTER ROLE nominara_owner NOLOGIN NOINHERIT CONNECTION LIMIT -1;

-- Runtime roles. RLS applies to all of them once STORY-011 lands (§3).
--
-- Post-review fix (item 2): the converging ALTER ROLE below explicitly
-- negates every dangerous attribute (NOBYPASSRLS/NOSUPERUSER/NOCREATEDB/
-- NOCREATEROLE/NOREPLICATION), not just LOGIN/NOINHERIT/CONNECTION LIMIT.
-- Postgres leaves an attribute untouched if an ALTER ROLE statement doesn't
-- mention it, so a role pre-created (by Terraform, or a stale manual
-- ALTER ROLE) with e.g. BYPASSRLS would otherwise keep it forever even after
-- this "converging" statement runs — verified by reproduction. Re-listing
-- every attribute, positive or negative, on every apply is what makes this
-- statement actually converge rather than merely create.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_app') THEN
    CREATE ROLE nominara_app LOGIN NOINHERIT CONNECTION LIMIT 400; -- src/api, src/gateway
  END IF;
END $$;
ALTER ROLE nominara_app LOGIN NOINHERIT CONNECTION LIMIT 400
  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_worker') THEN
    CREATE ROLE nominara_worker LOGIN NOINHERIT CONNECTION LIMIT 300; -- src/workers/*
  END IF;
END $$;
ALTER ROLE nominara_worker LOGIN NOINHERIT CONNECTION LIMIT 300
  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_report') THEN
    CREATE ROLE nominara_report LOGIN NOINHERIT CONNECTION LIMIT 40; -- read-only, replica only (G-3)
  END IF;
END $$;
ALTER ROLE nominara_report LOGIN NOINHERIT CONNECTION LIMIT 40
  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_portal') THEN
    CREATE ROLE nominara_portal LOGIN NOINHERIT CONNECTION LIMIT 60; -- share-token portal, read-only
  END IF;
END $$;
ALTER ROLE nominara_portal LOGIN NOINHERIT CONNECTION LIMIT 60
  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- Break-glass. Dual approval + a 60-minute TTL credential from Secrets
-- Manager in production (G-2, disclosed — no Secrets Manager locally).
-- BYPASSRLS is the one attribute no runtime role above may ever carry.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_breakglass') THEN
    CREATE ROLE nominara_breakglass LOGIN NOINHERIT BYPASSRLS CONNECTION LIMIT 2;
  END IF;
END $$;
ALTER ROLE nominara_breakglass LOGIN NOINHERIT BYPASSRLS CONNECTION LIMIT 2;

-- ============================================================================
-- Grants
-- ============================================================================

GRANT USAGE ON SCHEMA app, public TO nominara_app, nominara_worker, nominara_report, nominara_portal;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nominara_app, nominara_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nominara_report, nominara_portal;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO nominara_app, nominara_worker;

-- CORRECTION 1/2 — default privileges for objects created hereafter by THIS
-- migration session's own role (the docker-compose superuser locally).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nominara_app, nominara_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO nominara_report, nominara_portal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO nominara_app, nominara_worker;

-- audit_log — append-only at the grant level too, belt and braces alongside
-- the reject_update_delete trigger from 0004 (security-and-tenancy.md §2's
-- own note: "two independent controls on it is proportionate"). Runs AFTER
-- the blanket ALL TABLES grant above so it is not immediately overwritten.
REVOKE ALL ON audit_log FROM nominara_app, nominara_worker;
GRANT INSERT, SELECT ON audit_log TO nominara_app, nominara_worker;

-- user_credentials — reachable only by the auth path (nominara_app). A grant
-- decision, not a policy one (security-and-tenancy.md §1): RLS would be the
-- weaker control here because it would imply the table was reachable and
-- merely filtered.
REVOKE ALL ON user_credentials FROM nominara_worker, nominara_report, nominara_portal;

-- ============================================================================
-- Break-glass login alert (AC "its use emitting a page and an immutable
-- audit record"). G-1 disclosed: no PagerDuty locally, so RAISE LOG stands in
-- for what a production log-based alert would page on. The function body is
-- wrapped in EXCEPTION WHEN OTHERS so a fault in it can NEVER lock out
-- logins — an `ON login` event trigger runs on every successful
-- authentication, and a trigger that raised unhandled would break login for
-- every role, not just nominara_breakglass.
--
-- Recovery if this ever misbehaves and blocks logins:
--   ALTER SYSTEM SET event_triggers = off; SELECT pg_reload_conf();
-- (a cluster-wide off switch for ALL event triggers — the fastest available
-- escape hatch, documented here loudly on purpose.)
--
-- "Immutable audit record" (the other half of the AC) is NOT achieved by
-- this trigger, and is disclosed as a gap in this story's Technical Notes:
-- break-glass connections are not workspace-scoped, and a dedicated table
-- for them would break the 69-table census (STORY-009).
-- ============================================================================

CREATE OR REPLACE FUNCTION app.breakglass_login_alert()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF session_user = 'nominara_breakglass' THEN
    RAISE LOG 'nominara_breakglass_login database=% pid=% at=%',
      current_database(), pg_backend_pid(), clock_timestamp();
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- CREATE EVENT TRIGGER has no IF NOT EXISTS / OR REPLACE form in Postgres,
-- so idempotency uses the same DO-block guard pattern as the roles above.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'breakglass_login_alert') THEN
    CREATE EVENT TRIGGER breakglass_login_alert ON login EXECUTE FUNCTION app.breakglass_login_alert();
  END IF;
END $$;

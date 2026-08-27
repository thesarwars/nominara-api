-- STORY-120: let the runtime role READ the migration ledger, so readiness
-- can answer at all.
--
-- THE BUG. /health/ready compares the applied migration set against the one
-- this build expects, reading _migrations.applied over the POOLED connection
-- as nominara_app. Migration 0005 grants `USAGE ON SCHEMA app, public` and
-- never `_migrations`, so that read failed with "permission denied for
-- schema _migrations", the applied set was null, and the comparison could
-- never match. Readiness returned 503 in every environment and always had.
--
-- WHY NO GATE SAW IT. Every integration test connects as the container
-- superuser, which owns _migrations and can read it freely — so the runtime
-- role's inability was invisible to all of them, and one test
-- (database-roles-and-grants.spec.ts) actively asserted the missing grant as
-- correct. test/integration/readiness-as-runtime-role.spec.ts is the fix for
-- that: it opens the pooled connection AS nominara_app.
--
-- THE NARROWEST CHANGE THAT WORKS. USAGE on the schema plus SELECT on the
-- ledger, for nominara_app alone. Not a broader grant, and deliberately not
-- a move of the query onto the direct (owner) connection: readiness must
-- report what the APPLICATION's own connection can see, or it stops being a
-- readiness probe for the application and becomes one for the migration
-- tool.
--
-- WHICH ROLES. src/db/conventions.ts's MIGRATION_LEDGER_READERS is the
-- source of truth and records the per-role reasoning: nominara_app yes;
-- nominara_worker, nominara_report and nominara_portal no, each for its own
-- stated reason rather than by omission.
--
-- No runtime role may WRITE the ledger. An application that can rewrite the
-- record of its own schema version can lie to its own readiness probe.
--
-- Idempotency: GRANT/REVOKE are naturally repeatable, and the REVOKE ALL
-- below runs FIRST so this migration CONVERGES the end state rather than
-- only adding to it — the same posture 0005 takes with its own ALTER ROLE
-- and audit_log statements. Re-applying it by hand cannot leave a wider
-- grant in place than the one declared here.
--
-- PUBLIC is named in both REVOKEs, and that is not decoration. `REVOKE ...
-- FROM <named roles>` does not reach a privilege held via the PUBLIC
-- pseudo-role, so without it the obvious operator quick-fix for "permission
-- denied for schema _migrations" — `GRANT ... ON SCHEMA _migrations TO
-- PUBLIC` — survives a re-run of this migration intact, leaving all four
-- runtime roles with CREATE on the schema and write on the ledger while
-- this file still claims to have converged. Found by the STORY-120
-- second-engineer review, which reproduced exactly that. PUBLIC holds
-- nothing on either object in the clean end state, so revoking from it is
-- strictly narrowing and cannot remove access anything relies on.
--
-- Migration identity: this GRANTs on a schema created by
-- src/db/migrate-runner.ts's BOOTSTRAP_SQL in the same session that applies
-- this file, so the granting role owns it. README gap G-4 (production's
-- migration identity is undecided) applies here exactly as it does to 0005.

REVOKE ALL ON SCHEMA _migrations FROM nominara_app, nominara_worker, nominara_report, nominara_portal, PUBLIC;
REVOKE ALL ON _migrations.applied FROM nominara_app, nominara_worker, nominara_report, nominara_portal, PUBLIC;

GRANT USAGE ON SCHEMA _migrations TO nominara_app;
GRANT SELECT ON _migrations.applied TO nominara_app;

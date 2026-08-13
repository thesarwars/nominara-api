-- Reverse of 0005.up.sql. Roles themselves are deliberately NOT dropped.
--
-- CREATE ROLE is cluster-scoped, shared across every database in the
-- cluster — including drift-check's disposable shadow database and every
-- integration-test container's database — so a DROP ROLE here could fail
-- with "role cannot be dropped because some objects depend on it" if the
-- role holds privileges granted by a DIFFERENT database's migration run in
-- the same cluster. A role stripped of every privilege below is harmless
-- residue; the guarded CREATE ROLE / converging ALTER ROLE pattern in
-- 0005.up.sql already makes re-applying this migration idempotent regardless
-- of whether the role pre-existed. "Rollback does not remove the roles" is a
-- deliberate decision, not a bug — see this story's PR notes.
--
-- DROP OWNED BY is deliberately NOT used either: it is a data-destroying
-- statement (it can drop objects, not just revoke privileges) that the
-- additive-only guard has no way to inspect or block, which is not an
-- acceptable trade for a rollback path.

DROP EVENT TRIGGER IF EXISTS breakglass_login_alert;
DROP FUNCTION IF EXISTS app.breakglass_login_alert();

REVOKE ALL ON user_credentials FROM nominara_worker, nominara_report, nominara_portal;
REVOKE ALL ON audit_log FROM nominara_app, nominara_worker;

-- The `FOR ROLE nominara_owner` default-privilege variant was removed from
-- 0005.up.sql (post-review fix pass, see that file's CORRECTION 1a) — there
-- is nothing to revoke here for it. Only the plain variant below, which the
-- up migration actually applies, needs reversing.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE USAGE ON SEQUENCES FROM nominara_app, nominara_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT ON TABLES FROM nominara_report, nominara_portal;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM nominara_app, nominara_worker;

REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM nominara_app, nominara_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nominara_app, nominara_worker, nominara_report, nominara_portal;
REVOKE USAGE ON SCHEMA app, public FROM nominara_app, nominara_worker, nominara_report, nominara_portal;

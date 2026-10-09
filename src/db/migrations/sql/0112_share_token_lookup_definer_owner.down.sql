-- Rollback of 0112. Returns the function to the migration identity (the 0080 shape) and strips every right the
-- dedicated role held. The ROLE itself is left in place, as 0005's down does for cluster-scoped roles: CREATE ROLE is
-- shared across databases, and an unprivileged NOLOGIN role with no grants and no objects is inert.
-- @contract-phase
DROP POLICY IF EXISTS share_token_gate_lookup ON share_tokens;
ALTER FUNCTION app.share_token_by_hash(bytea) OWNER TO CURRENT_USER;
ALTER FUNCTION app.share_token_by_hash(bytea) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION app.share_token_by_hash(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.share_token_by_hash(bytea) TO nominara_app;
REVOKE SELECT (id, workspace_id, token_hash, password_hash, password_required, scope_project_ids, scope_tabs, theme_id,
               allowed_email_domains, revoked_at, expires_at, max_views, view_count, locked_until)
  ON share_tokens FROM nominara_share_lookup;
REVOKE USAGE ON SCHEMA app, public FROM nominara_share_lookup;

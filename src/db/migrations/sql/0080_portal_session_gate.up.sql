-- NEW-E-098b (STORY-098 part B) — EXPAND phase. Lane range 0079-0081.
--
-- 1. The per-token failed-password lock (integrations-and-sharing.md §3 step 2: "5 failures per token -> 15-minute
--    lock") lives ON the token row, not in Valkey. The lock is a security control; a cache that is evicted, flushed or
--    unreachable would silently unlock every link, and the row already serialises concurrent attempts (UPDATE takes
--    the row lock), which a counter in a cache does not. Both columns are nullable/defaulted: additive.
--      failed_attempts  consecutive wrong passwords since the last success or lock
--      locked_until     the instant the 15-minute cooldown ends; NULL = not locked
--    When the 5th failure sets the lock, failed_attempts restarts from 0.
--
-- 2. app.share_token_by_hash(bytea) — the ONE pre-authentication read. The portal gate is handed a secret and does not
--    yet know the workspace, so ws_isolation_share_tokens (workspace_id = app.current_workspace()) hides every row from
--    nominara_app. This function resolves a token hash to the minimal gate row and nothing else: no token_hash, label,
--    prefix or creator. SECURITY DEFINER with a pinned search_path (so a hostile schema earlier on the path cannot
--    shadow a name it resolves), EXECUTE revoked from PUBLIC and granted to nominara_app ONLY.
--
--    OPERATOR NOTE: share_tokens is FORCE ROW LEVEL SECURITY, so a definer function sees rows only if its OWNER
--    bypasses RLS (a superuser, or a BYPASSRLS role). The migration identity must be one of those; if it is a plain
--    NOBYPASSRLS owner the function returns no row and every portal link is refused as unknown. That fails CLOSED,
--    and test/integration/share-token-gate-rls.spec.ts proves the function returns the row, so a deployment whose
--    migration identity cannot should fail that check, not ship.

-- Nullable with a default of 0: a NOT NULL add on a populated table is a contract-phase step (additive guard), and
-- NULL is read as 0 everywhere (COALESCE), so there is no state in which the two differ.
ALTER TABLE share_tokens
  ADD COLUMN failed_attempts integer DEFAULT 0 CHECK (failed_attempts >= 0),
  ADD COLUMN locked_until    timestamptz;

CREATE OR REPLACE FUNCTION app.share_token_by_hash(p_hash bytea)
RETURNS TABLE (
  id                    uuid,
  workspace_id          uuid,
  password_hash         text,
  password_required     boolean,
  scope_project_ids     uuid[],
  scope_tabs            text[],
  theme_id              uuid,
  allowed_email_domains text[],
  revoked_at            timestamptz,
  expires_at            timestamptz,
  max_views             integer,
  view_count            integer,
  locked_until          timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.workspace_id, t.password_hash, t.password_required, t.scope_project_ids, t.scope_tabs, t.theme_id,
         COALESCE(t.allowed_email_domains::text[], ARRAY[]::text[]),
         t.revoked_at, t.expires_at, t.max_views, t.view_count, t.locked_until
    FROM public.share_tokens t
   WHERE t.token_hash = p_hash
$$;

REVOKE ALL ON FUNCTION app.share_token_by_hash(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.share_token_by_hash(bytea) TO nominara_app;

COMMENT ON FUNCTION app.share_token_by_hash(bytea) IS
  'NEW-E-098b — pre-auth share-token lookup by sha256(secret). SECURITY DEFINER; returns only the gate columns; EXECUTE for nominara_app only.';

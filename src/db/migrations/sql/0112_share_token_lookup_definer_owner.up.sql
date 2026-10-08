-- CP2 owner decision (1) — rebuild app.share_token_by_hash (0080) as ONE narrow SECURITY DEFINER lookup owned by a
-- DEDICATED role (docs/adr/ADR-0002-definer-owner-role-policy.md). Lane range 0112-0114.
--
-- WHY. The portal gate is handed a secret and does not yet know the workspace, so ws_isolation_share_tokens
-- (workspace_id = app.current_workspace()) hides every row from nominara_app. The lookup must therefore run with the
-- rights of an owner that the policy admits. 0080 left that owner as "whoever ran the migration" (a superuser in dev
-- and test), which is the widest possible answer and, if the production migration identity is the plain NOBYPASSRLS
-- nominara_owner, silently returns nothing (README G-4).
--
-- WHAT. nominara_share_lookup:
--   * NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION: nobody can connect as it
--     and no runtime role is a member of it, so its rights are only ever exercised by calling the function.
--   * NOT BYPASSRLS. ISO-07 and ADR-0001 reserve that attribute for nominara_breakglass alone, and ADR-0001 rejected
--     "grant the definer BYPASSRLS". It reads FORCE-RLS share_tokens through ONE role-targeted policy instead,
--     share_token_gate_lookup (FOR SELECT TO nominara_share_lookup USING (true)). The policy is inert for every other
--     role, and the role's reach is bounded by its grants, not by the policy:
--   * SELECT on share_tokens limited to FOURTEEN COLUMNS (the gate columns plus token_hash for the WHERE). No table
--     grant, no INSERT/UPDATE/DELETE, no grant on any other table: label, token_prefix, created_by, created_at and
--     every other table are unreadable to it.
--   * USAGE on schemas app and public (to resolve the function's own references); no CREATE anywhere. It needs CREATE
--     on app for a moment, to receive ownership; that is granted and revoked inside this migration.
--
-- The function is replaced (same signature, same columns, same equality-only WHERE on the hash) with:
--   * search_path = pg_catalog, pg_temp: no user-writable schema, and pg_temp last so a temp object cannot shadow a
--     catalog name. Every relation is schema-qualified anyway.
--   * EXECUTE revoked from PUBLIC and granted to nominara_app ONLY, as in 0080.
--
-- OPERATOR NOTE: the migration identity needs CREATEROLE (or superuser) to create the role and ownership of the
-- function it hands over; the same identity that applied 0005. No BYPASSRLS attribute is involved.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nominara_share_lookup') THEN
    CREATE ROLE nominara_share_lookup NOLOGIN NOINHERIT;
  END IF;
END $$;
-- Converging, as 0005: re-state every attribute so a pre-existing role (e.g. one hand-given BYPASSRLS) cannot keep it.
ALTER ROLE nominara_share_lookup NOLOGIN NOINHERIT CONNECTION LIMIT -1
  NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

GRANT USAGE ON SCHEMA app, public TO nominara_share_lookup;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nominara_share_lookup;
GRANT SELECT (id, workspace_id, token_hash, password_hash, password_required, scope_project_ids, scope_tabs, theme_id,
              allowed_email_domains, revoked_at, expires_at, max_views, view_count, locked_until)
  ON share_tokens TO nominara_share_lookup;

-- The one policy that lets the owner see rows. FOR SELECT only, TO the owner role only: ws_isolation_share_tokens is
-- untouched and no other role's view of share_tokens changes. Postgres combines PERMISSIVE policies per role, so this
-- one contributes nothing to nominara_app/worker/report/portal.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'share_tokens' AND policyname = 'share_token_gate_lookup') THEN
    CREATE POLICY share_token_gate_lookup ON share_tokens FOR SELECT TO nominara_share_lookup USING (true);
  END IF;
END $$;

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
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id, t.workspace_id, t.password_hash, t.password_required, t.scope_project_ids, t.scope_tabs, t.theme_id,
         COALESCE(t.allowed_email_domains::text[], ARRAY[]::text[]),
         t.revoked_at, t.expires_at, t.max_views, t.view_count, t.locked_until
    FROM public.share_tokens t
   WHERE t.token_hash = p_hash
$$;

-- Hand the function to the dedicated role. Ownership transfer needs the new owner to hold CREATE on the schema.
GRANT CREATE ON SCHEMA app TO nominara_share_lookup;
ALTER FUNCTION app.share_token_by_hash(bytea) OWNER TO nominara_share_lookup;
REVOKE CREATE ON SCHEMA app FROM nominara_share_lookup;

-- ALTER ... OWNER keeps the ACL as is, but state it again: nobody but nominara_app (and the owner) may EXECUTE.
REVOKE ALL ON FUNCTION app.share_token_by_hash(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.share_token_by_hash(bytea) TO nominara_app;

COMMENT ON FUNCTION app.share_token_by_hash(bytea) IS
  'Pre-auth share-token lookup by sha256(secret). SECURITY DEFINER, owned by nominara_share_lookup (NOLOGIN, NOBYPASSRLS, one SELECT policy, column-limited SELECT on share_tokens); returns only the gate columns; EXECUTE for nominara_app only.';

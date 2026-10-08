# ADR-0002 — A dedicated, NOBYPASSRLS owner for the share-token lookup, admitted by one role-targeted policy

**Status:** Proposed (implements CP2 owner decision 1; needs the auditor's sign-off before it is Accepted)

## Context

The share-link portal gate is handed a secret and does not yet know the workspace, so `ws_isolation_share_tokens`
(`workspace_id = app.current_workspace()`) hides every `share_tokens` row from `nominara_app`. Migration `0080` added
`app.share_token_by_hash(bytea)` as a `SECURITY DEFINER` lookup. `share_tokens` is `FORCE ROW LEVEL SECURITY`, so a
definer function sees rows only if its owner is admitted by a policy or bypasses RLS. In `0080` the owner was whoever ran
the migration: a superuser locally (works, and is far too broad), and in production an undecided identity (README G-4;
if it is the plain `nominara_owner` the function returns nothing and every portal link is refused).

The owner decision of 2026-10-08: one narrow `SECURITY DEFINER` function that looks up a single share token by its hash
and returns only that row, owned by a dedicated role (not a superuser, not the app role), `search_path` pinned,
`EXECUTE` granted only to the runtime role, auditor-reviewed.

ADR-0001 already rejected "give the definer `BYPASSRLS`", and `ISO-07` states that only `nominara_breakglass` has
`rolbypassrls`. This decision keeps both.

## Decision

1. A new role `nominara_share_lookup`: `NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`.
   No runtime role is a member of it. It owns exactly one object, the function.
2. It is admitted to `share_tokens` by **one** policy, `share_token_gate_lookup ... FOR SELECT TO nominara_share_lookup
   USING (true)`. The policy is inert for every other role (permissive policies combine per role) and
   `ws_isolation_share_tokens` is unchanged.
3. Its reach is bounded by grants, not by the policy: `SELECT` on 14 named `share_tokens` columns (the gate columns plus
   `token_hash`), no other table, no write, no schema `CREATE`.
4. The function keeps its 0080 signature and equality-only `WHERE token_hash = p_hash`, with
   `search_path = pg_catalog, pg_temp` and `EXECUTE` for `nominara_app` only.
5. The policy is hand-written in migration `0112` (as `0051`/`0074` do for their own policies) and declared to
   `src/db/rls/rls-check.ts` through `computeDefinerOwnerPolicies`, so rls-check expects it and still flags any
   other undeclared policy.

## Consequences

- `ISO-07` holds unchanged on the fully migrated schema (asserted by `DEF-8`).
- The definer-owner role has no superuser or BYPASSRLS attribute. The migration identity must be a SUPERUSER, as for
  `0005`: `CREATEROLE` is not enough (`ALTER ROLE ... NOSUPERUSER` and `ALTER FUNCTION ... OWNER TO` fail for a
  non-superuser; reproduced on PG 17.6). A failed apply aborts and fails closed. A non-superuser path is undesigned.
- The policy is a second policy class on `share_tokens`. Any further definer-owner needs its own ADR; this one does not
  generalise.
- `DATABASE_ROLES` (the drift-check registry) does not list the role, because `database-roles-and-grants.spec.ts`
  migrates 0001-0005 only; the role's attributes are asserted by `DEF-1` instead.

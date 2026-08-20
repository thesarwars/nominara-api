# ADR-0001 — Actor-self-scoped RLS policy class for cross-workspace self-reads

**Status:** Accepted

## Context

STORY-021 (`GET /workspaces`, AC 5) and the `409 workspace_limit_reached` conflict
detail (AC 2) both need to read a single user's own rows in `workspace_members`
and `workspaces` *before* any target workspace is known — an actor listing
their memberships, or being told the name of the workspace they already own,
has by definition not yet selected a tenant to scope a transaction to. Every
tenant table, including these two, carries `ENABLE`/`FORCE ROW LEVEL SECURITY`
plus a `ws_isolation_*` policy scoped to `app.current_workspace()`
(migration `0006`), so there was no existing path to "give me all rows where
I'm a member" — that read is inherently cross-tenant. No reference document
specifies a mechanism for it; this was a genuine specification gap, recorded
as `STORY-021-E-11` pending this review.

Two alternatives were considered and rejected:

- **`SECURITY DEFINER` function.** `FORCE ROW LEVEL SECURITY` subjects even
  the table owner (`nominara_owner`, the function's definer) to RLS. Every
  generated policy is granted `TO nominara_app, nominara_worker,
  nominara_report` (or `nominara_portal`) — `nominara_owner` matches none of
  them, so a definer function returns zero rows unless granted `BYPASSRLS`.
  `ISO-07` reserves `BYPASSRLS` for `nominara_breakglass` only. Weakening
  that to make this function work is not on the table.
- **A new global membership-projection table**, mirrored off
  `workspace_members`/`workspaces` by triggers and exempted from RLS the way
  `sessions`/`user_credentials` are. Rejected as the primary path: it
  introduces a second source of truth for tenant data (workspace name, slug,
  plan badge) that must be kept trigger-consistent across multiple source
  tables, which is exactly the drift risk this codebase already flags
  elsewhere (the `subscriptions` vs. `workspaces.plan_key` reconciliation
  job). It remains the fallback if this decision is ever reversed.

## Decision

Add a second, `SELECT`-only, actor-self-scoped RLS policy class — the same
shape as the existing `portal_scope_*` second-policy-class precedent — to
exactly two tables: `workspaces` and `workspace_members`. No other table is
in scope; `workspaces.plan_key` is already denormalized onto the workspace
row, so the plan badge needs no third table.

```sql
CREATE POLICY self_membership_workspace_members ON workspace_members
  FOR SELECT TO nominara_app
  USING (app.current_workspace() IS NULL AND user_id = app.current_actor());

CREATE POLICY self_membership_workspaces ON workspaces
  FOR SELECT TO nominara_app
  USING (app.current_workspace() IS NULL AND EXISTS (
    SELECT 1 FROM workspace_members m
    WHERE m.workspace_id = workspaces.id AND m.user_id = app.current_actor() AND m.status = 'active'));
```

The `app.current_workspace() IS NULL` conjunct is load-bearing: inside any
normal tenant-scoped transaction (both GUCs set) it is false, so the policy
is inert and contributes nothing beyond the existing `ws_isolation_*` policy
— Postgres combines multiple `PERMISSIVE` policies for the same role/command
with `OR`, so this is strictly additive, never wider, in the tenant-scoped
case. It only activates in a new, explicit **actor-only context** where the
workspace GUC is cleared and only the actor GUC is set.

Implementation requirements:

- **Generator-driven, no hand-written policy SQL.** A new
  `ACTOR_SELF_SCOPED_TABLES = ["workspaces", "workspace_members"]` constant
  in `src/db/conventions.ts`, consumed by a new policy branch in
  `src/db/rls/generate.ts`'s `computeExpectedPolicies`, so
  `src/db/rls/rls-check.ts`'s drift fingerprinting covers the new policies
  automatically, the same way it already covers `ws_isolation_*` and
  `portal_scope_*`.
- **`withActorContext`** is a new export in `src/tenancy/tenant-context.ts`,
  sibling to `withTenantContext`, over its own `ActorOnlyContext { readonly
  actorId: string }` type — **not** `TenantContext` with an optional
  `workspaceId` — so no call site can structurally smuggle a workspace id
  through this path. It explicitly clears the workspace GUC
  (`set_config('app.current_workspace_id', '', true)`) rather than relying
  on it being unset, and additionally issues `SET LOCAL TRANSACTION READ
  ONLY` as defense-in-depth beyond RLS's own `WITH CHECK`-driven write
  denial.
- **`src/tenancy/query-guard.ts`** is extended so that, in actor-only mode, a
  query referencing any tenant table *outside*
  `ACTOR_SELF_SCOPED_TABLES` still throws — a future accidental reuse of
  `withActorContext` against, say, `projects` must fail loud, not rely on
  RLS's silent zero-rows behavior as the only backstop.

## Consequences

- **Migration mechanics — decided, not open.** The new policies ship in a
  new, purely additive migration, `src/db/migrations/sql/
  0012_actor_self_scoped_membership_policies.{up,down}.sql` (see STORY-021's
  "Files this story owns"), generated via `pnpm db:rls-generate` — migration
  `0006` is not hand-edited. This matches the expand-only migration
  convention.
- **New isolation-suite cases required**, `test/isolation/assertions/
  iso-18-*` onward, added to `registry.ts`:
  - Actor-only context returns only the calling actor's own **active**
    memberships/workspaces, never another actor's, never a
    `removed`/`suspended` one (multi-actor fixture).
  - No GUCs set at all still yields zero rows on these two tables now that a
    second policy exists on them (an `ISO-01` regression case).
  - Under a normal two-GUC tenant-scoped transaction, the new policy
    contributes **zero additional rows** — actor A's tenant-scoped session
    cannot see actor B's cross-tenant memberships via the OR-combined
    policy. This is the test that actually proves "inert," not just asserts
    it.
  - Under actor-only context, every INSERT/UPDATE/DELETE against both
    tables fails or affects 0 rows, verified empirically.
  - `ISO-08`-style fuzz extended to replay actor A's session against
    `GET /workspaces` and the creation-409-detail path under actor B's
    identity.
- **This is the first intentional NULL-workspace-grants-access precedent in
  the schema.** Every other read in the system is fail-closed on an unset
  workspace GUC; here, an explicitly-cleared workspace GUC is a *deliberate*
  trigger for a different, narrower grant. `security-and-tenancy.md` §3's
  prose ("an un-contextualised query returns zero rows") should be read as
  describing `ws_isolation_*`/`portal_scope_*` behavior, not a platform-wide
  absolute, now that this policy class exists — future readers of that
  section should be pointed at this ADR.
- Scope is pinned to exactly two tables. Extending
  `ACTOR_SELF_SCOPED_TABLES` to any other table is a new decision, not a
  precedent this ADR pre-approves.

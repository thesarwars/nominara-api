import { SetMetadata } from "@nestjs/common";

// STORY-169 review — a workspace-level LIST route (`GET /projects`,
// `GET /workspaces/:id/action-items`) names no single project in its URL,
// so `@ProjectParam()` has nothing to point at. Before this decorator,
// `RbacGuard.assertInScope` read that absence as "cannot verify scope,
// refuse" for EVERY "scoped" permission (permission-matrix.ts) — which is
// the right default for a route that returns ONE resource (a scoped member
// with no matching param genuinely has no id to check), but the wrong one
// for a route whose OWN query already narrows by
// `app.current_scope_projects()` (`ProjectsService.list`, copied verbatim
// into `TasksService.listActionItems`) — there the scope check is real, it
// just runs in SQL instead of against `req.params`.
//
// `@ScopedByQuery()` marks a route as being in the second category. It
// changes RbacGuard's behaviour ONLY on a route that carries it:
//   - `projectScope === null | undefined` (unrestricted) — unaffected,
//     already let through by the existing check.
//   - `projectScope.length === 0` (scoped to NOTHING) — still refused.
//     Letting this one case through would leak every project: the tenant
//     context only sets the `app.current_scope_projects()` GUC when
//     `scopeProjectIds.length > 0` (`tenant-context.ts`), so an empty scope
//     reaching the query would read as `cardinality(...) = 0`, which the
//     SQL predicate — correctly, for an UNRESTRICTED member — treats as "no
//     restriction". A zero-project manager must never fall into that branch.
//   - `projectScope.length > 0` — let through. The query's own
//     `app.current_scope_projects()` predicate does the actual narrowing,
//     so the member sees only their in-scope projects, not a 403.
//
// Every OTHER route with a "scoped" permission and no `@ProjectParam()` is
// UNCHANGED: still refused. This decorator only ever WIDENS access on a
// route that explicitly opts in, never narrows it, and never touches the
// single-project `@ProjectParam()` path at all.
export const SCOPED_BY_QUERY_KEY = "scopedByQuery";
export const ScopedByQuery = (): MethodDecorator & ClassDecorator => SetMetadata(SCOPED_BY_QUERY_KEY, true);

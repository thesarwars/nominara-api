import type { ClientBase } from "pg";
import { ProjectOutOfScopeException } from "./errors.js";

// STORY-019 review - a route whose id names an ENTITY (a run, a result, a
// prompt) rather than a project cannot give RbacGuard a project to compare the
// member's scope against, so it carries `@ScopedByQuery()` and the service
// checks the row's own project here, before it reads further or writes.
//
// `app.current_scope_projects()` is empty for an unrestricted member (the
// tenant context sets the GUC only for a non-empty scope), and RbacGuard has
// already refused a member scoped to NOTHING on a `@ScopedByQuery()` route, so
// empty means "all projects" here and only here.
//
// A denial is a 403 naming the scope, never a 404: the row exists in this
// workspace (RLS has already made a foreign one absent) and the member is
// simply not assigned to its project.
export async function assertProjectInScope(client: ClientBase, projectId: string): Promise<void> {
  const result = await client.query<{ in_scope: boolean }>(
    `SELECT (cardinality(app.current_scope_projects()) = 0 OR $1::uuid = ANY(app.current_scope_projects())) AS in_scope`,
    [projectId],
  );
  if (result.rows[0]?.in_scope !== true) throw new ProjectOutOfScopeException();
}

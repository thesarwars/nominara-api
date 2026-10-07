import { NotFoundException } from "@nestjs/common";
import { WorkspaceMismatchException } from "./errors.js";

// STORY-021 — WorkspaceGuard resolves the caller's workspace from the
// session token's `ws` claim, never the URL (workspace.guard.ts). Every
// workspace-scoped route in this story ALSO names a workspace in its own
// URL (`/workspaces/{id}`, `/workspaces/{id}/members`, ...), so a caller
// whose token names workspace A can otherwise put workspace B's id in the
// URL. RLS already prevents any cross-tenant row from being read/written
// (the ambient transaction is scoped to A), so this is defense in depth,
// not the security boundary — but a bare RLS empty-result would surface as
// a confusing 200/404-shaped nothing. A plain NotFoundException (never 403)
// avoids confirming or denying that workspace B exists to a caller who
// isn't in it.
export function assertMatchesTenant(urlWorkspaceId: string, tenantWorkspaceId: string): void {
  if (urlWorkspaceId !== tenantWorkspaceId) {
    throw new NotFoundException();
  }
}

// NEW-A-12 — the STRICT form: a path workspace id that is not the token's `ws`
// claim is a 403 `workspace_mismatch` (the same refusal WorkspaceGuard gives an
// API key naming another workspace). The comparison is a string equality on two
// values the caller already holds, so it answers identically whether or not the
// path workspace exists — it confirms nothing.
export function assertPathIsTokenWorkspace(urlWorkspaceId: string, tenantWorkspaceId: string): void {
  if (urlWorkspaceId !== tenantWorkspaceId) {
    throw new WorkspaceMismatchException();
  }
}

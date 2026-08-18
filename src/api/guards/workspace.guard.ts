import { CanActivate, Injectable } from "@nestjs/common";

// STORY-022-E-2 — pass-through no-op. Real logic (resolve the target workspace, re-verify a live workspace_members row, populate req.tenant) lands in STORY-018.
// Composed now, in the corrected order (STORY-022 Technical Notes), so that
// future story is a logic change to an existing slot, never a refactor of
// the composition root.
@Injectable()
export class WorkspaceGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

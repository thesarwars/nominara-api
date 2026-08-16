import { CanActivate, Injectable } from "@nestjs/common";

// STORY-022-E-2 — pass-through no-op. Real logic (evaluate @RequirePermission against the permission matrix) lands in STORY-018/019.
// Composed now, in the corrected order (STORY-022 Technical Notes), so that
// future story is a logic change to an existing slot, never a refactor of
// the composition root.
@Injectable()
export class RbacGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

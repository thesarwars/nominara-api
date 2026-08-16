import { CanActivate, Injectable } from "@nestjs/common";

// STORY-022-E-2 — pass-through no-op. Real logic (Valkey token bucket keyed (route class, workspace, user, ip)) lands in EPIC-10.
// Composed now, in the corrected order (STORY-022 Technical Notes), so that
// future story is a logic change to an existing slot, never a refactor of
// the composition root.
@Injectable()
export class RateLimitGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

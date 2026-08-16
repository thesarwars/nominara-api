import { CanActivate, Injectable } from "@nestjs/common";

// STORY-022-E-2 — pass-through no-op. Real logic (@RequireEntitlement / @RequireFeature -> 403 entitlement_exceeded | 403 feature_not_in_plan) lands in EPIC-10.
// Composed now, in the corrected order (STORY-022 Technical Notes), so that
// future story is a logic change to an existing slot, never a refactor of
// the composition root.
@Injectable()
export class EntitlementGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

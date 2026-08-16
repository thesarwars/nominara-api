import { CanActivate, Injectable } from "@nestjs/common";

// STORY-022-E-2 — pass-through no-op. Real logic (verify JWT signature and expiry, load the session, reject a revoked jti) lands in STORY-014 (passkey/WebAuthn).
// Composed now, in the corrected order (STORY-022 Technical Notes), so that
// future story is a logic change to an existing slot, never a refactor of
// the composition root.
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

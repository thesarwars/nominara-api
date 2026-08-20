import { createHash, randomBytes } from "node:crypto";

// STORY-021-E-6 — the invitation token is 256 bits from randomBytes, stored
// as sha256 in the `bytea` workspace_invitations.token_hash column, and
// never persisted in raw form (shown once in the create response, the
// api_keys "shown once" precedent). Expiry is 7 days — no reference
// document specifies one, so this single named constant is the one place
// that value lives, rather than spread across the service and its tests.

export const INVITATION_TOKEN_BYTES = 32;
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInvitationToken(): string {
  return randomBytes(INVITATION_TOKEN_BYTES).toString("base64url");
}

/** Returns a raw sha256 digest Buffer — bound straight into the bytea column, never hex/base64-encoded. */
export function hashInvitationToken(raw: string): Buffer {
  return createHash("sha256").update(raw).digest();
}

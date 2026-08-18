import { createHash, randomBytes } from "node:crypto";

// STORY-017 — refresh tokens are opaque, high-entropy random, stored hashed
// (security-and-tenancy.md §8: high-entropy random tokens use SHA-256). The
// raw value is only ever held by the client; the row stores token_hash.

export const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("base64url");
}

export function hashRefreshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { decryptField, encryptField } from "../crypto/envelope.js";

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

// STORY-170 — security-and-tenancy.md §5 "Session model", the refresh-token
// reuse grace window. A refresh presenting the token consumed by the
// session's OWN IMMEDIATELY-PRECEDING rotation, within this window, must get
// the identical successor back rather than be treated as reuse — concurrent
// requests racing the same rotation (multiple tabs, multiple app instances)
// converge on one token instead of one of them revoking the session
// (SessionService.refresh owns the eligibility decision; this file only
// owns the window's bound and the at-rest encryption of the value it
// governs).
//
// Default ~2s: long enough to absorb the in-flight-request race this exists
// for, short enough that a genuinely stolen-and-replayed token is still
// caught almost immediately. Configurable (REFRESH_TOKEN_GRACE_WINDOW_MS)
// so an operator can shrink it, or set it to 0 to disable the feature
// outright, without a redeploy — hard-capped here so it can never be
// widened into a de-facto non-rotating refresh token.
export const REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS = 2_000;
export const REFRESH_TOKEN_GRACE_WINDOW_HARD_MAX_MS = 5_000;

// The grace successor's raw value is held only for the window
// (sessions.refresh_grace_successor_ciphertext), encrypted with
// src/lib/crypto/envelope.ts — the same AES-256-GCM field format
// security-and-tenancy.md §8 uses for workspace_keys — under a key DERIVED
// FROM THE PREDECESSOR TOKEN ITSELF (HKDF-SHA256, salted with the session
// id). No server-side secret is involved, deliberately:
//
// - The server never stores the predecessor raw token (only its hash), so
//   the ciphertext can be opened only by a caller PRESENTING that token —
//   which is exactly the late arrival the window exists to serve. A leaked
//   database row, even together with every server secret, does not reveal
//   the live successor. A server-held key would have made "database + key"
//   enough to lift the live refresh token of every recently-rotated
//   session, undoing what storing tokens hashed buys.
// - A slot left behind by an idle session is therefore inert at rest: it
//   needs the consumed predecessor to open, and presenting that predecessor
//   once the window has closed revokes the family instead. That is why no
//   sweep job exists for expired slots.
// - Nothing new to provision: no environment secret, so an existing
//   deployment's configuration is unchanged by this feature.
//
// The AAD binds the ciphertext to this session's row; the HKDF salt binds
// the key to the session too, so a ciphertext copied onto another session's
// row, or opened with another session's token, fails authentication.
const GRACE_ENVELOPE_TABLE = "sessions";
const GRACE_ENVELOPE_COLUMN = "refresh_grace_successor_ciphertext";
const GRACE_ENVELOPE_WORKSPACE_ID = "global";
const GRACE_ENVELOPE_DEK_ID = "refresh-grace-v1";
const GRACE_KEY_INFO = "nominara/refresh-grace/v1";

function graceKey(sessionId: string, rawPredecessorToken: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(rawPredecessorToken, "utf8"), Buffer.from(sessionId, "utf8"), GRACE_KEY_INFO, 32));
}

function graceAad(sessionId: string) {
  return { workspaceId: GRACE_ENVELOPE_WORKSPACE_ID, table: GRACE_ENVELOPE_TABLE, column: GRACE_ENVELOPE_COLUMN, rowId: sessionId };
}

/** Encrypts the successor so only a caller presenting `rawPredecessorToken` can recover it. */
export function encryptGraceSuccessor(sessionId: string, rawPredecessorToken: string, rawSuccessorToken: string): string {
  return encryptField(rawSuccessorToken, graceKey(sessionId, rawPredecessorToken), GRACE_ENVELOPE_DEK_ID, graceAad(sessionId));
}

/** Recovers the successor; throws if the token, the session or the ciphertext does not match. */
export function decryptGraceSuccessor(sessionId: string, rawPredecessorToken: string, ciphertext: string): string {
  return decryptField(ciphertext, graceKey(sessionId, rawPredecessorToken), graceAad(sessionId));
}

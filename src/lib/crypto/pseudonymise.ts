import { createHash } from "node:crypto";

// STORY-020 — on workspace hard-delete, audit_log rows are retained only in
// the immutable export with the workspace identifier pseudonymised (never
// the literal id, but still consistently groupable within that export).
// Deterministic, one-way, no I/O, no clock, no randomness.

/** Deterministically pseudonymises a workspace id into a UUID-shaped, non-reversible value. */
export function pseudonymiseWorkspaceId(workspaceId: string): string {
  const digest = createHash("sha256").update("audit-log-workspace-pseudonym:").update(workspaceId).digest("hex");
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join(
    "-",
  );
}



/**
 * ⚠ `pseudonymiseActorId` WAS HERE AND HAS BEEN REMOVED. It hashed the user
 * id, and a hash of a surviving identifier is not a pseudonym.
 *
 * The second-engineer review re-identified an erased person three ways
 * against a real database, and the first two were the digest itself:
 *
 *   1. `requestIndividualErasure` ANONYMISES the `users` row, it does not
 *      delete it — every FK in the product points at that id. So the
 *      candidate space for a brute force is not 2^122, it is
 *      `SELECT id FROM users`, which is small and sitting in the same
 *      database as the pseudonym.
 *   2. The anonymised email is `'deleted+' || id || '@nominara.invalid'`
 *      (data-model.md §7's own spelling), so the raw UUID survives in
 *      PLAINTEXT in the row that was supposed to have removed it.
 *
 * The docstring that used to sit here claimed "an erasure cannot be undone
 * by anyone holding the database". It was wrong, and it was wrong in the
 * direction that matters.
 *
 * An HMAC under an external key would fix the brute force and add key
 * management, rotation, and a grouping that breaks when the key rotates —
 * for a value that never needs to be recomputed. The erased actor's
 * pseudonym is now simply RANDOM, assigned once at erasure time and stored:
 * nothing derives it, so there is nothing to invert, and one random UUID per
 * erased person groups their rows exactly as well as a digest did. See
 * `retention.ts`.
 */

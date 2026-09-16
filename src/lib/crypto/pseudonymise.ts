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
 * Deterministically pseudonymises a USER id, for the credit ledger's
 * accounting record.
 *
 * ⚠ A SEPARATE DOMAIN PREFIX FROM THE WORKSPACE ONE, and not for tidiness.
 * Sharing a prefix would make `pseudonymise(x)` collide across two different
 * kinds of identifier that happen to hold the same UUID — a workspace and a
 * user can, since both are v4/v7 UUIDs from the same space — and two
 * unrelated things would group together in a record kept for disputes.
 *
 * One-way, so an erasure cannot be undone by anyone holding the database:
 * the `users` row is anonymised in the same transaction, so there is no
 * surviving id to brute-force the digest against.
 */
export function pseudonymiseActorId(userId: string): string {
  const digest = createHash("sha256").update("credit-ledger-actor-pseudonym:").update(userId).digest("hex");
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join(
    "-",
  );
}

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

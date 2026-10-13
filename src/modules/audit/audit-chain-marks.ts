import type { ClientBase } from "pg";

// STORY-143 AC7 — the audit chain's high-water marks. The ONE place that
// reads or writes `audit_chain_marks` (migration 0123), so the verifier, the
// erasure rechain and the workspace hard delete can never drift on what a mark
// means.
//
// ⚠ PRIVILEGE CONTRACT. No runtime role has any privilege on this table, and
// that is the control: a mark the application could update or delete is a mark
// an attacker with application access could lower. Every function here takes a
// `ClientBase` that MUST be the privileged (table-owner) connection — the
// verifier's own, or the erasure / hard-delete jobs' — and fails with 42501 on
// anything else. It does not catch that: an integrity write that is swallowed
// is a mark that silently was not recorded.

export type MarkReason = "verified" | "rechain" | "tombstone";

/** A chain head: the highest seq in the workspace's chain and that row's stored hash. */
export interface ChainHead {
  readonly seq: string;
  readonly rowHash: Buffer;
}

/** The chain head as it is NOW, or null when the workspace has no audit rows. */
export async function readChainHead(client: ClientBase, workspaceId: string): Promise<ChainHead | null> {
  const result = await client.query<{ seq: string; row_hash: Buffer }>(
    "SELECT seq::text AS seq, row_hash FROM audit_log WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1",
    [workspaceId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { seq: row.seq, rowHash: row.row_hash };
}

/** The stored hash of the row at exactly `seq`, or null when that row does not exist. */
export async function rowHashAt(client: ClientBase, workspaceId: string, seq: string): Promise<Buffer | null> {
  const result = await client.query<{ row_hash: Buffer }>(
    "SELECT row_hash FROM audit_log WHERE workspace_id = $1 AND seq = $2::int8",
    [workspaceId, seq],
  );
  return result.rows[0]?.row_hash ?? null;
}

/**
 * The current mark: the non-tombstone row with the greatest `max_seq`.
 *
 * ⚠ GREATEST max_seq, NOT NEWEST checked_at. A verifier walking under a
 * REPEATABLE READ snapshot can commit its mark AFTER an erasure committed a
 * higher one; the newest-written row would then be the LOWER mark, and the
 * next walk would compare against a head that is behind the real one — a
 * window in which truncation back to the lower head goes unseen. Chains only
 * grow, so the greatest max_seq is always the strictest promise made.
 */
export async function readLatestMark(client: ClientBase, workspaceId: string): Promise<ChainHead | null> {
  const result = await client.query<{ max_seq: string; row_hash: Buffer }>(
    `SELECT max_seq::text AS max_seq, row_hash FROM audit_chain_marks
      WHERE workspace_id = $1 AND reason <> 'tombstone'
      ORDER BY max_seq DESC LIMIT 1`,
    [workspaceId],
  );
  const row = result.rows[0];
  return row === undefined ? null : { seq: row.max_seq, rowHash: row.row_hash };
}

export async function hasTombstone(client: ClientBase, workspaceId: string): Promise<boolean> {
  const result = await client.query("SELECT 1 FROM audit_chain_marks WHERE workspace_id = $1 AND reason = 'tombstone'", [workspaceId]);
  return (result.rowCount ?? 0) > 0;
}

/** Every workspace that has ever been marked — the set whose chain must still exist. */
export async function listMarkedWorkspaceIds(client: ClientBase): Promise<string[]> {
  const result = await client.query<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM audit_chain_marks");
  return result.rows.map((row) => row.workspace_id);
}

/** Appends a head mark (`verified` or `rechain`). */
export async function appendMark(
  client: ClientBase,
  workspaceId: string,
  head: ChainHead,
  reason: Exclude<MarkReason, "tombstone">,
): Promise<void> {
  await client.query(
    "INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason) VALUES ($1, $2::int8, $3, $4)",
    [workspaceId, head.seq, head.rowHash, reason],
  );
}

/** Records that the workspace was deleted on purpose. Idempotent: a retried deletion adds no second tombstone. */
export async function appendTombstone(client: ClientBase, workspaceId: string): Promise<void> {
  await client.query(
    "INSERT INTO audit_chain_marks (workspace_id, reason) VALUES ($1, 'tombstone') ON CONFLICT (workspace_id) WHERE reason = 'tombstone' DO NOTHING",
    [workspaceId],
  );
}

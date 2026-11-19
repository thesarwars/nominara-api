import type { ClientBase } from "pg";

// Batch 19 (STORY-020 follow-up) - the incremental audit export's watermarks. The ONE place that reads or writes `audit_export_watermarks`
// (migration 0215).
//
// PRIVILEGE CONTRACT, as audit-chain-marks.ts: no runtime role has any privilege on the table, so every function takes the privileged
// (table-owner) connection and fails with 42501 on anything else. A write that is swallowed is a watermark that silently was not recorded, and a
// watermark that is silently not recorded is a night's export repeated - so nothing here catches.

/** The point a chain has been exported up to: the highest seq the export covers and that row's stored hash. */
export interface ExportWatermark {
  readonly seq: string;
  readonly rowHash: Buffer;
}

/** One chain's entry in a finished run. */
export interface WatermarkAdvance {
  readonly workspaceId: string;
  readonly fromSeq: string;
  readonly maxSeq: string;
  readonly rowHash: Buffer;
}

/**
 * The current watermark of every chain that has one: its NEWEST row. Not the greatest max_seq: a chain an erasure rewrote is exported again from
 * its start, and the lower watermark that run records must supersede the stale higher one or the chain would be rebased every night.
 */
export async function readWatermarks(client: ClientBase): Promise<Map<string, ExportWatermark>> {
  const result = await client.query<{ workspace_id: string; seq: string; row_hash: Buffer }>(
    `SELECT DISTINCT ON (workspace_id) workspace_id, max_seq::text AS seq, row_hash
       FROM audit_export_watermarks
      ORDER BY workspace_id, exported_at DESC, id DESC`,
  );
  return new Map(result.rows.map((row) => [row.workspace_id, { seq: row.seq, rowHash: row.row_hash }]));
}

/** The SHA-256 (hex) of the manifest the most recent run wrote, or null before the first run. */
export async function readLatestManifestSha256(client: ClientBase): Promise<string | null> {
  const result = await client.query<{ manifest_sha256: Buffer }>(
    "SELECT manifest_sha256 FROM audit_export_watermarks ORDER BY exported_at DESC, id DESC LIMIT 1",
  );
  const row = result.rows[0];
  return row === undefined ? null : row.manifest_sha256.toString("hex");
}

/** Whether the row at `seq` in the chain still has exactly `rowHash` - false when it was rewritten (an erasure rechain) or removed. */
export async function chainRowStillMatches(client: ClientBase, workspaceId: string, seq: string, rowHash: Buffer): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    "SELECT (row_hash = $3) AS matches FROM audit_log WHERE workspace_id = $1 AND seq = $2::int8",
    [workspaceId, seq, rowHash],
  );
  return result.rows[0]?.matches === true;
}

/**
 * Records one finished run: one row per chain exported, all in one transaction so the run lands whole or not at all (a half-recorded run would
 * move some chains' watermarks and not others while the manifest chain says the run happened). `exported_at` is the transaction's `now()`, the
 * same for every row, which is what `readLatestManifestSha256` relies on.
 */
export async function recordRun(
  client: ClientBase,
  advances: readonly WatermarkAdvance[],
  written: { readonly dataSha256: string; readonly manifestSha256: string },
): Promise<void> {
  if (advances.length === 0) return;
  await client.query("BEGIN");
  try {
    for (const advance of advances) {
      await client.query(
        `INSERT INTO audit_export_watermarks (workspace_id, from_seq, max_seq, row_hash, object_sha256, manifest_sha256)
         VALUES ($1, $2::int8, $3::int8, $4, $5, $6)`,
        [
          advance.workspaceId,
          advance.fromSeq,
          advance.maxSeq,
          advance.rowHash,
          Buffer.from(written.dataSha256, "hex"),
          Buffer.from(written.manifestSha256, "hex"),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

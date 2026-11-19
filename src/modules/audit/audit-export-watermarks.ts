import type { ClientBase } from "pg";
import type { UnrecordedRun } from "./ports/export-sink.js";

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
 * The current watermark of every chain that has one: its NEWEST RECORDED row by `seq`. Not the greatest max_seq: a chain an erasure rewrote is
 * exported again from its start, and the lower watermark that run records must supersede the stale higher one or the chain would be rebased
 * every night. Intent rows are not watermarks: an intent whose recording failed must not move anything.
 */
export async function readWatermarks(client: ClientBase): Promise<Map<string, ExportWatermark>> {
  const result = await client.query<{ workspace_id: string; seq: string; row_hash: Buffer }>(
    `SELECT DISTINCT ON (workspace_id) workspace_id, max_seq::text AS seq, row_hash
       FROM audit_export_watermarks
      WHERE phase = 'recorded'
      ORDER BY workspace_id, audit_export_watermarks.seq DESC`,
  );
  return new Map(result.rows.map((row) => [row.workspace_id, { seq: row.seq, rowHash: row.row_hash }]));
}

/** What the next manifest links to and lists. */
export interface ExportLinkage {
  /** The SHA-256 (hex) of the manifest the most recent RECORDED run wrote, or null before the first run. */
  readonly previousManifestSha256: string | null;
  /** Runs with an intent after the last recorded run and no recording of their own, oldest first. */
  readonly unrecordedRuns: readonly UnrecordedRun[];
}

export async function readExportLinkage(client: ClientBase): Promise<ExportLinkage> {
  const latest = await client.query<{ seq: string; manifest_sha256: Buffer }>(
    "SELECT seq::text, manifest_sha256 FROM audit_export_watermarks WHERE phase = 'recorded' ORDER BY audit_export_watermarks.seq DESC LIMIT 1",
  );
  const last = latest.rows[0];
  // Every row of a run is written in one statement batch, so a run's rows are contiguous in seq; DISTINCT ON run_id gives one entry per run.
  const intents = await client.query<{ run_id: string; manifest_sha256: Buffer; object_sha256: Buffer }>(
    `SELECT run_id, manifest_sha256, object_sha256 FROM (
       SELECT DISTINCT ON (run_id) run_id, manifest_sha256, object_sha256, seq
         FROM audit_export_watermarks
        WHERE phase = 'intent' AND seq > $1::int8
          AND run_id NOT IN (SELECT run_id FROM audit_export_watermarks WHERE phase = 'recorded')
        ORDER BY run_id, seq
     ) unrecorded ORDER BY seq`,
    [last?.seq ?? "0"],
  );
  return {
    previousManifestSha256: last === undefined ? null : last.manifest_sha256.toString("hex"),
    unrecordedRuns: intents.rows.map((row) => ({
      runId: row.run_id,
      manifestSha256: row.manifest_sha256.toString("hex"),
      dataSha256: row.object_sha256.toString("hex"),
    })),
  };
}

/** Whether the row at `seq` in the chain still has exactly `rowHash` - false when it was rewritten (an erasure rechain) or removed. */
export async function chainRowStillMatches(client: ClientBase, workspaceId: string, seq: string, rowHash: Buffer): Promise<boolean> {
  const result = await client.query<{ matches: boolean }>(
    "SELECT (row_hash = $3) AS matches FROM audit_log WHERE workspace_id = $1 AND seq = $2::int8",
    [workspaceId, seq, rowHash],
  );
  return result.rows[0]?.matches === true;
}

const INSERT_SQL = `INSERT INTO audit_export_watermarks
  (run_id, phase, previous_manifest_sha256, workspace_id, from_seq, max_seq, row_hash, object_sha256, manifest_sha256)
  VALUES ($1, $2, $3, $4, $5::int8, $6::int8, $7, $8, $9)`;

async function insertRows(
  client: ClientBase,
  runId: string,
  phase: "intent" | "recorded",
  predecessorManifestSha256: string | null,
  advances: readonly WatermarkAdvance[],
  written: { readonly dataSha256: string; readonly manifestSha256: string },
): Promise<void> {
  if (advances.length === 0) return;
  await client.query("BEGIN");
  try {
    for (const advance of advances) {
      await client.query(INSERT_SQL, [
        runId,
        phase,
        predecessorManifestSha256 === null ? null : Buffer.from(predecessorManifestSha256, "hex"),
        advance.workspaceId,
        advance.fromSeq,
        advance.maxSeq,
        advance.rowHash,
        Buffer.from(written.dataSha256, "hex"),
        Buffer.from(written.manifestSha256, "hex"),
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

/**
 * Records that a run is ABOUT to make its objects durable, with the hashes it will write. It lands before the upload so that a run whose objects
 * were written and whose `recordRun` then failed is still known to the next run (see `readExportLinkage`). A failure here aborts the run before
 * anything is written.
 */
export function recordIntent(
  client: ClientBase,
  runId: string,
  predecessorManifestSha256: string | null,
  advances: readonly WatermarkAdvance[],
  planned: { readonly dataSha256: string; readonly manifestSha256: string },
): Promise<void> {
  return insertRows(client, runId, "intent", predecessorManifestSha256, advances, planned);
}

/**
 * Records one finished run: one row per chain exported, all in one transaction so the run lands whole or not at all (a half-recorded run would
 * move some chains' watermarks and not others while the manifest chain says the run happened).
 */
export function recordRun(
  client: ClientBase,
  runId: string,
  predecessorManifestSha256: string | null,
  advances: readonly WatermarkAdvance[],
  written: { readonly dataSha256: string; readonly manifestSha256: string },
): Promise<void> {
  return insertRows(client, runId, "recorded", predecessorManifestSha256, advances, written);
}

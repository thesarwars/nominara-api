import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import type { AuditChainRow } from "../../lib/crypto/audit-chain.js";
import { LocalDirExportSink } from "../../modules/audit/adapters/local-dir-export-sink.js";
import { CHAIN_CHUNK_ROWS, iterateWorkspaceChain, listAuditedWorkspaceIds } from "../../modules/audit/audit-log-reader.js";
import {
  chainRowStillMatches,
  readLatestManifestSha256,
  readWatermarks,
  recordRun,
  type ExportWatermark,
  type WatermarkAdvance,
} from "../../modules/audit/audit-export-watermarks.js";
import { readChainHead } from "../../modules/audit/audit-chain-marks.js";
import type { AuditExportWritten, AuditExportSink, ExportChainRange } from "../../modules/audit/ports/export-sink.js";

// STORY-020 — security-and-tenancy.md §12: "Nightly export to S3 with
// Object Lock in COMPLIANCE mode, 7-year retention." Cross-tenant discovery
// (listAuditedWorkspaceIds has no workspace filter) needs the same
// privileged connection contract as retention.ts's own cross-tenant
// discovery functions — see that file's PRIVILEGE CONTRACT comment.

export const AUDIT_EXPORT_RETENTION_DAYS = 2557; // 7 years

export interface RunAuditExportOptions {
  readonly retentionDays?: number;
  /** Rows per read. Defaults to the chain walk's own chunk size; a test seam, exactly as it is for the verifier. */
  readonly chunkRows?: number;
  /**
   * Batch 19 - export only what the last run did not. Per chain: the rows after its watermark (every row when it has none, which is the first
   * run, and when its watermark row was rewritten by an erasure); the manifest links to the previous run's manifest; the watermarks move only
   * once the sink reports both objects written. Off by default so an ad hoc full export stays possible and records nothing; the nightly
   * `audit.export` job turns it on.
   */
  readonly incremental?: boolean;
}

/**
 * STORY-144 AC7 — the whole estate, streamed. It used to push every workspace's chain into one array before the sink
 * saw a row, so heap grew with the estate rather than with a chunk: the verifier's problem with the whole estate as the
 * multiplier.
 *
 * ⚠ ONE REPEATABLE READ SNAPSHOT PER WORKSPACE CHAIN, not one for the run. Each exported chain is internally consistent
 * and verifiable (a row or an erasure committing mid-export cannot leave a chain half old and half new), while xmin is
 * held for one workspace's read at a time instead of the whole run. The cost is that two chains in one export may be
 * from slightly different moments, which is true of a nightly export anyway: they are different chains.
 *
 * The snapshot is opened when the sink first pulls a workspace's first row and closed as soon as its last row has been
 * yielded, or when the sink stops pulling. A sink that throws takes the generator's `return()` with it, so the
 * transaction is never left open on the privileged connection.
 */
export function runAuditExport(
  privilegedClient: ClientBase,
  sink: AuditExportSink,
  options: RunAuditExportOptions & { readonly incremental: true },
): Promise<string | null>;
export function runAuditExport(privilegedClient: ClientBase, sink: AuditExportSink, options?: RunAuditExportOptions): Promise<string>;
export async function runAuditExport(
  privilegedClient: ClientBase,
  sink: AuditExportSink,
  options: RunAuditExportOptions = {},
): Promise<string | null> {
  const chunkRows = options.chunkRows ?? CHAIN_CHUNK_ROWS;
  if (!Number.isInteger(chunkRows) || chunkRows < 1) {
    throw new RangeError(`audit export chunk size must be a positive integer, got ${String(chunkRows)}`);
  }
  const workspaceIds = await listAuditedWorkspaceIds(privilegedClient);
  const exportOptions = { retentionDays: options.retentionDays ?? AUDIT_EXPORT_RETENTION_DAYS };
  if (options.incremental !== true) {
    const rows = streamEstate(privilegedClient, workspaceIds, chunkRows, null);
    try {
      return await sink.export(rows, exportOptions);
    } finally {
      // A sink that stops pulling without finishing the stream or calling return() must not leave the privileged
      // connection idle in a REPEATABLE READ transaction, pinning xmin. A no-op once the stream has completed.
      await rows.return(undefined);
    }
  }

  const watermarks = await readWatermarks(privilegedClient);
  const pending = await chainsWithNewRows(privilegedClient, workspaceIds, watermarks);
  // NO NEW ROWS -> NO OBJECT. An empty manifest every night would add an object (and seven years of retention) per night for no evidence, and it
  // would put a link in the manifest chain that proves nothing; a skipped night leaves the chain exactly as long as the exports that happened.
  if (pending.length === 0) return null;

  const previousManifestSha256 = await readLatestManifestSha256(privilegedClient);
  const chains = new Map<string, ExportChainRange>();
  let written: AuditExportWritten | null = null;
  const rows = streamEstate(privilegedClient, pending, chunkRows, { watermarks, chains });
  let location: string;
  try {
    location = await sink.export(rows, exportOptions, {
      previousManifestSha256,
      chains,
      recordWritten: (w) => {
        written = w;
      },
    });
  } finally {
    // A sink that stops pulling without finishing the stream or calling return() must not leave the privileged
    // connection idle in a REPEATABLE READ transaction, pinning xmin. A no-op once the stream has completed.
    await rows.return(undefined);
  }
  // FAIL CLOSED on a sink that wrote an object but never said so: moving no watermark means the rows go out again tomorrow, a duplicate. Moving
  // one on trust would be a gap in seven-year evidence.
  const reported = written as AuditExportWritten | null;
  if (reported === null) throw new Error("audit export: the sink did not report the objects it wrote, so no watermark was recorded");
  const advances: WatermarkAdvance[] = [...chains].map(([workspaceId, range]) => ({
    workspaceId,
    fromSeq: range.fromSeq,
    maxSeq: range.toSeq,
    rowHash: Buffer.from(range.toRowHash, "hex"),
  }));
  await recordRun(privilegedClient, advances, reported);
  return location;
}

/** The chains whose head is not already the watermark. A chain with no watermark is always pending. */
async function chainsWithNewRows(client: ClientBase, workspaceIds: readonly string[], watermarks: ReadonlyMap<string, ExportWatermark>): Promise<string[]> {
  const pending: string[] = [];
  for (const workspaceId of workspaceIds) {
    const watermark = watermarks.get(workspaceId);
    if (watermark !== undefined) {
      const head = await readChainHead(client, workspaceId);
      // Same head, same hash: nothing since. ANY other state (a longer chain, a shorter one, a different hash at the same seq) is not "nothing
      // new" and goes to the snapshot, which decides between an increment and a rebase.
      if (head !== null && head.seq === watermark.seq && head.rowHash.equals(watermark.rowHash)) continue;
    }
    pending.push(workspaceId);
  }
  return pending;
}

interface IncrementalPlan {
  readonly watermarks: ReadonlyMap<string, ExportWatermark>;
  readonly chains: Map<string, ExportChainRange>;
}

async function* streamEstate(
  client: ClientBase,
  workspaceIds: readonly string[],
  chunkRows: number,
  plan: IncrementalPlan | null,
): AsyncGenerator<AuditChainRow> {
  for (const workspaceId of workspaceIds) {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    let completed = false;
    try {
      // Decided INSIDE the snapshot, so the row it checks and the rows it then reads are the same moment of the chain.
      const watermark = plan?.watermarks.get(workspaceId);
      let startAfter: string | null = null;
      let rebased = false;
      if (watermark !== undefined) {
        if (await chainRowStillMatches(client, workspaceId, watermark.seq, watermark.rowHash)) startAfter = watermark.seq;
        else rebased = true;
      }
      for await (const chunk of iterateWorkspaceChain(client, workspaceId, chunkRows, startAfter)) {
        if (plan !== undefined && plan !== null) {
          const last = chunk[chunk.length - 1]!;
          const previous = plan.chains.get(workspaceId);
          plan.chains.set(workspaceId, {
            fromSeq: previous?.fromSeq ?? startAfter ?? "0",
            afterRowHash: previous === undefined ? (startAfter !== null ? watermark!.rowHash.toString("hex") : null) : previous.afterRowHash,
            toSeq: last.seq,
            toRowHash: last.row_hash.toString("hex"),
            rowCount: (previous?.rowCount ?? 0) + chunk.length,
            rebased,
          });
        }
        yield* chunk;
      }
      completed = true;
    } finally {
      // Read-only, so COMMIT and ROLLBACK are equivalent; ROLLBACK on the abandoned path so a failed transaction
      // cannot make this throw over the error that got us here.
      await client.query(completed ? "COMMIT" : "ROLLBACK").catch((error: unknown) => {
        if (completed) throw error;
      });
    }
  }
}

async function main(): Promise<void> {
  // STORY-020-E-3: no S3 client exists in this repo yet. AUDIT_EXPORT_DIR
  // gates a local-filesystem approximation (see LocalDirExportSink's own
  // header comment) — unset means fail closed, not a silent no-op, matching
  // retention.ts's own deleteObjectPrefix/exportComplianceRecords precedent.
  const exportDir = process.env.AUDIT_EXPORT_DIR;
  if (!exportDir) {
    throw new Error(
      "audit-export: AUDIT_EXPORT_DIR is not set — no object-storage client exists in this repo yet (disclosed gap, STORY-020-E-3)",
    );
  }
  const client = await connect(requireDatabaseUrl());
  try {
    const sink = new LocalDirExportSink(exportDir);
    const location = await runAuditExport(client, sink);
    console.log(JSON.stringify({ location }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

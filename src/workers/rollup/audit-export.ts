import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import type { AuditChainRow } from "../../lib/crypto/audit-chain.js";
import { LocalDirExportSink } from "../../modules/audit/adapters/local-dir-export-sink.js";
import { CHAIN_CHUNK_ROWS, iterateWorkspaceChain, listAuditedWorkspaceIds } from "../../modules/audit/audit-log-reader.js";
import type { AuditExportSink } from "../../modules/audit/ports/export-sink.js";

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
export async function runAuditExport(
  privilegedClient: ClientBase,
  sink: AuditExportSink,
  options: RunAuditExportOptions = {},
): Promise<string> {
  const chunkRows = options.chunkRows ?? CHAIN_CHUNK_ROWS;
  if (!Number.isInteger(chunkRows) || chunkRows < 1) {
    throw new RangeError(`audit export chunk size must be a positive integer, got ${String(chunkRows)}`);
  }
  const workspaceIds = await listAuditedWorkspaceIds(privilegedClient);
  return sink.export(streamEstate(privilegedClient, workspaceIds, chunkRows), {
    retentionDays: options.retentionDays ?? AUDIT_EXPORT_RETENTION_DAYS,
  });
}

async function* streamEstate(client: ClientBase, workspaceIds: readonly string[], chunkRows: number): AsyncGenerator<AuditChainRow> {
  for (const workspaceId of workspaceIds) {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    let completed = false;
    try {
      for await (const chunk of iterateWorkspaceChain(client, workspaceId, chunkRows)) {
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

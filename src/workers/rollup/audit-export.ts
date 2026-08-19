import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import { LocalDirExportSink } from "../../modules/audit/adapters/local-dir-export-sink.js";
import { listAuditedWorkspaceIds, readWorkspaceChain } from "../../modules/audit/audit-log-reader.js";
import type { AuditExportSink } from "../../modules/audit/ports/export-sink.js";

// STORY-020 — security-and-tenancy.md §12: "Nightly export to S3 with
// Object Lock in COMPLIANCE mode, 7-year retention." Cross-tenant discovery
// (listAuditedWorkspaceIds has no workspace filter) needs the same
// privileged connection contract as retention.ts's own cross-tenant
// discovery functions — see that file's PRIVILEGE CONTRACT comment.

export const AUDIT_EXPORT_RETENTION_DAYS = 2557; // 7 years

export interface RunAuditExportOptions {
  readonly retentionDays?: number;
}

export async function runAuditExport(
  privilegedClient: ClientBase,
  sink: AuditExportSink,
  options: RunAuditExportOptions = {},
): Promise<string> {
  const workspaceIds = await listAuditedWorkspaceIds(privilegedClient);
  const rows = [];
  for (const workspaceId of workspaceIds) {
    rows.push(...(await readWorkspaceChain(privilegedClient, workspaceId)));
  }
  return sink.export(rows, { retentionDays: options.retentionDays ?? AUDIT_EXPORT_RETENTION_DAYS });
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

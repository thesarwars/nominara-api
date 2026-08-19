import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditChainRow } from "../../../lib/crypto/audit-chain.js";
import type { AuditExportOptions, AuditExportSink } from "../ports/export-sink.js";

// STORY-020 D-1 — local-filesystem approximation of S3 Object Lock
// (COMPLIANCE mode). Disclosed as STORY-020-E-3: chmod 0o444 only prevents
// accidental overwrite by the same user, it does NOT prevent deletion by
// anyone with write access to the containing directory — unlike real S3
// Object Lock. This adapter exists purely so the export path is exercised
// end-to-end before the real S3 wiring lands.

const READ_ONLY_MODE = 0o444;

function toExportLine(row: AuditChainRow): string {
  return JSON.stringify({
    ...row,
    prev_hash: row.prev_hash.toString("hex"),
    row_hash: row.row_hash.toString("hex"),
  });
}

export class LocalDirExportSink implements AuditExportSink {
  constructor(private readonly baseDir: string) {}

  async export(rows: readonly AuditChainRow[], options: AuditExportOptions): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dataPath = join(this.baseDir, `audit-export-${stamp}.jsonl`);
    const manifestPath = dataPath.replace(/\.jsonl$/, ".manifest.json");

    const body = rows.length === 0 ? "" : `${rows.map(toExportLine).join("\n")}\n`;
    await writeFile(dataPath, body, "utf8");

    const workspaceIds = [...new Set(rows.map((row) => row.workspace_id))];
    const lockedUntil = new Date(Date.now() + options.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const manifest = {
      rowCount: rows.length,
      workspaceIds,
      retentionDays: options.retentionDays,
      lockedUntil,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await chmod(dataPath, READ_ONLY_MODE);
    await chmod(manifestPath, READ_ONLY_MODE);

    return dataPath;
  }
}

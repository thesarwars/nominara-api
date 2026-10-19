import { chmod, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditChainRow } from "../../../lib/crypto/audit-chain.js";
import type { AuditExportOptions, AuditExportRows, AuditExportSink } from "../ports/export-sink.js";

// STORY-020 D-1 — local-filesystem approximation of S3 Object Lock
// (COMPLIANCE mode). Disclosed as STORY-020-E-3: chmod 0o444 only prevents
// accidental overwrite by the same user, it does NOT prevent deletion by
// anyone with write access to the containing directory — unlike real S3
// Object Lock. This adapter exists purely so the export path is exercised
// end-to-end before the real S3 wiring lands.

const READ_ONLY_MODE = 0o444;

/** Lines per write. Bounds the sink's own memory; the value is a throughput choice, not a limit anything depends on. */
const WRITE_BATCH_ROWS = 500;

function toExportLine(row: AuditChainRow): string {
  return JSON.stringify({
    ...row,
    prev_hash: row.prev_hash.toString("hex"),
    row_hash: row.row_hash.toString("hex"),
  });
}

export class LocalDirExportSink implements AuditExportSink {
  constructor(private readonly baseDir: string) {}

  async export(rows: AuditExportRows, options: AuditExportOptions): Promise<string> {
    await mkdir(this.baseDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dataPath = join(this.baseDir, `audit-export-${stamp}.jsonl`);
    const manifestPath = dataPath.replace(/\.jsonl$/, ".manifest.json");

    // STORY-144 AC7 — written as it arrives, in batches, with the manifest accumulated alongside. Nothing here holds
    // more than one batch of lines, whatever the estate's size.
    let rowCount = 0;
    const workspaceIds = new Set<string>();
    const handle = await open(dataPath, "w");
    try {
      let batch: string[] = [];
      for await (const row of rows) {
        batch.push(toExportLine(row));
        rowCount += 1;
        workspaceIds.add(row.workspace_id);
        if (batch.length >= WRITE_BATCH_ROWS) {
          await handle.write(`${batch.join("\n")}\n`);
          batch = [];
        }
      }
      if (batch.length > 0) await handle.write(`${batch.join("\n")}\n`);
    } catch (error) {
      // A half-written file, once made read-only and named like an export, would be taken for a complete one.
      await handle.close().catch(() => undefined);
      await unlink(dataPath).catch(() => undefined);
      throw error;
    }
    await handle.close();

    const lockedUntil = new Date(Date.now() + options.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const manifest = {
      rowCount,
      workspaceIds: [...workspaceIds],
      retentionDays: options.retentionDays,
      lockedUntil,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    await chmod(dataPath, READ_ONLY_MODE);
    await chmod(manifestPath, READ_ONLY_MODE);

    return dataPath;
  }
}

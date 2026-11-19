import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditChainRow } from "../../../lib/crypto/audit-chain.js";
import { incrementalManifestBlock, type AuditExportIncrement, type AuditExportOptions, type AuditExportRows, type AuditExportSink } from "../ports/export-sink.js";

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

  export(rows: AuditExportRows, options: AuditExportOptions): Promise<string>;
  export(rows: AuditExportRows, options: AuditExportOptions, increment: AuditExportIncrement): Promise<string | null>;
  async export(rows: AuditExportRows, options: AuditExportOptions, increment?: AuditExportIncrement): Promise<string | null> {
    await mkdir(this.baseDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dataPath = join(this.baseDir, `audit-export-${stamp}.jsonl`);
    const manifestPath = dataPath.replace(/\.jsonl$/, ".manifest.json");

    // STORY-144 AC7 — written as it arrives, in batches, with the manifest accumulated alongside. Nothing here holds
    // more than one batch of lines, whatever the estate's size.
    let rowCount = 0;
    const dataHash = createHash("sha256");
    const workspaceIds = new Set<string>();
    // Spooled under a name that is not an export; it takes the export name only at commit, so a skipped or failed run leaves nothing named like one.
    const spoolPath = `${dataPath}.part`;
    const handle = await open(spoolPath, "w");
    try {
      let batch: string[] = [];
      for await (const row of rows) {
        batch.push(toExportLine(row));
        rowCount += 1;
        workspaceIds.add(row.workspace_id);
        if (batch.length >= WRITE_BATCH_ROWS) {
          const text = `${batch.join("\n")}\n`;
          dataHash.update(text);
          await handle.write(text);
          batch = [];
        }
      }
      if (batch.length > 0) {
        const text = `${batch.join("\n")}\n`;
        dataHash.update(text);
        await handle.write(text);
      }
    } catch (error) {
      // A half-written file, once made read-only and named like an export, would be taken for a complete one.
      await handle.close().catch(() => undefined);
      await unlink(spoolPath).catch(() => undefined);
      throw error;
    }
    await handle.close();

    const lockedUntil = new Date(Date.now() + options.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const manifest = {
      rowCount,
      workspaceIds: [...workspaceIds],
      retentionDays: options.retentionDays,
      lockedUntil,
      ...(increment !== undefined ? { incremental: incrementalManifestBlock(increment) } : {}),
    };
    const manifestText = JSON.stringify(manifest, null, 2);
    const planned = { dataSha256: dataHash.digest("hex"), manifestSha256: createHash("sha256").update(manifestText).digest("hex") };

    // Nothing is durable until the caller has recorded its intent; `false` means there is nothing to export.
    if (increment !== undefined && !(await increment.beforeCommit(planned))) {
      await unlink(spoolPath).catch(() => undefined);
      return null;
    }
    await rename(spoolPath, dataPath);
    await writeFile(manifestPath, manifestText, "utf8");

    await chmod(dataPath, READ_ONLY_MODE);
    await chmod(manifestPath, READ_ONLY_MODE);

    increment?.recordWritten(planned);

    return dataPath;
  }
}

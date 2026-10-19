import type { AuditChainRow } from "../../../lib/crypto/audit-chain.js";

// STORY-020 D-1 — port for the nightly export. Real target is S3 with
// Object Lock in COMPLIANCE mode (security-and-tenancy.md §12); no AWS
// client exists in this repo yet, so production wiring is a disclosed gap
// (STORY-020-E-3). This interface is the seam a future story swaps the
// adapter behind, without touching the worker script that calls it.

export interface AuditExportOptions {
  readonly retentionDays: number;
}

/**
 * STORY-144 AC7 — the rows to export, as a stream. The export covers the whole estate, so a sink must consume this as
 * it arrives and never collect it: holding every chain at once is the heap problem the chunked walk was written to
 * remove. An array is still a valid `Iterable`.
 *
 * ⚠ THE SOURCE HOLDS A READ SNAPSHOT WHILE THE SINK CONSUMES THE STREAM. The production source is a REPEATABLE READ
 * transaction on the privileged Postgres connection, open from the first row of a workspace's chain until its last.
 * Two consequences for every implementer:
 *  - A sink that talks to a third party (the planned STORY-020 Object Lock S3 sink) must NOT upload while pulling rows:
 *    that would hold a Postgres transaction, and its xmin, open across a network await on a third party. Spool to a local
 *    temp file as rows arrive, and upload after the stream has ended.
 *  - A sink must either consume the stream to the end or call `return()` on its iterator when it stops early.
 *    runAuditExport also closes the stream when `export` settles, as a backstop, not as a licence.
 */
export type AuditExportRows = Iterable<AuditChainRow> | AsyncIterable<AuditChainRow>;

export interface AuditExportSink {
  /** Writes one immutable export batch. Returns an opaque, loggable location identifier (never row content). A stream that throws must leave no export behind. */
  export(rows: AuditExportRows, options: AuditExportOptions): Promise<string>;
}

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

/**
 * Batch 19 (STORY-020 follow-up) — what an INCREMENTAL export says about itself, so a chain of nightly objects can be verified end to end.
 *
 * Per workspace chain the increment covers the rows with `seq > fromSeq` up to and including `toSeq`. `afterRowHash` is the stored hash of the
 * row at `fromSeq` (the last row the previous object held), which is by construction the `prev_hash` of the first row in this object: the
 * rows link to the previous export through the hash chain itself. `previousManifestSha256` links the OBJECTS: it is the SHA-256 of the previous
 * run's manifest bytes (null on the first run), so an object that was removed or replaced shows as a break in the manifest chain.
 *
 * `rebased` marks a chain whose watermark row no longer exists with the same hash (an erasure rewrote the chain, STORY-020-E-9): that chain is
 * exported again from its start, and `fromSeq` is "0".
 */
export interface ExportChainRange {
  readonly fromSeq: string;
  readonly afterRowHash: string | null;
  readonly toSeq: string;
  readonly toRowHash: string;
  readonly rowCount: number;
  readonly rebased: boolean;
}

export interface AuditExportWritten {
  readonly dataSha256: string;
  readonly manifestSha256: string;
}

export interface AuditExportIncrement {
  readonly previousManifestSha256: string | null;
  /**
   * Keyed by workspace id. Filled AS THE STREAM IS PULLED: complete once the rows iterator has finished, which is when a sink builds its
   * manifest from it.
   */
  readonly chains: ReadonlyMap<string, ExportChainRange>;
  /** A sink MUST call this once both objects are durably written; the watermark moves only after it. An incremental export whose sink never calls it records nothing and is therefore re-exported (a duplicate, never a gap). */
  readonly recordWritten: (written: AuditExportWritten) => void;
}

export interface AuditExportSink {
  /**
   * Writes one immutable export batch. Returns an opaque, loggable location identifier (never row content). A stream that throws must leave no export behind.
   * `increment` is present only for an incremental export (batch 19): the sink puts it in the manifest and reports the object hashes back.
   */
  export(rows: AuditExportRows, options: AuditExportOptions, increment?: AuditExportIncrement): Promise<string>;
}

/** The manifest's `incremental` block: one shape for every sink, so a verifier reads the same fields whichever sink wrote the object. */
export function incrementalManifestBlock(increment: AuditExportIncrement): {
  readonly previousManifestSha256: string | null;
  readonly chains: ReadonlyArray<ExportChainRange & { readonly workspaceId: string }>;
} {
  return {
    previousManifestSha256: increment.previousManifestSha256,
    chains: [...increment.chains].map(([workspaceId, range]) => ({ workspaceId, ...range })),
  };
}

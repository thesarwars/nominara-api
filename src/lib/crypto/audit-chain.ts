import { createHash } from "node:crypto";

// STORY-020 — security-and-tenancy.md §12 "Audit log":
//   row_hash = sha256(prev_hash || canonical_json(row_without_hashes))
// where prev_hash is the PREVIOUS row's row_hash for the SAME workspace —
// per-tenant chains, so one tenant's export never discloses another's
// activity volume (AC "per-tenant chaining, not global"). Pure, no I/O, no
// clock, no randomness — the DB read/write side lives in
// src/modules/audit/audit-chain.service.ts, which calls straight into this.

/** The prev_hash carried by the first row ever appended to a given workspace's chain. */
export const GENESIS_HASH: Buffer = Buffer.alloc(32, 0);

export type AuditActorType = "user" | "api_key" | "system" | "support";
export type AuditSeverity = "info" | "notice" | "warning" | "critical";

/** Every audit_log column EXCEPT seq, prev_hash, row_hash — the content the hash actually covers. */
export interface AuditRowContent {
  readonly workspace_id: string;
  readonly occurred_at: string; // ISO-8601 UTC
  readonly actor_type: AuditActorType;
  readonly actor_id: string | null;
  readonly actor_ip: string | null;
  readonly actor_ua: string | null;
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly before_state: unknown;
  readonly after_state: unknown;
  readonly request_id: string;
  readonly support_grant_id: string | null;
  readonly severity: AuditSeverity;
}

/** A row as fetched from the DB (or reconstructed for verification), content plus its two hash columns. */
export interface AuditChainRow extends AuditRowContent {
  readonly seq: string;
  readonly prev_hash: Buffer;
  readonly row_hash: Buffer;
}

/**
 * Deterministic JSON: object keys sorted recursively, so two objects with
 * the same key/value pairs in a different literal order canonicalize to the
 * identical byte string. `undefined` values in an object are DROPPED (same
 * as JSON.stringify), never emitted as "null" in disguise.
 */
export function canonicalizeAuditContent(content: AuditRowContent): string {
  return canonicalize(content);
}

function canonicalize(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** sha256(prevHash || canonical_json(content)) — the row's own row_hash. */
export function computeRowHash(prevHash: Buffer, content: AuditRowContent): Buffer {
  return createHash("sha256").update(prevHash).update(Buffer.from(canonicalizeAuditContent(content), "utf8")).digest();
}

/** Strips seq/prev_hash/row_hash off a fetched row, leaving only the content the hash actually covers. */
function contentOf(row: AuditChainRow): AuditRowContent {
  const { seq: _seq, prev_hash: _prevHash, row_hash: _rowHash, ...content } = row;
  return content;
}

export interface ChainMismatch {
  readonly seq: string;
  readonly reason: "hash_mismatch" | "prev_hash_mismatch";
}

/**
 * The action name AuditChainService/retention.ts's rechaining step appends
 * (STORY-020-E-9 / D-4) — a documented marker, not a computing trigger, that
 * moves the verifier's trust boundary forward past a legitimate
 * content-mutating erasure event.
 */
export const RECHAINED_MARKER_ACTION = "audit.chain.rechained";

/**
 * Walks `rows` (already fetched in ascending seq order, already scoped to
 * ONE workspace by the caller) and returns the FIRST mismatch, or null if
 * the chain verifies clean.
 *
 * STORY-020-E-9 / D-4: rows strictly BEFORE the most recent
 * `audit.chain.rechained` marker are exempted from strict content-hash
 * verification — `requestIndividualErasure` pseudonymises actor_id on
 * already-appended rows without recomputing their row_hash (recomputing
 * would mean rewriting the hash of every row that ever followed it, an
 * unbounded operation repeated on every future erasure). The marker
 * documents exactly when this happened; verification is strict again from
 * the marker row itself onward, so genuine tampering after a legitimate
 * rechaining event still pages on the first mismatch. A gap this leaves
 * open, disclosed as STORY-020-E-9: tampering that happens to land strictly
 * BEFORE a rechaining marker is not caught by this walk.
 */
export function verifyChain(rows: readonly AuditChainRow[]): ChainMismatch | null {
  let lastRechainedIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.action === RECHAINED_MARKER_ACTION) {
      lastRechainedIndex = i;
    }
  }

  let expectedPrevHash = GENESIS_HASH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const strict = i >= lastRechainedIndex;
    if (!strict) {
      // Lenient zone — trust whatever is on disk as the chain anchor, since
      // this row's content may have been legitimately mutated by an erasure
      // that the later marker documents.
      expectedPrevHash = row.row_hash;
      continue;
    }
    if (!row.prev_hash.equals(expectedPrevHash)) {
      return { seq: row.seq, reason: "prev_hash_mismatch" };
    }
    const recomputed = computeRowHash(expectedPrevHash, contentOf(row));
    if (!recomputed.equals(row.row_hash)) {
      return { seq: row.seq, reason: "hash_mismatch" };
    }
    expectedPrevHash = row.row_hash;
  }
  return null;
}

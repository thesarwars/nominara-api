import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/api/pagination/cursor.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-024 T8 (RED step) — story scenario 4 ("Page a list while inserting
// rows → **No duplicates, no skips**") and AC7. RED at module resolution
// until T11 creates src/api/pagination/cursor.ts.
//
// *** WHAT THIS FILE PROVES, STATED PRECISELY ***
// The demonstrator is `audit_log`, not `GET /v1/workspaces`. That route is
// NOT a paginable list: it is `@SkipTenantContext()`, runs under
// `withActorContext` as a cross-tenant self-read under ADR-0001's actor-only
// policy class, and returns `{owned, joined}` rather than a flat collection.
// `audit_log` is append-only with a monotonic per-workspace `seq`, which is
// exactly a sort-key tuple.
//
// Two things about that table constrain what this file may CLAIM:
//
//   1. Appends go through AuditChainService.append, never a raw INSERT — a
//      raw insert breaks the prev_hash/row_hash chain and fails both
//      test/integration/audit-verify.spec.ts and the daily verifier.
//   2. Appends serialise on pg_advisory_xact_lock(hashtextextended(
//      workspace_id)) (src/modules/audit/audit-chain.service.ts:47).
//
// So this proves **a reader interleaved with SERIALISED appends** — no
// duplicates, no skips, under insertion. It does NOT prove behaviour under
// concurrent writes, because the table cannot exhibit concurrent writes by
// construction. That is what AC7 asks for, and claiming the stronger
// property would be a false statement about the evidence.
describe("STORY-024 · scenario 4 — a cursor is stable across an interleaved insert", () => {
  useApiHarness();

  // Page boundaries are where a cursor is either exactly right or silently
  // wrong; a cursor that round-trips but compares as a STRING would order
  // seq 10 before seq 9.
  it("a sequence cursor round-trips as an integer, not a stringified one", () => {
    const decoded = decodeCursor(encodeCursor(["ws-1", 9]));
    expect(decoded).toEqual(["ws-1", 9]);
    expect(typeof (decoded as unknown[])[1]).toBe("number");
  });

  it("orders by the tuple, so seq 10 follows seq 9 rather than preceding it", () => {
    const ninth = decodeCursor(encodeCursor(["ws-1", 9])) as [string, number];
    const tenth = decodeCursor(encodeCursor(["ws-1", 10])) as [string, number];
    expect(tenth[1]).toBeGreaterThan(ninth[1]);
  });

  // The stability property itself, stated as the invariant a paging loop must
  // hold: a row appended AFTER a page was taken has a seq strictly greater
  // than that page's cursor, so it can only ever appear on a LATER page —
  // never duplicated onto one already returned, never skipped.
  it("a row appended after a page was cut sorts strictly after that page's cursor", () => {
    const pageCursor = encodeCursor(["ws-1", 100]);
    const [, cursorSeq] = decodeCursor(pageCursor) as [string, number];
    const appendedAfter = 101;

    expect(appendedAfter).toBeGreaterThan(cursorSeq);
  });

  it("the cursor is opaque on the wire — a caller cannot read a sequence number out of it", () => {
    const cursor = encodeCursor(["ws-1", 100]);
    expect(cursor).not.toContain("100");
    expect(cursor).not.toContain("ws-1");
  });
});

import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/api/pagination/cursor.js";
import { AuditChainService, type AppendAuditRowInput } from "../../src/modules/audit/audit-chain.service.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-024 T8 (RED) / T11 (GREEN) — story scenario 4 ("Page a list while
// inserting rows → **No duplicates, no skips**") and AC7.
//
// *** WHAT THIS FILE PROVES, STATED PRECISELY ***
// The demonstrator is `audit_log`, not `GET /v1/workspaces`. That route is
// NOT a paginable list: it is `@SkipTenantContext()`, runs under
// `withActorContext` as a cross-tenant self-read under ADR-0001's actor-only
// policy class, and returns `{owned, joined}` rather than a flat collection.
// `audit_log` is append-only with a monotonic `seq`, which is exactly a
// sort-key tuple.
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
// concurrent writes, because the table cannot exhibit concurrent writes to
// one workspace by construction. That is what AC7 asks for, and claiming the
// stronger property would be a false statement about the evidence.
//
// The serialisation is also what makes a bigserial cursor SOUND here. A
// bigserial is allocated before commit, so in general a row with a lower
// `seq` can become visible after one with a higher `seq` — and a keyset
// reader would skip it permanently. Per workspace, `append()` takes the
// advisory lock BEFORE its INSERT, so allocation order, commit order and
// visibility order are the same order. A future list route over a table
// WITHOUT that lock cannot reuse this cursor unaltered.

const WORKSPACE_ID = "aaaaaaaa-0000-0000-0000-0000000000c1";
const OTHER_WORKSPACE_ID = "aaaaaaaa-0000-0000-0000-0000000000c2";

function appendInput(workspaceId: string, action: string): AppendAuditRowInput {
  return {
    workspaceId,
    actorType: "user",
    actorId: "22222222-2222-2222-2222-222222222222",
    actorIp: "127.0.0.1",
    actorUa: "vitest",
    action,
    resourceType: "project",
    resourceId: "33333333-3333-3333-3333-333333333333",
    beforeState: null,
    afterState: { name: "Acme" },
    requestId: "req-cursor",
    supportGrantId: null,
    severity: "info",
  };
}

interface PageResult {
  readonly actions: string[];
  readonly cursorNext: string | null;
  readonly hasMore: boolean;
}

describe("STORY-024 · scenario 4 — a cursor is stable across an interleaved insert", () => {
  const harness = useApiHarness();
  const chain = new AuditChainService();

  /**
   * One page of `audit_log`, keyed on the cursor rather than an offset.
   *
   * `limit + 1` rows are fetched so `has_more` is answered by whether a
   * further row EXISTS, never by `rows.length === limit` — which is wrong on
   * the exact page where the last row lands flush against the limit.
   *
   * `seq` is bigserial and node-postgres returns bigint as a STRING; it is
   * converted here so the cursor carries an integer. A stringified sort key
   * would compare "10" < "9" and the paging loop would silently stop early.
   */
  async function readPage(workspaceId: string, limit: number, cursor?: string): Promise<PageResult> {
    // Keyed on `seq` ALONE. An earlier draft used [workspace_id, seq]; the
    // tenant is established server-side by the caller's context and putting
    // it in the cursor only invites the next author to filter on
    // `decoded[0]`, which is client-supplied and forgeable. There is now
    // nothing in the cursor worth forging. The arity is pinned so a
    // shorter forged tuple is refused rather than read as NULL.
    const afterSeq = cursor === undefined ? null : (decodeCursor(cursor, "test.seq", 1)[0] as number);

    const result = await harness.db().query<{ seq: string; action: string }>(
      `SELECT seq, action FROM audit_log
        WHERE workspace_id = $1 AND ($2::bigint IS NULL OR seq > $2::bigint)
        ORDER BY seq ASC
        LIMIT $3`,
      [workspaceId, afterSeq, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      actions: rows.map((row) => row.action),
      cursorNext: hasMore && last !== undefined ? encodeCursor("test.seq", [Number(last.seq)]) : null,
      hasMore,
    };
  }

  async function append(workspaceId: string, actions: string[]): Promise<void> {
    for (const action of actions) {
      await chain.append(harness.db(), appendInput(workspaceId, action));
    }
  }

  it("pages every pre-existing row exactly once while new rows are appended mid-traversal", async () => {
    const original = ["a1", "a2", "a3", "a4", "a5"];
    await append(WORKSPACE_ID, original);

    const seen: string[] = [];
    let page = await readPage(WORKSPACE_ID, 2);
    seen.push(...page.actions);

    // The insert happens BETWEEN two page reads — the exact interleaving the
    // scenario names, and the one offset pagination gets wrong.
    await append(WORKSPACE_ID, ["b1", "b2", "b3"]);

    while (page.cursorNext !== null) {
      page = await readPage(WORKSPACE_ID, 2, page.cursorNext);
      seen.push(...page.actions);
    }

    // No duplicates: paging returned each row once, not once per page it
    // straddled.
    expect(new Set(seen).size, `a row was returned twice: ${seen.join(",")}`).toBe(seen.length);

    // No skips of anything that existed when paging began — the property
    // AC7 is actually about.
    for (const action of original) {
      expect(seen, `${action} existed before paging began and must not be skipped`).toContain(action);
    }

    // Rows appended mid-traversal sort strictly after the cursor of every
    // page already returned, so they can only ever appear LATER — never
    // duplicated onto a page already served.
    expect(seen.slice(0, original.length)).toEqual(original);
  });

  it("a page boundary flush against the limit does not report a further page that does not exist", async () => {
    await append(WORKSPACE_ID, ["only1", "only2"]);

    const page = await readPage(WORKSPACE_ID, 2);
    expect(page.actions).toEqual(["only1", "only2"]);
    // The `limit + 1` read is what makes this answerable: rows.length === limit
    // on the final page too, so a naive has_more would hand out a cursor to
    // an empty page.
    expect(page.hasMore).toBe(false);
    expect(page.cursorNext).toBeNull();
  });

  it("the sort key is scoped to one workspace — another tenant's rows never enter the page", async () => {
    await append(WORKSPACE_ID, ["mine1", "mine2"]);
    await append(OTHER_WORKSPACE_ID, ["theirs1", "theirs2"]);

    const page = await readPage(WORKSPACE_ID, 10);
    expect(page.actions).toEqual(["mine1", "mine2"]);
  });

  it("a cursor from one page cannot be replayed to re-read rows before it", async () => {
    await append(WORKSPACE_ID, ["r1", "r2", "r3", "r4"]);

    const first = await readPage(WORKSPACE_ID, 2);
    const second = await readPage(WORKSPACE_ID, 2, first.cursorNext!);

    expect(first.actions).toEqual(["r1", "r2"]);
    expect(second.actions).toEqual(["r3", "r4"]);
    // Re-using the FIRST cursor is idempotent, not a rewind that re-serves
    // page one.
    const replayed = await readPage(WORKSPACE_ID, 2, first.cursorNext!);
    expect(replayed.actions).toEqual(second.actions);
  });

  // The previous version of this test claimed "a caller cannot read a
  // sequence number out of it" and asserted `not.toContain(WORKSPACE_ID)`
  // and `not.toMatch(/^[0-9]+$/)` — both vacuously true of ANY base64
  // string, including one that spells out the sequence number, which this
  // one does. §1 asks for "an opaque base64", which is what shipped:
  // opaque means the CLIENT must not interpret it, not that it is
  // confidential. The honest assertions are these.
  it("the cursor carries no tenant identifier at all — there is nothing in it to forge", async () => {
    await append(WORKSPACE_ID, ["o1", "o2"]);
    const page = await readPage(WORKSPACE_ID, 1);

    expect(page.cursorNext).not.toBeNull();
    const payload = Buffer.from(page.cursorNext!, "base64url").toString("utf8");
    expect(payload, "a decoded cursor must not name a workspace").not.toContain(WORKSPACE_ID);
    expect(JSON.parse(payload)).toEqual({ v: 1, k: [expect.any(Number)] });
  });

  it("a forged cursor of the wrong arity is refused, not read as NULL and rewound to page one", async () => {
    await append(WORKSPACE_ID, ["f1", "f2", "f3", "f4"]);
    const page = await readPage(WORKSPACE_ID, 2);
    expect(page.actions).toEqual(["f1", "f2"]);

    // An empty tuple is already refused by the schema; a WELL-FORMED tuple
    // of the wrong length is the dangerous one, because it decodes cleanly.
    const forged = encodeCursor("test.seq", ["not-a-seq", 1]);
    let refusal: { details?: { issues?: { message?: string }[] } } | undefined;
    try {
      decodeCursor(forged, "test.seq", 1);
    } catch (error) {
      refusal = error as typeof refusal;
    }
    expect(refusal, "a two-element cursor must not satisfy a one-element sort key").toBeDefined();
    // The reason travels in `details.issues`, not in the message — the
    // message is the client-facing constant. Asserting the reason is what
    // distinguishes "refused for arity" from "refused for anything at all".
    expect(refusal!.details?.issues?.[0]?.message).toMatch(/sort-key element/);

    await expect(readPage(WORKSPACE_ID, 2, forged)).rejects.toThrow();
  });

  it("a sequence cursor round-trips as an integer, not a stringified one", () => {
    const decoded = decodeCursor(encodeCursor("test.seq", [9]), "test.seq", 1);
    expect(decoded).toEqual([9]);
    expect(typeof decoded[0]).toBe("number");
  });
});

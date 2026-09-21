import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { RECHAINED_MARKER_ACTION, verifyChain } from "../../src/lib/crypto/audit-chain.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { CHAIN_CHUNK_ROWS, chainChunkQueryText, readChainChunk } from "../../src/modules/audit/audit-log-reader.js";
import { verifyWorkspaceChain } from "../../src/workers/rollup/audit-verify.js";

// STORY-144 — the chain walk reads in keyset chunks instead of pulling a whole
// chain into memory.
//
// ⚠ WHAT THESE TESTS ARE ACTUALLY FOR. The risk in a chunked rewrite is not
// "does it verify a chain" — the STORY-020 and STORY-143 suites already hold
// that up, and they pass against this unchanged, which is the first and best
// parity signal. The risk is the BOUNDARY: losing `expectedPrevHash` between
// chunks gives a walk that finds a tamper when it lands mid-chunk and misses
// it when it lands on the seam. That failure is invisible to any test whose
// chain is shorter than one chunk, which at the production size of 2,000 rows
// is every test anyone would reasonably write.
//
// So the chunk size is a parameter, and the property asserted is that it makes
// NO difference to the verdict — checked at sizes that put a boundary at every
// position in a short chain.

describe("STORY-144 · the chunked chain walk", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  const service = new AuditChainService();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE audit_log, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  async function append(action: string, n: number): Promise<void> {
    await service.append(db, {
      workspaceId,
      actorType: "system",
      actorId: null,
      actorIp: null,
      actorUa: null,
      action,
      resourceType: "workspace",
      resourceId: workspaceId,
      beforeState: null,
      afterState: { n },
      requestId: randomUUID(),
      supportGrantId: null,
      severity: "info",
    });
  }

  async function chain(length: number): Promise<void> {
    for (let i = 0; i < length; i += 1) await append("workspace.updated", i);
  }

  /** Every row, the way the in-memory walk would have read them. */
  async function allRows() {
    const rows = [];
    let after: string | null = null;
    for (;;) {
      const chunk = await readChainChunk(db, workspaceId, after, 1_000);
      if (chunk.length === 0) break;
      rows.push(...chunk);
      after = chunk[chunk.length - 1]!.seq;
    }
    return rows;
  }

  async function tamperAt(offset: number): Promise<void> {
    await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await db.query(
      `UPDATE audit_log SET action = 'tampered'
        WHERE seq = (SELECT seq FROM audit_log WHERE workspace_id = $1 ORDER BY seq ASC OFFSET $2 LIMIT 1)`,
      [workspaceId, offset],
    );
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");
  }

  /** Deletes a row mid-chain, which BREAKS THE LINKAGE rather than the content. */
  async function deleteAt(offset: number): Promise<void> {
    await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await db.query(
      `DELETE FROM audit_log
        WHERE seq = (SELECT seq FROM audit_log WHERE workspace_id = $1 ORDER BY seq ASC OFFSET $2 LIMIT 1)`,
      [workspaceId, offset],
    );
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");
  }

  /**
   * ⚠ TAMPERS WITHOUT DESTROYING THE ROW'S MARKER-NESS. `tamperAt` sets
   * `action`, which on a rechaining marker removes the very thing that makes
   * it a marker — so both walks fall back to genesis and agree trivially, and
   * the boundary is never exercised at the ONE row where it can move.
   * `severity` is hashed content and is not `action`.
   */
  async function tamperSeverityAt(offset: number): Promise<void> {
    await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await db.query(
      `UPDATE audit_log SET severity = 'critical'
        WHERE seq = (SELECT seq FROM audit_log WHERE workspace_id = $1 ORDER BY seq ASC OFFSET $2 LIMIT 1)`,
      [workspaceId, offset],
    );
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");
  }

  /** A second tenant, whose rows interleave this one's `seq` values. */
  async function otherTenant(): Promise<string> {
    const other = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'Other',$2,'growth')", [
      other,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    return other;
  }

  async function appendAs(ws: string, action: string, n: number): Promise<void> {
    const mine = workspaceId;
    workspaceId = ws;
    await append(action, n);
    workspaceId = mine;
  }

  const SIZES = [1, 2, 3, 7, CHAIN_CHUNK_ROWS];

  it("⚠ agrees with the in-memory walk at EVERY chunk size, on an intact chain", async () => {
    await chain(8);
    const expected = verifyChain(await allRows());
    expect(expected).toBeNull();

    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `chunk size ${String(size)}`).toEqual(expected);
    }
  }, 60_000);

  it("⚠ finds a tamper at EVERY position, at EVERY chunk size — including on the seam", async () => {
    // The boundary bug this exists for: with chunk size 2 and a tamper at
    // index 2, the tampered row is the first of its chunk, so a walk that
    // resets `expectedPrevHash` per chunk sails past it.
    for (let position = 0; position < 6; position += 1) {
      await db.query("TRUNCATE audit_log CASCADE");
      await chain(6);
      await tamperAt(position);

      const expected = verifyChain(await allRows());
      expect(expected, `position ${String(position)} must be detectable at all`).not.toBeNull();

      for (const size of SIZES) {
        expect(
          await verifyWorkspaceChain(db, workspaceId, size),
          `tamper at ${String(position)}, chunk size ${String(size)}`,
        ).toEqual(expected);
      }
    }
  }, 120_000);

  it("⚠ catches a BROKEN LINK at every position and size — the failure a per-chunk reset hides", async () => {
    // ⚠ THE TAMPER TEST ABOVE DOES NOT COVER THIS, and a mutant proved it. An
    // edit to `action` breaks the CONTENT hash, and `computeRowHash` takes the
    // expected prev-hash as input — so a walk that wrongly reset
    // `expectedPrevHash` to each chunk's own first `prev_hash` still recomputes
    // the same value and still catches it. That mutation passed all seven
    // tests.
    //
    // A deleted middle row breaks the LINKAGE instead: the next row's stored
    // `prev_hash` points at the row that is gone, so only a walk carrying the
    // real anchor across the seam notices. Reset per chunk and it sails past —
    // which is precisely the bug chunking introduces, and it would have shipped.
    for (let position = 1; position < 5; position += 1) {
      await db.query("TRUNCATE audit_log CASCADE");
      await chain(6);
      await deleteAt(position);

      const expected = verifyChain(await allRows());
      expect(expected?.reason, `deletion at ${String(position)}`).toBe("prev_hash_mismatch");

      for (const size of SIZES) {
        expect(
          await verifyWorkspaceChain(db, workspaceId, size),
          `deletion at ${String(position)}, chunk size ${String(size)}`,
        ).toEqual(expected);
      }
    }
  }, 120_000);

  it("⚠ ANOTHER TENANT'S rechaining marker does not make this tenant's chain lenient", async () => {
    // ⚠ THE HOLE EVERY TEST IN THIS FILE SHARED: one workspace. Dropping the
    // tenant filter from `lastRechainSeq` passed all 22 audit tests, and it is
    // a CROSS-TENANT FALSE CLEAN — tenant A runs an ordinary GDPR erasure,
    // which appends a rechaining marker at some global `seq`, and every other
    // tenant's chain below that `seq` is classified lenient and never verified
    // again, while the nightly run reports no mismatch.
    const other = await otherTenant();
    await chain(4);
    await tamperAt(2);
    // The foreign marker lands ABOVE this tenant's rows, so an unscoped
    // `max(seq)` would pick it up and make everything here lenient.
    await appendAs(other, RECHAINED_MARKER_ACTION, 0);

    const expected = verifyChain(await allRows());
    expect(expected).not.toBeNull();
    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `size ${String(size)}`).toEqual(expected);
    }
  }, 60_000);

  it("⚠ another tenant's rows are never read as part of this chain, however interleaved", async () => {
    // `chainAnchorBefore` and `readChainChunk` are both `seq`-ordered over a
    // shared sequence. Losing either filter reads a foreign row as this
    // tenant's next link — a false alarm rather than a false clean, but a
    // nightly false alarm on this control is how it gets muted.
    const other = await otherTenant();
    await append("workspace.updated", 0);
    await appendAs(other, "workspace.updated", 0);
    await append("workspace.updated", 1);
    await appendAs(other, "workspace.updated", 1);
    await append("workspace.updated", 2);

    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `size ${String(size)}`).toBeNull();
    }

    // ⚠ AND THE ANCHOR SPECIFICALLY, which needs a marker to be reached at
    // all — the interleaving above never calls `chainAnchorBefore`, so
    // dropping ITS tenant filter survived. With a foreign row sitting
    // immediately below this tenant's marker, an unscoped anchor query
    // returns the OTHER tenant's `row_hash` and the marker's own `prev_hash`
    // then fails to match: a nightly false alarm, on the control whose
    // credibility is the whole point.
    await appendAs(other, "workspace.updated", 9);
    await append(RECHAINED_MARKER_ACTION, 0);
    await append("workspace.updated", 3);

    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `anchor, size ${String(size)}`).toBeNull();
    }
  }, 60_000);

  it("⚠ catches a tamper ON THE MARKER ROW ITSELF, where the boundary can move", async () => {
    // The marker row is the first STRICT row, so a boundary that slips one row
    // late leaves it unverified. Nothing caught that except a row-count
    // assertion — an efficiency check standing in for a correctness one, which
    // the first person to add a query would relax.
    //
    // The tamper must leave `action` alone or the row stops being a marker and
    // both walks trivially agree.
    await chain(3);
    await append(RECHAINED_MARKER_ACTION, 99);
    await chain(3);
    await tamperSeverityAt(3);

    const expected = verifyChain(await allRows());
    expect(expected).not.toBeNull();
    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `size ${String(size)}`).toEqual(expected);
    }
  }, 60_000);

  it("⚠ agrees on the odd marker shapes: two markers, marker last, only markers, empty", async () => {
    // `max(seq)` picks the LAST marker. With two, everything before the second
    // is lenient — including the first marker. None of this was covered, and a
    // `max → min` mutation survived the whole suite.
    await chain(2);
    await append(RECHAINED_MARKER_ACTION, 1);
    await chain(2);
    await append(RECHAINED_MARKER_ACTION, 2);
    await chain(2);
    await tamperSeverityAt(1); // before both markers — lenient
    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) expect(await verifyWorkspaceChain(db, workspaceId, size)).toBeNull();

    await tamperSeverityAt(3); // between the markers — still lenient
    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) expect(await verifyWorkspaceChain(db, workspaceId, size)).toBeNull();

    await tamperSeverityAt(6); // after the second marker — strict
    const strict = verifyChain(await allRows());
    expect(strict).not.toBeNull();
    for (const size of SIZES) expect(await verifyWorkspaceChain(db, workspaceId, size)).toEqual(strict);

    // Marker as the LAST row.
    await db.query("TRUNCATE audit_log CASCADE");
    await chain(3);
    await append(RECHAINED_MARKER_ACTION, 0);
    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) expect(await verifyWorkspaceChain(db, workspaceId, size)).toBeNull();

    // Nothing but markers.
    await db.query("TRUNCATE audit_log CASCADE");
    await append(RECHAINED_MARKER_ACTION, 0);
    await append(RECHAINED_MARKER_ACTION, 1);
    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) expect(await verifyWorkspaceChain(db, workspaceId, size)).toBeNull();

    // No rows at all.
    await db.query("TRUNCATE audit_log CASCADE");
    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) expect(await verifyWorkspaceChain(db, workspaceId, size)).toBeNull();
  }, 120_000);

  it("⚠ REFUSES a chunk size that cannot make progress", async () => {
    // `LIMIT 0` reads an empty chunk, and the loop reads an empty chunk as
    // "end of chain" — so a tampered chain comes back CLEAN.
    await chain(4);
    await tamperAt(1);

    await expect(verifyWorkspaceChain(db, workspaceId, 0)).rejects.toThrow(/positive integer/);
    await expect(verifyWorkspaceChain(db, workspaceId, -1)).rejects.toThrow(/positive integer/);
    await expect(verifyWorkspaceChain(db, workspaceId, 1.5)).rejects.toThrow(/positive integer/);
  }, 60_000);

  it("⚠ keeps the rechaining marker's lenient zone EXACTLY where the in-memory walk put it", async () => {
    // The chunked walk finds the strict zone's start with one aggregate and
    // seeds it from the row before the marker, instead of walking the lenient
    // rows to get the same anchor. Same boundary, or the two disagree about
    // what is trusted — and this one is load-bearing for erasure.
    await chain(3);
    await append(RECHAINED_MARKER_ACTION, 99);
    await chain(3);

    // A tamper BEFORE the marker is invisible to both (STORY-020-E-9).
    await tamperAt(1);
    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `pre-marker, size ${String(size)}`).toBeNull();
    }

    // A tamper AFTER it is caught by both, identically.
    await tamperAt(5);
    const expected = verifyChain(await allRows());
    expect(expected).not.toBeNull();
    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `post-marker, size ${String(size)}`).toEqual(expected);
    }
  }, 60_000);

  it("⚠ a marker as the FIRST row still anchors at genesis", async () => {
    // `verifyChain`'s `lastRechainedIndex === 0` case. The chunked walk asks
    // for the row before the marker, gets nothing, and must fall back to
    // GENESIS_HASH rather than to whatever null coerces into.
    await append(RECHAINED_MARKER_ACTION, 0);
    await chain(3);

    expect(verifyChain(await allRows())).toBeNull();
    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `size ${String(size)}`).toBeNull();
    }

    await tamperAt(2);
    const expected = verifyChain(await allRows());
    for (const size of SIZES) {
      expect(await verifyWorkspaceChain(db, workspaceId, size), `size ${String(size)}`).toEqual(expected);
    }
  }, 60_000);

  it("⚠ does NOT read the lenient zone, which is the point of the anchor query", async () => {
    // The saving that makes this worth doing on a long-lived workspace: every
    // pre-marker row exists in the old loop only to hand its row_hash to the
    // next iteration, and only the last one's survives. Counted by watching
    // how many rows the walk actually pulls back.
    await chain(20);
    await append(RECHAINED_MARKER_ACTION, 99);
    await chain(2);

    let rowsRead = 0;
    const counting = {
      query: (async (text: unknown, params: unknown) => {
        const result = await db.query(text as string, params as unknown[]);
        if (String(text).includes("ORDER BY audit_log.seq ASC")) rowsRead += result.rowCount ?? 0;
        return result;
      }) as Client["query"],
    } as unknown as Client;

    expect(await verifyWorkspaceChain(counting, workspaceId, CHAIN_CHUNK_ROWS)).toBeNull();

    // The marker plus the two rows after it — not the twenty before.
    expect(rowsRead).toBe(3);
  }, 60_000);

  it("⚠ walks a chain longer than one chunk, in more than one chunk", async () => {
    // Guards the loop itself: a bug that returned after the first chunk would
    // pass every test above, because at size 7 a 6-row chain is one chunk.
    await chain(10);

    let chunks = 0;
    const counting = {
      query: (async (text: unknown, params: unknown) => {
        if (String(text).includes("ORDER BY audit_log.seq ASC")) chunks += 1;
        return db.query(text as string, params as unknown[]);
      }) as Client["query"],
    } as unknown as Client;

    expect(await verifyWorkspaceChain(counting, workspaceId, 3)).toBeNull();
    // 10 rows at 3 per chunk: four chunks of rows, then one empty read to stop.
    expect(chunks).toBe(5);
  }, 60_000);

  it("⚠ the walk's OWN query plans on migration 0025's index, with the bound IN the index condition", async () => {
    // ⚠ THE FIRST VERSION EXPLAINED A DIFFERENT QUERY — `SELECT seq … seq > 0`
    // — which differs from production in the two ways that decide the plan: it
    // projects only `seq` (so it qualifies for an Index Only Scan that
    // production never gets) and it uses a literal bound instead of a
    // parameter. It failed correctly when the index was missing, and could not
    // see the degeneration that actually matters.
    //
    // What matters is that `seq >` lands in the INDEX CONDITION rather than in
    // a Filter. In a Filter the scan restarts at the workspace's first row on
    // every chunk and discards what it has already walked, which is the
    // quadratic shape keyset exists to avoid — and the earlier `($2 IS NULL OR
    // …)` predicate degenerated to exactly that under a generic plan.
    await chain(4);
    const plan = await db.query<{ "QUERY PLAN": string }>(
      `EXPLAIN ${chainChunkQueryText()}`,
      [workspaceId, "0", 10],
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");

    expect(text).toContain("ix_audit_ws_seq");
    const indexCond = text.split("\n").find((line) => line.includes("Index Cond")) ?? "";
    expect(indexCond).toContain("seq >");
    expect(text).not.toContain("Filter:");
    expect(text).not.toContain("Sort Key");
  }, 60_000);
});


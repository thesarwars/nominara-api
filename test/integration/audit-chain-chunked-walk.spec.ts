import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { RECHAINED_MARKER_ACTION, verifyChain } from "../../src/lib/crypto/audit-chain.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { CHAIN_CHUNK_ROWS, readChainChunk } from "../../src/modules/audit/audit-log-reader.js";
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

  it("⚠ the index migration 0025 is the one the walk plans on", async () => {
    // Without `(workspace_id, seq)` every chunk re-scans and re-sorts, which
    // would make the chunked walk slower than the walk it replaced.
    await chain(4);
    const plan = await db.query<{ "QUERY PLAN": string }>(
      `EXPLAIN SELECT seq FROM audit_log WHERE workspace_id = $1 AND seq > 0 ORDER BY seq ASC LIMIT 10`,
      [workspaceId],
    );
    const text = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain("ix_audit_ws_seq");
    expect(text).not.toContain("Sort Key");
  }, 60_000);
});

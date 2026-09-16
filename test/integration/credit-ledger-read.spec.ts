import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CreditLedgerQuery } from "../../contracts/billing/index.js";
import { creditLedgerEntrySchema } from "../../contracts/billing/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";
import { readLedgerPage } from "../../src/modules/billing/credit-ledger.reader.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-073 AC12 — the read endpoint. Filters, cursor paging, and the one
// property that matters more than any of them on a billing route: a
// workspace sees its own history and nobody else's.

describe("STORY-073 · reading the credit ledger", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  /**
   * ⚠ THE READS RUN AS `nominara_app`, NOT AS THE CONTAINER SUPERUSER.
   *
   * `readLedgerPage` carries no `workspace_id` predicate on purpose — RLS is
   * the control — and a superuser BYPASSES RLS, so the isolation test below
   * passed nothing and failed loudly the first time it was written: one
   * workspace saw two workspaces' rows. That is the same blindness the
   * second-engineer review found in the reconciler's discovery query, caught
   * here by writing the test as the role production actually uses.
   */
  let appClient: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let userId: string;
  let otherUserId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);

    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    appClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_app",
      resolvePassword("nominara_app", {}),
    );
  }, 300_000);

  afterAll(async () => {
    await appClient.end();
    await db.end();
    await container.stop();
  });

  async function workspace(): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      id,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    return id;
  }

  async function user(): Promise<string> {
    const row = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `a-${randomUUID().slice(0, 8)}@nominara.test`,
    ]);
    return row.rows[0]!.id;
  }

  interface Seed {
    readonly workspaceId?: string;
    readonly entryType?: string;
    readonly actionCode?: string | null;
    readonly credits?: number;
    readonly bucket?: string | null;
    readonly actorId?: string | null;
    readonly actorType?: string;
    readonly projectId?: string | null;
    readonly unitDetail?: Record<string, number> | null;
    readonly reason?: string | null;
    readonly occurredAt?: string;
  }

  let seq = 0;
  async function seed(entry: Seed = {}): Promise<void> {
    seq += 1;
    const type = entry.entryType ?? "commit";
    const movement = ["reserve", "commit", "release"].includes(type);
    await db.query(
      `INSERT INTO credit_ledger
         (workspace_id, entry_type, action_code, credits, bucket, included_after, purchased_after, reserved_after,
          actor_id, actor_type, project_id, reference_type, reference_id, unit_detail, reason,
          idempotency_key, occurred_at)
       VALUES ($1,$2,$3,$4,$5,100,0,0,$6,$7,$8,'run',$9,$10,$11,$12, COALESCE($13::timestamptz, now()))`,
      [
        entry.workspaceId ?? workspaceId,
        type,
        entry.actionCode === undefined ? (movement ? "manual_scan" : null) : entry.actionCode,
        entry.credits ?? 40,
        entry.bucket === undefined ? (movement ? null : "included") : entry.bucket,
        entry.actorId === undefined ? userId : entry.actorId,
        entry.actorType ?? "user",
        entry.projectId === undefined ? projectId : entry.projectId,
        randomUUID(),
        entry.unitDetail === undefined
          ? JSON.stringify({ prompts: 15, engines: 2, cells_charged: 22, cells_cached: 8 })
          : entry.unitDetail === null
            ? null
            : JSON.stringify(entry.unitDetail),
        entry.reason ?? null,
        `k-${String(seq)}`,
        entry.occurredAt ?? null,
      ],
    );
  }

  const query = (over: Partial<CreditLedgerQuery> = {}): CreditLedgerQuery => ({ limit: 50, ...over });

  async function read(over: Partial<CreditLedgerQuery> = {}, asWorkspace = workspaceId) {
    return withTenantContext(appClient, { workspaceId: asWorkspace, actorId: SYSTEM_ACTOR_ID }, (tx) =>
      readLedgerPage(tx, query(over)),
    );
  }

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, credit_wallets, workspaces, users CASCADE");
    workspaceId = await workspace();
    otherWorkspaceId = await workspace();
    userId = await user();
    otherUserId = await user();
    projectId = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, kind)
       VALUES ($1,$2,'P',$3,'https://example.com','example.com','brand')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  // ─────────────────────────── isolation ───────────────────────────

  it("⚠ shows a workspace its own history and nobody else's", async () => {
    // The property that matters most on a billing route, asserted first.
    // `readLedgerPage` carries NO `workspace_id` predicate on purpose — RLS
    // is the control — so this is the test that proves the control is real.
    await seed();
    await seed({ workspaceId: otherWorkspaceId, actorId: otherUserId, projectId: null });

    const mine = await read();
    const theirs = await read({}, otherWorkspaceId);

    expect(mine.items).toHaveLength(1);
    expect(theirs.items).toHaveLength(1);
    expect(mine.items[0]!.id).not.toBe(theirs.items[0]!.id);
  });

  it("returns rows that satisfy the published contract", async () => {
    await seed();
    const page = await read();
    expect(creditLedgerEntrySchema.safeParse(page.items[0]).success).toBe(true);
  });

  it("⚠ does NOT expose `seq`", async () => {
    // It is an internal ordering fact. Publishing it would let anyone count
    // a global sequence and infer our volume from two of their own rows.
    await seed();
    const page = await read();
    expect(Object.keys(page.items[0]!)).not.toContain("seq");
  });

  // ─────────────────────────── ordering ───────────────────────────

  it("⚠ orders by when things happened, not by the replay sequence", async () => {
    // Migration 0023 added `seq` because `occurred_at` misorders concurrent
    // movements — right for replay, wrong for a statement. A person reads
    // their history by time, and "the second one took the row lock first" is
    // not an explanation anyone wants in a billing screen.
    await seed({ occurredAt: "2026-09-10T10:00:00Z", credits: 10 });
    await seed({ occurredAt: "2026-09-12T10:00:00Z", credits: 30 });
    await seed({ occurredAt: "2026-09-11T10:00:00Z", credits: 20 });

    const page = await read();
    expect(page.items.map((entry) => entry.credits)).toEqual([30, 20, 10]);
  });

  it("⚠ pages across entries that differ only in MICROSECONDS without dropping one", async () => {
    // ⚠ THE SECOND ROW-SKIPPING BUG IN THIS CURSOR. `occurred_at` is
    // published at millisecond precision — that is what a person reads — and
    // the query orders on the full timestamptz. Keying the cursor on the
    // truncated value made the keyset predicate exclude every row sharing a
    // millisecond with the page boundary: four entries in one millisecond at
    // limit 2 returned three of them, `has_more` went false, and the missing
    // debit appeared on NO page.
    //
    // Two settlements landing in the same millisecond is ordinary. Every
    // earlier paging test here seeds whole seconds or one identical
    // timestamp for all rows, so none of them could see it.
    const base = "2026-09-12T10:00:00";
    for (const micros of ["000000", "000100", "000200", "000300"]) {
      await seed({ occurredAt: `${base}.${micros}Z`, credits: 10 + Number(micros) });
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const result = await read(cursor === undefined ? { limit: 2 } : { limit: 2, cursor });
      seen.push(...result.items.map((entry) => entry.id));
      if (result.pagination.cursor_next === null) break;
      cursor = result.pagination.cursor_next;
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it("still publishes occurred_at at millisecond precision, whatever the cursor keys on", async () => {
    // The cursor's extra precision is internal. A person reading a statement
    // does not want six decimal places, and the contract does not change.
    await seed({ occurredAt: "2026-09-12T10:00:00.000123Z" });
    const page = await read();
    expect(page.items[0]!.occurred_at).toBe("2026-09-12T10:00:00.000Z");
  });

  it("⚠ pages across a digit boundary without skipping a row", async () => {
    // ⚠ THE BUG THIS CAUGHT. `seq::text` aliases back onto `seq`, PostgreSQL
    // lets ORDER BY bind to that output alias, and WHERE cannot — so the
    // ordering compared TEXT while the keyset compared BIGINT. Text puts "9"
    // above "10", and the tenth entry vanished from the customer's history
    // between one page and the next.
    //
    // Eleven rows, so the sequence crosses 9 → 10 inside the paged range.
    const at = "2026-09-12T10:00:00Z";
    for (let i = 0; i < 11; i += 1) await seed({ occurredAt: at, credits: 10 + i });

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await read(cursor === undefined ? { limit: 3 } : { limit: 3, cursor });
      seen.push(...result.items.map((entry) => entry.id));
      if (result.pagination.cursor_next === null) break;
      cursor = result.pagination.cursor_next;
    }

    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
  });

  it("pages stably when several entries share a timestamp", async () => {
    // A reserve and its commit inside one transaction share `now()`, so this
    // is the ordinary case rather than a contrived one. Without `seq` as the
    // tiebreaker the page boundary repeats or skips a row.
    const at = "2026-09-12T10:00:00Z";
    for (let i = 0; i < 5; i += 1) await seed({ occurredAt: at, credits: 10 + i });

    const first = await read({ limit: 2 });
    const second = await read({ limit: 2, cursor: first.pagination.cursor_next! });
    const third = await read({ limit: 2, cursor: second.pagination.cursor_next! });

    const seen = [...first.items, ...second.items, ...third.items].map((entry) => entry.id);
    expect(new Set(seen).size).toBe(5);
    expect(third.pagination.has_more).toBe(false);
  });

  // ───────────────────── a cursor is untrusted input ─────────────────────

  describe("⚠ a forged cursor is refused, not honoured", () => {
    // ⚠ A CURSOR LEAVES THE SERVER, SITS IN A URL A PERSON CAN EDIT, AND
    // COMES BACK. `decodeCursor` pins the arity and not the element types,
    // and `cursorPayloadSchema` permits nulls and integers — so a two-element
    // cursor of the wrong shape used to decode cleanly and then either rewind
    // to page one forever, or reach Postgres and 500.
    const forge = (key: unknown[]): string =>
      Buffer.from(JSON.stringify({ v: 1, k: key }), "utf8").toString("base64url");

    for (const [name, key] of [
      ["nulls", [null, null]],
      ["a null timestamp", [null, "3"]],
      ["integers", [5, 3]],
      ["a non-timestamp string", ["not-a-timestamp", "3"]],
      ["a non-numeric seq", ["2026-09-12T10:00:00.000000Z", "abc"]],
      ["a millisecond timestamp this list no longer keys on", ["2026-09-12T10:00:00.000Z", "3"]],
    ] as const) {
      it(`refuses a cursor built from ${name}`, async () => {
        await seed({ credits: 10 });
        await seed({ credits: 20 });
        await expect(read({ limit: 1, cursor: forge([...key]) })).rejects.toThrow(/invalid pagination cursor/u);
      });
    }

    it("refuses a cursor of the wrong arity", async () => {
      await seed();
      await expect(read({ cursor: forge(["2026-09-12T10:00:00.000000Z"]) })).rejects.toThrow(
        /invalid pagination cursor/u,
      );
    });

    it("refuses something that is not a cursor at all", async () => {
      await seed();
      await expect(read({ cursor: "not-a-cursor" })).rejects.toThrow(/invalid pagination cursor/u);
    });
  });

  // ─────────────────────────── filters ───────────────────────────

  it("filters by action", async () => {
    await seed({ actionCode: "manual_scan" });
    await seed({ actionCode: "lookup" });

    const page = await read({ action: "lookup" });
    expect(page.items.map((entry) => entry.action_code)).toEqual(["lookup"]);
  });

  it("filters by project, and an entry with no project never matches one", async () => {
    await seed({ projectId });
    await seed({ entryType: "grant", projectId: null, actionCode: null });

    const page = await read({ project_id: projectId });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.project_id).toBe(projectId);
  });

  it("filters by actor", async () => {
    await seed({ actorId: userId });
    await seed({ actorId: otherUserId });

    const page = await read({ actor_id: userId });
    expect(page.items.map((entry) => entry.actor_id)).toEqual([userId]);
  });

  it("filters by entry type", async () => {
    await seed({ entryType: "commit" });
    await seed({ entryType: "reserve" });

    expect((await read({ entry_type: "reserve" })).items.map((e) => e.entry_type)).toEqual(["reserve"]);
  });

  it("⚠ includes the WHOLE of the `to` day, not up to its midnight", async () => {
    // `to = '2026-09-12'` means the 12th. A `<=` against a date compares a
    // timestamptz to midnight and silently drops the entire day the customer
    // asked for — a day of history missing from a statement, with no error.
    await seed({ occurredAt: "2026-09-12T00:00:00Z", credits: 10 });
    await seed({ occurredAt: "2026-09-12T23:59:59Z", credits: 20 });
    await seed({ occurredAt: "2026-09-13T00:00:01Z", credits: 30 });

    const page = await read({ from: "2026-09-12", to: "2026-09-12" });
    expect(page.items.map((entry) => entry.credits).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  it("includes the whole of the `from` day too", async () => {
    await seed({ occurredAt: "2026-09-12T00:00:00Z", credits: 10 });
    await seed({ occurredAt: "2026-09-11T23:59:59Z", credits: 20 });

    expect((await read({ from: "2026-09-12" })).items.map((e) => e.credits)).toEqual([10]);
  });

  it("combines filters rather than letting the last one win", async () => {
    await seed({ actionCode: "lookup", actorId: userId });
    await seed({ actionCode: "lookup", actorId: otherUserId });
    await seed({ actionCode: "manual_scan", actorId: userId });

    const page = await read({ action: "lookup", actor_id: userId });
    expect(page.items).toHaveLength(1);
  });

  it("⚠ a filter matching nothing returns nothing, not everything", async () => {
    // The failure a person auditing spend would never catch: an unfiltered
    // ledger reads exactly like a filter that found no narrowing to do.
    await seed({ actionCode: "manual_scan" });
    const page = await read({ action: "nlp_command" });
    expect(page.items).toEqual([]);
  });

  // ─────────────────────── what came back ───────────────────────

  it("returns the recorded unit detail as an object, not a string", async () => {
    await seed();
    const page = await read();
    expect(page.items[0]!.unit_detail).toEqual({ prompts: 15, engines: 2, cells_charged: 22, cells_cached: 8 });
  });

  it("returns an adjustment's reason and its signed amount", async () => {
    await seed({ entryType: "adjustment", credits: -40, bucket: "included", reason: "goodwill", actionCode: null });
    const page = await read();
    expect(page.items[0]).toMatchObject({ credits: -40, reason: "goodwill", entry_type: "adjustment" });
  });

  it("formats occurred_at as UTC regardless of the server's zone", async () => {
    // The same trap `cycle_end` hit in `wallet.ts`: a timestamp read through
    // a local Date shifts for anyone running east of Greenwich.
    await seed({ occurredAt: "2026-09-12T10:00:00Z" });
    const page = await read();
    expect(page.items[0]!.occurred_at).toBe("2026-09-12T10:00:00.000Z");
  });
});

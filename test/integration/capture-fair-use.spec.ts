import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import {
  FAIR_USE_METRIC,
  assertFairUseCapacity,
  commitDeepScanCharge,
  reserveFairUseCapacity,
  type RunTrigger,
} from "../../src/lib/capture/fair-use.js";

// STORY-032 AC10 and AC11.
//
// The reservation is the half worth driving against a real database with real
// concurrency: a read-then-write passes every single-threaded test and fails
// exactly when it matters, with two runs planning at once. That is the shape
// this file exists to catch.
const PERIOD = "2026-08-01";

describe("STORY-032 · the fair-use ceiling and the charge hook", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 240_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE usage_counters, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  async function setCeiling(limit: number, used = 0, reserved = 0): Promise<void> {
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value, reserved_value)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, FAIR_USE_METRIC, PERIOD, limit, used, reserved],
    );
  }

  async function counters(): Promise<{ used: number; reserved: number }> {
    const row = await db.query<{ used_value: string; reserved_value: string }>(
      "SELECT used_value, reserved_value FROM usage_counters WHERE workspace_id = $1 AND metric = $2",
      [workspaceId, FAIR_USE_METRIC],
    );
    return { used: Number(row.rows[0]!.used_value), reserved: Number(row.rows[0]!.reserved_value) };
  }

  it("reserves when there is room", async () => {
    await setCeiling(100);
    expect(await reserveFairUseCapacity(db, workspaceId, PERIOD, 30)).toBe(true);
    expect(await counters()).toEqual({ used: 0, reserved: 30 });
  }, 30_000);

  it("refuses when the request would cross the ceiling, and reserves NOTHING", async () => {
    await setCeiling(100, 90);
    expect(await reserveFairUseCapacity(db, workspaceId, PERIOD, 20)).toBe(false);
    expect(await counters(), "a refused reservation must leave the counter untouched").toEqual({
      used: 90,
      reserved: 0,
    });
  }, 30_000);

  it("counts already-reserved cells against the ceiling, not just used ones", async () => {
    await setCeiling(100, 50, 45);
    expect(
      await reserveFairUseCapacity(db, workspaceId, PERIOD, 10),
      "50 used + 45 reserved + 10 exceeds 100 — an in-flight run's cells are already spoken for",
    ).toBe(false);
  }, 30_000);

  it("admits a request that lands exactly on the ceiling", async () => {
    await setCeiling(100, 90);
    expect(await reserveFairUseCapacity(db, workspaceId, PERIOD, 10)).toBe(true);
    expect(await counters()).toEqual({ used: 90, reserved: 10 });
  }, 30_000);

  // THE TEST THAT JUSTIFIES THE SINGLE STATEMENT. A read-then-write passes
  // every test above and fails here: both runs read 90, both see room for 10,
  // both write, and the ceiling is exceeded by exactly the amount that made
  // it worth having.
  it("twenty runs planning CONCURRENTLY cannot take more than the last capacity", async () => {
    // TWENTY, not two. Two claimants exercise the predicate but barely
    // exercise the RACE: they can interleave in only a handful of ways, and
    // a read-then-write can pass a two-way test by luck often enough to look
    // green. Twenty contending for two slots makes the window this exists to
    // close wide enough to fall into. The story doc claimed twenty before
    // this test did; it now says what runs.
    await setCeiling(100, 90);
    const claimants = 20;
    const each = 5;
    const pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
    try {
      const outcomes = await Promise.all(
        Array.from({ length: claimants }, async () => {
          const c = await pool.connect();
          try {
            return await reserveFairUseCapacity(c, workspaceId, PERIOD, each);
          } finally {
            c.release();
          }
        }),
      );

      // 10 of capacity left, 5 per claimant: exactly two may win, whichever
      // two they are.
      expect(outcomes.filter(Boolean), "exactly two may win").toHaveLength(2);
      expect((await counters()).reserved, "and the ceiling must not be exceeded").toBe(10);
    } finally {
      await pool.end();
    }
  }, 30_000);

  // A run fully served from cache reserves nothing — and must not take the
  // row lock either, which would serialise planning across every project in
  // the workspace for no reason.
  it("reserving zero succeeds without touching the row", async () => {
    await setCeiling(100, 100);
    expect(await reserveFairUseCapacity(db, workspaceId, PERIOD, 0)).toBe(true);
    expect(await counters()).toEqual({ used: 100, reserved: 0 });
  }, 30_000);

  it("refuses when the workspace has no counter row for the cycle at all", async () => {
    expect(
      await reserveFairUseCapacity(db, workspaceId, PERIOD, 1),
      "no ceiling row means no capacity — fail closed, never unlimited",
    ).toBe(false);
  }, 30_000);

  it("the throwing form refuses with the tier-cap code", async () => {
    await setCeiling(10, 10);
    await expect(assertFairUseCapacity(db, workspaceId, PERIOD, 1)).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  }, 30_000);

  // §5's credit table, every row. Only `manual` is charged.
  it.each([
    ["scheduled", false],
    ["verification", false],
    ["drift_sample", false],
    ["conversion_backfill", false],
    ["manual", true],
  ] as const)("§5's table: a %s run is charged=%s", (trigger, chargeable) => {
    const result = commitDeepScanCharge({
      workspaceId,
      runId: randomUUID(),
      trigger: trigger as RunTrigger,
      cellsPlanned: 100,
      cellsCharged: 10,
      cellsCached: 90,
    });

    // Nothing is charged yet either way — the wallet is EPIC-10's — but the
    // two answers must be distinguishable, or filling the hook in later would
    // start charging the four triggers that must never be charged.
    expect(result.charged, "no wallet exists yet, so nothing is charged today").toBe(false);
    expect(
      /not charged/.test(result.reason),
      `a ${trigger} run must be refused by TRIGGER, not merely by the wallet's absence`,
    ).toBe(!chargeable);
  });
});

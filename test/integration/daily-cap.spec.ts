import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import {
  compensateDailyCounter,
  DAILY_COUNTER_RETAIN_DAYS,
  incrementDailyCounter,
  nextUtcMidnight,
  purgeDailyCounters,
} from "../../src/lib/usage/daily-cap.js";

// STORY-071's twelve scenarios, minus 7 (a mid-day upgrade is an entitlement
// change, exercised through the guard) — the counter itself is what these
// prove, against real Postgres, because every one of them is about a WHERE
// clause or a race.

describe("STORY-071 · the daily counter", () => {
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
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_daily_counters, credit_wallets, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'free')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  async function used(): Promise<number | null> {
    const rows = await db.query<{ used_count: string }>(
      "SELECT used_count::text FROM credit_daily_counters WHERE workspace_id = $1 AND action_code = 'lookup'",
      [workspaceId],
    );
    return rows.rows[0] === undefined ? null : Number(rows.rows[0].used_count);
  }

  it("scenario 1 — every action up to the cap is permitted", async () => {
    for (let i = 1; i <= 3; i += 1) {
      const outcome = await incrementDailyCounter(db, workspaceId, "lookup", 3);
      expect(outcome).not.toBeNull();
      expect(outcome!.used).toBe(i);
      expect(outcome!.remainingToday).toBe(3 - i);
    }
  });

  it("scenario 2 — one past the cap returns nothing, and changes nothing", async () => {
    for (let i = 0; i < 3; i += 1) await incrementDailyCounter(db, workspaceId, "lookup", 3);
    expect(await incrementDailyCounter(db, workspaceId, "lookup", 3)).toBeNull();
    // The refusal must not have incremented — a cap that counts its own
    // refusals would push the reset further away every time a client retried.
    expect(await used()).toBe(3);
  });

  it("scenario 3 — a full wallet does not loosen the cap", async () => {
    // AC3/AC4. A pack raises the MONTHLY ceiling only, and this is the control
    // that stops a farmer paying to accelerate. The counter has no join to
    // `credit_wallets` at all, so this asserts the absence of a path.
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
       VALUES ($1, 60, 100000, 0, now(), now() + interval '30 days')`,
      [workspaceId],
    );
    for (let i = 0; i < 3; i += 1) await incrementDailyCounter(db, workspaceId, "lookup", 3);

    expect(await incrementDailyCounter(db, workspaceId, "lookup", 3)).toBeNull();
    const wallet = await db.query<{ purchased_balance: string }>(
      "SELECT purchased_balance::text FROM credit_wallets WHERE workspace_id = $1",
      [workspaceId],
    );
    // AC7 — and it debited nothing on the way to refusing.
    expect(Number(wallet.rows[0]!.purchased_balance)).toBe(100_000);
  });

  it("scenario 4 — capture-backed tools share ONE counter", async () => {
    // Per-tool caps would let an account run its daily limit on each of three
    // tools. The action code is the family, not the route, so alternating
    // tools draws down the same row.
    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    expect(await incrementDailyCounter(db, workspaceId, "lookup", 3)).toBeNull();

    const rows = await db.query("SELECT 1 FROM credit_daily_counters WHERE workspace_id = $1", [workspaceId]);
    expect(rows.rowCount).toBe(1);
  });

  it("a DIFFERENT family keeps its own allowance", async () => {
    // `nlp_command` is a separate control with a separate limit — sharing one
    // counter across the two would make a command parse eat a tool run.
    for (let i = 0; i < 3; i += 1) await incrementDailyCounter(db, workspaceId, "lookup", 3);
    expect(await incrementDailyCounter(db, workspaceId, "nlp_command", 20)).not.toBeNull();
  });

  it("scenarios 5 and 6 — a compensated increment leaves the counter EXACTLY as it was", async () => {
    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    const before = await used();

    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    expect(await used()).toBe(before! + 1);

    await compensateDailyCounter(db, workspaceId, "lookup");
    expect(await used()).toBe(before);
  });

  it("a compensation cannot drive the counter negative", async () => {
    // Two compensations for one increment is a bug somewhere upstream; the
    // guard means it costs the customer nothing rather than corrupting a row
    // past its own CHECK.
    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    await compensateDailyCounter(db, workspaceId, "lookup");
    await compensateDailyCounter(db, workspaceId, "lookup");
    expect(await used()).toBe(0);
  });

  it("a compensation on a day with no row does nothing rather than failing", async () => {
    await compensateDailyCounter(db, workspaceId, "lookup");
    expect(await used()).toBeNull();
  });

  it("scenario 7 — a mid-day limit change takes effect on the next action", async () => {
    // The upsert re-writes `limit_count` from the entitlement on every
    // action. Without that the row would hold the limit the day STARTED on,
    // and an upgrade a customer just paid for would do nothing until
    // tomorrow.
    for (let i = 0; i < 3; i += 1) await incrementDailyCounter(db, workspaceId, "lookup", 3);
    expect(await incrementDailyCounter(db, workspaceId, "lookup", 3)).toBeNull();

    const afterUpgrade = await incrementDailyCounter(db, workspaceId, "lookup", 10);
    expect(afterUpgrade).not.toBeNull();
    expect(afterUpgrade!.limit).toBe(10);
    expect(afterUpgrade!.remainingToday).toBe(6);
  });

  it("a mid-day DOWNGRADE binds immediately rather than at midnight", async () => {
    for (let i = 0; i < 3; i += 1) await incrementDailyCounter(db, workspaceId, "lookup", 10);
    expect(await incrementDailyCounter(db, workspaceId, "lookup", 3)).toBeNull();
  });

  it("scenario 9 — yesterday's row does not bind today", async () => {
    await db.query(
      `INSERT INTO credit_daily_counters (workspace_id, utc_date, action_code, used_count, limit_count)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date - 1, 'lookup', 3, 3)`,
      [workspaceId],
    );
    const outcome = await incrementDailyCounter(db, workspaceId, "lookup", 3);
    expect(outcome).not.toBeNull();
    expect(outcome!.used).toBe(1);
  });

  it("scenario 10 — EXACTLY the cap succeeds under concurrent pressure", async () => {
    // The reason the limit test lives in the DO UPDATE's WHERE. A
    // read-then-write would let two requests both observe `used = limit - 1`
    // and both proceed, so the cap would bind at limit + 1 under exactly the
    // burst it exists to stop.
    const clients = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const client = new Client({ connectionString: container.getConnectionUri() });
        await client.connect();
        return client;
      }),
    );
    try {
      const outcomes = await Promise.all(
        clients.map((client) => incrementDailyCounter(client, workspaceId, "lookup", 3)),
      );
      expect(outcomes.filter((outcome) => outcome !== null)).toHaveLength(3);
      expect(await used()).toBe(3);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it("scenario 12 — rows past the retention window are purged, and today's is not", async () => {
    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    await db.query(
      `INSERT INTO credit_daily_counters (workspace_id, utc_date, action_code, used_count, limit_count)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date - $2::int, 'lookup', 3, 3)`,
      [workspaceId, DAILY_COUNTER_RETAIN_DAYS + 1],
    );

    expect(await purgeDailyCounters(db, DAILY_COUNTER_RETAIN_DAYS)).toBe(1);
    expect(await used()).toBe(1);
  });
});

describe("STORY-071 · the reset time", () => {
  it("is the next UTC midnight, whatever the workspace's zone", () => {
    // The counter's key is `utc_date`. A reset time in a local zone would
    // name an instant at which the row does not roll over, and the customer
    // would watch the clock pass it with nothing changing.
    expect(nextUtcMidnight(new Date("2026-08-04T11:02:31.000Z"))).toBe("2026-08-05T00:00:00.000Z");
  });

  it("rolls to the next day from one second before midnight", () => {
    expect(nextUtcMidnight(new Date("2026-08-04T23:59:59.000Z"))).toBe("2026-08-05T00:00:00.000Z");
  });

  it("crosses a month and a year boundary", () => {
    expect(nextUtcMidnight(new Date("2026-08-31T12:00:00.000Z"))).toBe("2026-09-01T00:00:00.000Z");
    expect(nextUtcMidnight(new Date("2026-12-31T12:00:00.000Z"))).toBe("2027-01-01T00:00:00.000Z");
  });
});

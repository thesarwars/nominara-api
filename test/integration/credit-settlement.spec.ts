import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { commitCredits, readWallet, releaseCredits, reserveCredits } from "../../src/lib/credits/wallet.js";
import { compensateDailyCounter, incrementDailyCounter } from "../../src/lib/usage/daily-cap.js";

// STORY-072 — the settlement seam, and STORY-071 AC6's other half.
//
// The interceptor's own wiring is unit-tested; what needs a database is the
// SEQUENCE: daily increment, wallet refusal, compensation — and that a
// released reservation leaves the wallet exactly as it started.

describe("STORY-072 · settlement", () => {
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
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
       VALUES ($1, 10, 0, 0, (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 30)`,
      [workspaceId],
    );
  });

  async function dailyUsed(): Promise<number> {
    const rows = await db.query<{ used_count: string }>(
      "SELECT used_count::text FROM credit_daily_counters WHERE workspace_id = $1 AND action_code = 'lookup'",
      [workspaceId],
    );
    return rows.rows[0] === undefined ? 0 : Number(rows.rows[0].used_count);
  }

  it("a released reservation leaves the wallet exactly as it started", async () => {
    const before = await readWallet(db, workspaceId);
    await reserveCredits(db, workspaceId, 6);
    await releaseCredits(db, workspaceId, 6);
    expect(await readWallet(db, workspaceId)).toEqual(before);
  });

  it("a committed reservation debits and clears, leaving nothing reserved", async () => {
    await reserveCredits(db, workspaceId, 6);
    await commitCredits(db, workspaceId, 6, 6);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 4, reserved: 0, available: 4 });
  });

  it("STORY-071 AC6 — a WALLET REFUSAL gives the daily allowance back", async () => {
    // "Otherwise a user with no credits burns their allowance discovering
    // they have none." The increment happens first, so it bounds attempts;
    // the compensation is what keeps a genuine empty-wallet case from being
    // punished for that ordering.
    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    expect(await dailyUsed()).toBe(1);

    const refused = await reserveCredits(db, workspaceId, 1000);
    expect(refused.ok).toBe(false);

    await compensateDailyCounter(db, workspaceId, "lookup");
    expect(await dailyUsed()).toBe(0);
  });

  it("a SUCCESSFUL action keeps the daily allowance spent", async () => {
    // The compensation must not fire on the happy path — an action that ran
    // is an action that counts against the day.
    await incrementDailyCounter(db, workspaceId, "lookup", 3);
    const reservation = await reserveCredits(db, workspaceId, 6);
    expect(reservation.ok).toBe(true);
    await commitCredits(db, workspaceId, 6, 6);

    expect(await dailyUsed()).toBe(1);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 4 });
  });

  it("a wallet refusal reserves nothing, so there is nothing left to settle", async () => {
    await reserveCredits(db, workspaceId, 1000);
    expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, includedBalance: 10 });
  });

  it("the daily cap refuses BEFORE the wallet is touched at all", async () => {
    // The guards run in that order, so a workspace at its daily cap never
    // reaches a reservation. The wallet is untouched and the counter does
    // not move either — the refusal does not count itself.
    for (let i = 0; i < 3; i += 1) await incrementDailyCounter(db, workspaceId, "lookup", 3);
    expect(await incrementDailyCounter(db, workspaceId, "lookup", 3)).toBeNull();

    expect(await dailyUsed()).toBe(3);
    expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, includedBalance: 10 });
  });
});

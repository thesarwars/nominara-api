import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { rollIncludedCycle } from "../../src/lib/credits/cycle-roll.js";
import { refreshMonthlyWallets } from "../../src/lib/credits/monthly-refresh.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { resolveBillingPeriod } from "../../src/lib/usage/billing-period.js";
import { createCreditHousekeepingHandler } from "../../src/lib/queue/handlers/credit-housekeeping.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import type { Job } from "bullmq";

// STORY-177 — included credits refresh EVERY MONTH for annual and free wallets, through the same `rollIncludedCycle`
// the webhook uses. Dangerous area: the credit ledger. Real Postgres, writes as nominara_app (FORCE RLS in play).
describe("STORY-177 · monthly included-credit refresh", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let discovery: Client;
  let pool: Pool;

  const GROWTH_GRANT = 500;
  const FREE_GRANT = 60;
  const at = (iso: string) => new Date(`${iso}T09:00:00Z`);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    discovery = new Client({ connectionString: container.getConnectionUri() });
    await discovery.connect();
    const appUri = new URL(container.getConnectionUri());
    appUri.username = "nominara_app";
    appUri.password = resolvePassword("nominara_app", {});
    pool = new Pool({ connectionString: appUri.toString(), max: 6 });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await discovery.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, credit_wallets, subscriptions, workspaces, users CASCADE");
    await db.query("UPDATE plans SET credits_per_cycle = $1 WHERE key = 'growth'", [GROWTH_GRANT]);
  });

  async function inCtx<T>(workspaceId: string, fn: (tx: Client) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => fn(tx as unknown as Client));
    } finally {
      client.release();
    }
  }

  /** A workspace with a wallet at `cycle`; `sub` is null for a free workspace with no Stripe row at all. */
  async function seed(opts: {
    plan: string;
    cycle: { start: string; end: string };
    grant: number;
    sub?: { interval: "monthly" | "annual"; status: string; start: string; end: string } | null;
  }): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key)
       VALUES ($1,$2,$3,'in_house','us-east-1','UTC',$4)`,
      [id, `ws-${id}`, `ws-${id}`, opts.plan],
    );
    if (opts.sub) {
      await db.query(
        `INSERT INTO subscriptions (id, workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
                                    status, current_period_start, current_period_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidV7(), id, opts.plan, opts.sub.interval, `cus_${id}`, `sub_${id}`, opts.sub.status, opts.sub.start, opts.sub.end],
      );
    }
    await inCtx(id, (tx) => provisionWalletWithGrant(tx, id, opts.grant, opts.cycle));
    return id;
  }

  const annualSub = (status = "active") => ({
    interval: "annual" as const, status, start: "2026-01-15T00:00:00Z", end: "2027-01-15T00:00:00Z",
  });
  const YEAR_CYCLE = { start: "2026-01-15", end: "2027-01-15" };

  const sweep = (now: Date) => refreshMonthlyWallets({ discovery, work: pool, now });

  async function wallet(id: string) {
    const r = await db.query<{ included_balance: number; cycle_start: string; cycle_end: string }>(
      "SELECT included_balance, cycle_start::text, cycle_end::text FROM credit_wallets WHERE workspace_id = $1", [id]);
    return r.rows[0]!;
  }
  async function rollEntries(id: string, key?: string) {
    const r = await db.query<{ entry_type: string; credits: number; idempotency_key: string }>(
      `SELECT entry_type, credits, idempotency_key FROM credit_ledger
        WHERE workspace_id = $1 AND idempotency_key LIKE 'cycle_roll:%' AND ($2::text IS NULL OR idempotency_key = $2)
        ORDER BY seq`, [id, key ?? null]);
    return r.rows;
  }

  it("[STORY-177 #1 AC1] an annual wallet rolls monthly: one month in, grant reset, expire entry, next monthly window", async () => {
    const id = await seed({ plan: "growth", cycle: YEAR_CYCLE, grant: GROWTH_GRANT, sub: annualSub() });
    await db.query("UPDATE credit_wallets SET included_balance = 120 WHERE workspace_id = $1", [id]);

    const outcome = await sweep(at("2026-02-20"));

    expect(outcome.workspacesRolled).toBe(1);
    expect(await wallet(id)).toMatchObject({ included_balance: GROWTH_GRANT, cycle_start: "2026-02-15", cycle_end: "2026-03-15" });
    const entries = await rollEntries(id, "cycle_roll:2026-02-15");
    expect(entries.map((e) => e.entry_type).sort()).toEqual(["expire", "grant"]);
  });

  it("[STORY-177 #1 AC1] it does not roll before the first anniversary day", async () => {
    const id = await seed({ plan: "growth", cycle: YEAR_CYCLE, grant: GROWTH_GRANT, sub: annualSub() });
    const outcome = await sweep(at("2026-02-14"));
    expect(outcome.workspacesRolled).toBe(0);
    expect((await wallet(id)).cycle_start).toBe("2026-01-15");
    expect(await rollEntries(id)).toEqual([]);
  });

  it("[STORY-177 #2 AC4] the Stripe annual renewal after eleven monthly rolls does not roll twice", async () => {
    const id = await seed({ plan: "growth", cycle: YEAR_CYCLE, grant: GROWTH_GRANT, sub: annualSub() });
    for (let month = 2; month <= 12; month += 1) {
      await sweep(at(`2026-${String(month).padStart(2, "0")}-16`));
    }
    expect((await wallet(id)).cycle_start).toBe("2026-12-15");
    expect((await rollEntries(id)).filter((e) => e.entry_type === "grant")).toHaveLength(11);

    // The anniversary passes before Stripe's renewal event arrives: the job must leave month twelve to Stripe.
    await sweep(at("2027-01-16"));
    expect((await wallet(id)).cycle_start).toBe("2026-12-15");

    // The renewal webhook's roll (apply-plan.ts calls this with the new Stripe period) is the twelfth roll.
    const webhook = await inCtx(id, (tx) =>
      rollIncludedCycle(tx, { workspaceId: id, grant: GROWTH_GRANT, cycleStart: "2027-01-15", cycleEnd: "2028-01-15" }));
    expect(webhook.rolled).toBe(true);
    await db.query(
      "UPDATE subscriptions SET current_period_start = '2027-01-15', current_period_end = '2028-01-15' WHERE workspace_id = $1", [id]);

    await sweep(at("2027-01-16"));
    await sweep(at("2027-01-20"));
    expect(await rollEntries(id, "cycle_roll:2027-01-15")).toHaveLength(2); // one expire + one grant, exactly once
    expect((await rollEntries(id)).filter((e) => e.entry_type === "grant")).toHaveLength(12);
    expect(await verifyWorkspaceWallet(db, id)).toBeNull();
  });

  it("[STORY-177 #2 AC4] the job running first at the anniversary leaves the webhook's roll a no-op", async () => {
    const id = await seed({ plan: "growth", cycle: { start: "2026-12-15", end: "2027-01-15" }, grant: GROWTH_GRANT, sub: annualSub() });
    const webhook = await inCtx(id, (tx) =>
      rollIncludedCycle(tx, { workspaceId: id, grant: GROWTH_GRANT, cycleStart: "2027-01-15", cycleEnd: "2028-01-15" }));
    const again = await inCtx(id, (tx) =>
      rollIncludedCycle(tx, { workspaceId: id, grant: GROWTH_GRANT, cycleStart: "2027-01-15", cycleEnd: "2028-01-15" }));
    expect(webhook.rolled).toBe(true);
    expect(again).toEqual({ rolled: false, reason: "not_newer" });
  });

  it("[STORY-177 #3 AC1] a free wallet at the month boundary rolls to the calendar month, free plan grant", async () => {
    const id = await seed({ plan: "free", cycle: { start: "2026-10-01", end: "2026-11-01" }, grant: FREE_GRANT, sub: null });
    await db.query("UPDATE credit_wallets SET included_balance = 7 WHERE workspace_id = $1", [id]);

    const outcome = await sweep(at("2026-11-06"));

    expect(outcome.workspacesRolled).toBe(1);
    expect(await wallet(id)).toMatchObject({ included_balance: FREE_GRANT, cycle_start: "2026-11-01", cycle_end: "2026-12-01" });
    expect((await rollEntries(id, "cycle_roll:2026-11-01")).map((e) => e.entry_type).sort()).toEqual(["expire", "grant"]);
  });

  it("[STORY-177 AC1] a free wallet mid-cycle is untouched", async () => {
    const id = await seed({ plan: "free", cycle: { start: "2026-11-01", end: "2026-12-01" }, grant: FREE_GRANT, sub: null });
    expect((await sweep(at("2026-11-30"))).workspacesRolled).toBe(0);
    expect((await wallet(id)).cycle_start).toBe("2026-11-01");
  });

  it("[STORY-177 AC1] a free wallet whose paid subscription ended (reconciled to free) refreshes from this trigger", async () => {
    const id = await seed({
      plan: "free", cycle: { start: "2026-10-01", end: "2026-11-01" }, grant: FREE_GRANT,
      sub: { interval: "annual", status: "active", start: "2025-10-01T00:00:00Z", end: "2026-10-01T00:00:00Z" },
    });
    expect((await sweep(at("2026-11-06"))).workspacesRolled).toBe(1);
    expect((await wallet(id)).cycle_start).toBe("2026-11-01");
  });

  // subscription-state.ts ENDED writes plan_key free + status active and KEEPS billing_interval.
  it("[STORY-177 AC1] an annual subscription that ended in its first month does not leave the wallet waiting a year", async () => {
    const id = await seed({
      plan: "free", cycle: YEAR_CYCLE, grant: GROWTH_GRANT,
      sub: { interval: "annual", status: "active", start: "2026-01-15T00:00:00Z", end: "2027-01-15T00:00:00Z" },
    });

    expect((await sweep(at("2026-01-25"))).workspacesRolled).toBe(0); // same calendar month as the cycle start
    expect((await sweep(at("2026-02-03"))).workspacesRolled).toBe(1);
    expect(await wallet(id)).toMatchObject({ included_balance: FREE_GRANT, cycle_start: "2026-02-01", cycle_end: "2026-03-01" });
    expect(await verifyWorkspaceWallet(db, id)).toBeNull();
  });

  it("[STORY-177 AC1] a free workspace provisioned on its signup anniversary (real free subscription row) rolls to the calendar month", async () => {
    const id = await seed({
      plan: "free", cycle: { start: "2026-11-20", end: "2026-12-20" }, grant: FREE_GRANT,
      sub: { interval: "monthly", status: "active", start: "2026-11-20T00:00:00Z", end: "2026-12-20T00:00:00Z" },
    });
    expect((await sweep(at("2026-11-30"))).workspacesRolled).toBe(0);
    expect((await sweep(at("2026-12-02"))).workspacesRolled).toBe(1);
    expect(await wallet(id)).toMatchObject({ included_balance: FREE_GRANT, cycle_start: "2026-12-01", cycle_end: "2027-01-01" });
    expect((await sweep(at("2026-12-21"))).workspacesRolled).toBe(0); // the old cycle_end is not a second refresh
    expect(await verifyWorkspaceWallet(db, id)).toBeNull();
  });

  it("[STORY-177 AC1] documented gap: a cycle that began and ended inside one calendar month waits for the next month", async () => {
    const id = await seed({
      plan: "free", cycle: { start: "2026-11-05", end: "2026-11-19" }, grant: FREE_GRANT,
      sub: { interval: "monthly", status: "active", start: "2026-11-05T00:00:00Z", end: "2026-11-19T00:00:00Z" },
    });
    expect((await sweep(at("2026-11-19"))).workspacesRolled).toBe(0);
    expect((await sweep(at("2026-12-01"))).workspacesRolled).toBe(1);
    expect((await wallet(id)).cycle_start).toBe("2026-12-01");
  });

  it("[STORY-177 AC2] twenty sweeps at once, and a sweep racing the webhook's own roll, write each roll exactly once", async () => {
    const id = await seed({ plan: "growth", cycle: YEAR_CYCLE, grant: GROWTH_GRANT, sub: annualSub() });
    const now = at("2026-02-20");
    const results = await Promise.all(Array.from({ length: 20 }, () => sweep(now)));
    expect(results.reduce((n, r) => n + r.workspacesRolled, 0)).toBe(1);
    expect(results.flatMap((r) => r.failures)).toEqual([]);
    expect(await rollEntries(id, "cycle_roll:2026-02-15")).toHaveLength(2);

    const race = await seed({ plan: "growth", cycle: { start: "2026-12-15", end: "2027-01-15" }, grant: GROWTH_GRANT, sub: annualSub() });
    await db.query("UPDATE subscriptions SET current_period_start = '2026-12-15', current_period_end = '2027-12-15' WHERE workspace_id = $1", [race]);
    await Promise.all([
      sweep(at("2027-01-16")), sweep(at("2027-01-16")),
      inCtx(race, (tx) => rollIncludedCycle(tx, { workspaceId: race, grant: GROWTH_GRANT, cycleStart: "2027-01-15", cycleEnd: "2028-01-15" })),
      sweep(at("2027-01-16")),
    ]);
    expect(await rollEntries(race, "cycle_roll:2027-01-15")).toHaveLength(2);
    expect(await verifyWorkspaceWallet(db, race)).toBeNull();
  });

  it("[STORY-177 AC1] the decision reads the subscription after the wallet lock: a plan change committed while the sweep waits is seen", async () => {
    const id = await seed({ plan: "growth", cycle: YEAR_CYCLE, grant: GROWTH_GRANT, sub: annualSub() });
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE", [id]);
      const running = sweep(at("2026-02-20"));
      for (let i = 0; i < 100; i += 1) {
        const w = await db.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()");
        if (w.rowCount) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query("UPDATE subscriptions SET plan_key = 'free' WHERE workspace_id = $1", [id]);
      await holder.query("COMMIT");
      expect((await running).workspacesRolled).toBe(1);
    } finally {
      await holder.end();
    }
    expect((await wallet(id)).included_balance).toBe(FREE_GRANT);
  });

  it("[STORY-177 #4 AC2] a replay of the job does nothing; two instances at once roll exactly once", async () => {
    const annual = await seed({ plan: "growth", cycle: YEAR_CYCLE, grant: GROWTH_GRANT, sub: annualSub() });
    const free = await seed({ plan: "free", cycle: { start: "2026-10-01", end: "2026-11-01" }, grant: FREE_GRANT, sub: null });
    const now = at("2026-11-20");

    const [a, b] = await Promise.all([sweep(now), sweep(now)]);
    expect(a.workspacesRolled + b.workspacesRolled).toBe(2);
    const before = [await rollEntries(annual), await rollEntries(free)];

    const replay = await sweep(now);
    expect(replay.workspacesRolled).toBe(0);
    expect(replay.failures).toEqual([]);
    expect([await rollEntries(annual), await rollEntries(free)]).toEqual(before);
    expect(await verifyWorkspaceWallet(db, annual)).toBeNull();
    expect(await verifyWorkspaceWallet(db, free)).toBeNull();
  });

  it("[STORY-177 #5 AC3] a past_due annual subscription waits for the payment, then rolls", async () => {
    const id = await seed({ plan: "growth", cycle: YEAR_CYCLE, grant: GROWTH_GRANT, sub: annualSub("past_due") });
    expect((await sweep(at("2026-02-20"))).workspacesRolled).toBe(0);
    expect((await wallet(id)).cycle_start).toBe("2026-01-15");

    await db.query("UPDATE subscriptions SET status = 'active' WHERE workspace_id = $1", [id]);
    expect((await sweep(at("2026-02-21"))).workspacesRolled).toBe(1);
    expect((await wallet(id)).cycle_start).toBe("2026-02-15");
  });

  const trial = (end: string) => ({ interval: "annual" as const, status: "trialing", start: "2026-01-15T00:00:00Z", end });

  it("[STORY-177 AC1] a trialing annual subscription gets the monthly refresh inside its trial (decision 67(d)), and not on or after the trial's end", async () => {
    const id = await seed({ plan: "growth", cycle: { start: "2026-01-15", end: "2026-02-15" }, grant: GROWTH_GRANT, sub: trial("2026-03-16T00:00:00Z") });
    expect((await sweep(at("2026-02-20"))).workspacesRolled).toBe(1);
    expect((await wallet(id)).cycle_start).toBe("2026-02-15");
    expect((await sweep(at("2026-02-21"))).workspacesRolled).toBe(0);
    // Still `trialing` on the trial's end (the conversion event is late or failed): payment undecided, the job does not roll.
    expect((await sweep(at("2026-03-16"))).workspacesRolled).toBe(0);
    expect((await sweep(at("2026-03-17"))).workspacesRolled).toBe(0);
    expect((await wallet(id)).cycle_start).toBe("2026-02-15");
  });

  it("[STORY-177 AC1] a 30-day trial never gets a job roll: the first month boundary is after the trial's end", async () => {
    const id = await seed({ plan: "growth", cycle: { start: "2026-01-15", end: "2026-02-15" }, grant: GROWTH_GRANT, sub: trial("2026-02-14T00:00:00Z") });
    expect((await sweep(at("2026-02-14"))).workspacesRolled).toBe(0);
    expect((await sweep(at("2026-02-20"))).workspacesRolled).toBe(0);
    expect((await wallet(id)).cycle_start).toBe("2026-01-15");
  });

  it("[STORY-177 AC1] trial to active: after a job roll inside the trial, the conversion webhook's period advance still rolls (one grant each)", async () => {
    const id = await seed({ plan: "growth", cycle: { start: "2026-01-15", end: "2026-02-15" }, grant: GROWTH_GRANT, sub: trial("2026-03-16T00:00:00Z") });
    await sweep(at("2026-02-20"));
    const converted = await inCtx(id, (tx) => rollIncludedCycle(tx, { workspaceId: id, grant: GROWTH_GRANT, cycleStart: "2026-03-16", cycleEnd: "2027-03-16" }));
    expect(converted.rolled).toBe(true);
    expect((await wallet(id)).cycle_start).toBe("2026-03-16");
  });

  it("[STORY-177 AC1] a monthly-billed paid wallet is never this job's: the webhook owns it", async () => {
    const id = await seed({
      plan: "growth", cycle: { start: "2026-10-01", end: "2026-11-01" }, grant: GROWTH_GRANT,
      sub: { interval: "monthly", status: "active", start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
    });
    expect((await sweep(at("2026-11-06"))).workspacesRolled).toBe(0);
    expect((await wallet(id)).cycle_start).toBe("2026-10-01");
  });

  it("[STORY-177 AC4] subscriptions.current_period_* stays Stripe's; resolveBillingPeriod keeps reading the wallet first", async () => {
    const id = await seed({ plan: "growth", cycle: YEAR_CYCLE, grant: GROWTH_GRANT, sub: annualSub() });
    await sweep(at("2026-02-20"));
    const sub = await db.query<{ s: string; e: string }>(
      "SELECT current_period_start::date::text AS s, current_period_end::date::text AS e FROM subscriptions WHERE workspace_id = $1", [id]);
    expect(sub.rows[0]).toEqual({ s: "2026-01-15", e: "2027-01-15" });
    const period = await inCtx(id, (tx) => resolveBillingPeriod(tx, id, at("2026-02-20")));
    expect(period).toEqual({ start: "2026-02-15", end: "2026-03-15" });
  });

  it("[STORY-177 AC5] the credit.housekeeping handler runs the refresh, as the worker runs it", async () => {
    const id = await seed({ plan: "free", cycle: { start: "2000-01-01", end: "2000-02-01" }, grant: FREE_GRANT, sub: null });
    const tick = { data: {} } as unknown as Job;
    await createCreditHousekeepingHandler(
      { pool, env: { DATABASE_URL: container.getConnectionUri() } } as unknown as QueueHandlerContext,
    )({} as never, tick);
    expect((await wallet(id)).cycle_start).not.toBe("2000-01-01");
    expect(await verifyWorkspaceWallet(db, id)).toBeNull();
  });
});

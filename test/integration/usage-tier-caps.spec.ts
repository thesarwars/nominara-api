import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { PLAN_ENTITLEMENTS } from "../../src/db/seed/plan-entitlements.js";
import { calendarMonthStart, nextCalendarMonthStart, resolveBillingPeriod } from "../../src/lib/usage/billing-period.js";
import { METRIC_SPECS, UNLIMITED_LIMIT, USAGE_METRICS } from "../../src/lib/usage/metrics.js";
import {
  commitTierCap,
  crossedWarningThresholds,
  limitValueFor,
  meterInternalUsage,
  provisionUsageCounters,
  readCounter,
  releaseTierCap,
  reserveTierCap,
} from "../../src/lib/usage/tier-caps.js";

// STORY-070 — test scenarios 1-6, 8, 9, 11, and the RLS boundary on the new
// table.
//
// Against a real database with real concurrency, because that is the only
// place the design can be wrong. Every statement here puts its condition in a
// `WHERE` clause specifically so two callers cannot both take the last of
// something; a single-threaded test passes just as happily against a
// read-then-write, which is the implementation this shape exists to rule out.

const PERIOD = "2026-09-01";

describe("STORY-070 · the non-credit tier-cap lifecycle", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
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
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 12 });
  }, 240_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE usage_reservations, usage_counters, credit_wallets, subscriptions, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  async function setCounter(metric: string, limitValue: number, used = 0, reserved = 0): Promise<void> {
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value, reserved_value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, metric, period_start)
       DO UPDATE SET limit_value = EXCLUDED.limit_value, used_value = EXCLUDED.used_value,
                     reserved_value = EXCLUDED.reserved_value`,
      [workspaceId, metric, PERIOD, limitValue, used, reserved],
    );
  }

  // -------------------------------------------------------------------------
  // AC1 — exactly the four metrics
  // -------------------------------------------------------------------------
  it("the four metrics are exactly the ones the database will accept", async () => {
    // schemas/billing-and-credits.md: "Only four metrics live here, and none of
    // them is charged in credits." A fifth arriving in TypeScript without the
    // CHECK constraint moving would fail at runtime on the first request.
    const constraint = await db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'usage_counters'::regclass AND contype = 'c' AND conname LIKE '%metric%'`,
    );
    const definition = constraint.rows.map((row) => row.definition).join(" ");
    for (const metric of USAGE_METRICS) {
      expect(definition, metric).toContain(metric);
    }
    expect(USAGE_METRICS).toHaveLength(4);
  });

  it("a metric outside the four is refused by the database, not merely by TypeScript", async () => {
    await expect(setCounter("deep_scan_credits", 10)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Provisioning, and AC11's reset
  // -------------------------------------------------------------------------
  it("provisioning creates all four counters with the plan's ceilings", async () => {
    await provisionUsageCounters(db, workspaceId, PERIOD, PLAN_ENTITLEMENTS.growth);

    const pdf = await readCounter(db, workspaceId, "pdf_exports", PERIOD);
    expect(pdf).toEqual({ limitValue: 25, usedValue: 0, reservedValue: 0 });

    const fairUse = await readCounter(db, workspaceId, "fair_use_captures", PERIOD);
    expect(fairUse!.limitValue).toBe(6000);

    // AC9 — no plan-facing ceiling exists for the internal-cost metrics, so
    // they are unlimited and metered rather than capped.
    for (const metric of ["embed_tokens", "arbiter_tokens"] as const) {
      expect((await readCounter(db, workspaceId, metric, PERIOD))!.limitValue).toBe(UNLIMITED_LIMIT);
    }
  });

  it("all four are non-billable — nothing here reaches an invoice", async () => {
    await provisionUsageCounters(db, workspaceId, PERIOD, PLAN_ENTITLEMENTS.growth);
    const rows = await db.query<{ metric: string; billable: boolean }>(
      "SELECT metric, billable FROM usage_counters WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(rows.rows).toHaveLength(4);
    for (const row of rows.rows) {
      expect(row.billable, row.metric).toBe(false);
    }
  });

  it("re-provisioning is idempotent and never forgives what has been used", async () => {
    await provisionUsageCounters(db, workspaceId, PERIOD, PLAN_ENTITLEMENTS.growth);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 5, jobId: "j1" });
    await commitTierCap(db, workspaceId, "pdf_exports", "j1");

    await provisionUsageCounters(db, workspaceId, PERIOD, PLAN_ENTITLEMENTS.growth);
    await provisionUsageCounters(db, workspaceId, PERIOD, PLAN_ENTITLEMENTS.growth);

    expect(await readCounter(db, workspaceId, "pdf_exports", PERIOD)).toEqual({
      limitValue: 25,
      usedValue: 5,
      reservedValue: 0,
    });
  });

  it("a plan change mid-cycle moves the ceiling and leaves usage alone", async () => {
    await provisionUsageCounters(db, workspaceId, PERIOD, PLAN_ENTITLEMENTS.growth);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 5, jobId: "j1" });
    await commitTierCap(db, workspaceId, "pdf_exports", "j1");

    // Growth 25 → Business "unlimited".
    await provisionUsageCounters(db, workspaceId, PERIOD, PLAN_ENTITLEMENTS.business);

    expect(await readCounter(db, workspaceId, "pdf_exports", PERIOD)).toEqual({
      limitValue: UNLIMITED_LIMIT,
      usedValue: 5,
      reservedValue: 0,
    });
  });

  // Scenario 11 — the period rolls
  it("a new period is a new set of counters at zero; the old period is left as history", async () => {
    await provisionUsageCounters(db, workspaceId, PERIOD, PLAN_ENTITLEMENTS.growth);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 20, jobId: "j1" });
    await commitTierCap(db, workspaceId, "pdf_exports", "j1");

    const nextPeriod = "2026-10-01";
    await provisionUsageCounters(db, workspaceId, nextPeriod, PLAN_ENTITLEMENTS.growth);

    expect((await readCounter(db, workspaceId, "pdf_exports", nextPeriod))!.usedValue).toBe(0);
    // The reset is not a statement that zeroes anything, so last cycle's record
    // survives — which is what makes running it twice harmless.
    expect((await readCounter(db, workspaceId, "pdf_exports", PERIOD))!.usedValue).toBe(20);
  });

  // -------------------------------------------------------------------------
  // Scenarios 1, 2, 6 — reserve
  // -------------------------------------------------------------------------
  it("reserves within the cap and reports what is left", async () => {
    await setCounter("pdf_exports", 25, 5);
    const outcome = await reserveTierCap(db, {
      workspaceId,
      metric: "pdf_exports",
      periodStart: PERIOD,
      quantity: 4,
    });

    expect(outcome).toEqual({ ok: true, remaining: 16, alreadyHeld: false });
    expect((await readCounter(db, workspaceId, "pdf_exports", PERIOD))!.reservedValue).toBe(4);
  });

  it("refuses past the cap and writes NOTHING", async () => {
    await setCounter("pdf_exports", 25, 24);
    const outcome = await reserveTierCap(db, {
      workspaceId,
      metric: "pdf_exports",
      periodStart: PERIOD,
      quantity: 2,
    });

    expect(outcome).toEqual({ ok: false });
    // "no partial state" — the counter is untouched, not partially incremented.
    expect(await readCounter(db, workspaceId, "pdf_exports", PERIOD)).toEqual({
      limitValue: 25,
      usedValue: 24,
      reservedValue: 0,
    });
  });

  it("a refusal creates no reservation row either", async () => {
    await setCounter("pdf_exports", 1, 1);
    const outcome = await reserveTierCap(db, {
      workspaceId,
      metric: "pdf_exports",
      periodStart: PERIOD,
      quantity: 1,
      jobId: "j-refused",
    });

    expect(outcome).toEqual({ ok: false });
    const rows = await db.query("SELECT 1 FROM usage_reservations WHERE workspace_id = $1", [workspaceId]);
    expect(rows.rowCount).toBe(0);
  });

  it("an unlimited ceiling never blocks, and still counts", async () => {
    await setCounter("fair_use_captures", UNLIMITED_LIMIT, 10_000_000, 5_000_000);
    const outcome = await reserveTierCap(db, {
      workspaceId,
      metric: "fair_use_captures",
      periodStart: PERIOD,
      quantity: 250,
    });

    expect(outcome.ok).toBe(true);
    // A ceiling that never binds, not a counter that stops counting — the
    // internal-cost view exists precisely for accounts too large to cap.
    expect((await readCounter(db, workspaceId, "fair_use_captures", PERIOD))!.reservedValue).toBe(5_000_250);
  });

  it("only the documented sentinel is unlimited — a different negative still refuses", async () => {
    await setCounter("pdf_exports", -2);
    expect(
      await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 1 }),
    ).toEqual({ ok: false });
  });

  it("concurrent reservations cannot oversubscribe the cap", async () => {
    // The property a single-threaded test cannot see. Ten callers race for
    // eight units of capacity; a read-then-write lets all ten through.
    await setCounter("pdf_exports", 8);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, async (_unused, index) => {
        const client = await pool.connect();
        try {
          const outcome = await reserveTierCap(client, {
            workspaceId,
            metric: "pdf_exports",
            periodStart: PERIOD,
            quantity: 1,
            jobId: `race-${String(index)}`,
          });
          return outcome.ok;
        } finally {
          client.release();
        }
      }),
    );

    expect(attempts.filter(Boolean)).toHaveLength(8);
    expect((await readCounter(db, workspaceId, "pdf_exports", PERIOD))!.reservedValue).toBe(8);
  });

  // -------------------------------------------------------------------------
  // Scenarios 3, 4, 5 — commit and release
  // -------------------------------------------------------------------------
  it("committing moves reserved into used", async () => {
    await setCounter("pdf_exports", 25);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 3, jobId: "j1" });

    expect(await commitTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(true);
    expect(await readCounter(db, workspaceId, "pdf_exports", PERIOD)).toEqual({
      limitValue: 25,
      usedValue: 3,
      reservedValue: 0,
    });
  });

  it("committing twice does not count the same work twice", async () => {
    await setCounter("pdf_exports", 25);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 3, jobId: "j1" });
    await commitTierCap(db, workspaceId, "pdf_exports", "j1");

    expect(await commitTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(false);
    expect((await readCounter(db, workspaceId, "pdf_exports", PERIOD))!.usedValue).toBe(3);
  });

  it("releasing returns the reservation", async () => {
    await setCounter("pdf_exports", 25);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 3, jobId: "j1" });

    expect(await releaseTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(true);
    expect(await readCounter(db, workspaceId, "pdf_exports", PERIOD)).toEqual({
      limitValue: 25,
      usedValue: 0,
      reservedValue: 0,
    });
  });

  // Scenario 5 — the one AC4 exists for
  it("a RETRIED release does not over-release", async () => {
    // A compensation is retried exactly when something has already gone wrong:
    // a worker crash between the release and its acknowledgement, a queue
    // redelivery. A naked decrement subtracts twice, the counter drifts low,
    // and the customer silently gets more than their cap.
    await setCounter("pdf_exports", 25, 0, 10);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 3, jobId: "j1" });

    expect(await releaseTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(true);
    expect(await releaseTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(false);
    expect(await releaseTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(false);

    expect((await readCounter(db, workspaceId, "pdf_exports", PERIOD))!.reservedValue).toBe(10);
  });

  it("STORY-180 r6 · a RELEASED reservation is re-taken by a retry under the same job id (capped and counted again), and a committed one is still a replay", async () => {
    await setCounter("pdf_exports", 1);
    const take = () => reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 1, jobId: "j1" });
    expect(await take()).toMatchObject({ ok: true, alreadyHeld: false });
    expect(await releaseTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(true);
    expect(await take()).toMatchObject({ ok: true, alreadyHeld: false });
    expect((await readCounter(db, workspaceId, "pdf_exports", PERIOD))!.reservedValue).toBe(1);
    expect(await take()).toMatchObject({ ok: true, alreadyHeld: true });
    expect(await commitTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(true);
    expect(await take()).toMatchObject({ ok: true, alreadyHeld: true });
    expect(await readCounter(db, workspaceId, "pdf_exports", PERIOD)).toEqual({ limitValue: 1, usedValue: 1, reservedValue: 0 });
  });

  it("STORY-180 r6 · a released reservation retried at an exhausted ceiling is REFUSED, not waved through as a replay", async () => {
    await setCounter("pdf_exports", 1);
    const take = (jobId: string) => reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 1, jobId });
    await take("j1");
    await releaseTierCap(db, workspaceId, "pdf_exports", "j1");
    await take("j2");
    expect(await take("j1")).toEqual({ ok: false });
    expect((await readCounter(db, workspaceId, "pdf_exports", PERIOD))!.reservedValue).toBe(1);
  });

  it("a committed reservation cannot then be released", async () => {
    await setCounter("pdf_exports", 25);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 3, jobId: "j1" });
    await commitTierCap(db, workspaceId, "pdf_exports", "j1");

    expect(await releaseTierCap(db, workspaceId, "pdf_exports", "j1")).toBe(false);
    expect(await readCounter(db, workspaceId, "pdf_exports", PERIOD)).toEqual({
      limitValue: 25,
      usedValue: 3,
      reservedValue: 0,
    });
  });

  it("a replayed reservation under one job id does not consume the cap twice", async () => {
    await setCounter("pdf_exports", 25);
    const first = await reserveTierCap(db, {
      workspaceId,
      metric: "pdf_exports",
      periodStart: PERIOD,
      quantity: 3,
      jobId: "j1",
    });
    const replay = await reserveTierCap(db, {
      workspaceId,
      metric: "pdf_exports",
      periodStart: PERIOD,
      quantity: 3,
      jobId: "j1",
    });

    expect(first).toEqual({ ok: true, remaining: 22, alreadyHeld: false });
    expect(replay).toEqual({ ok: true, remaining: null, alreadyHeld: true });
    expect((await readCounter(db, workspaceId, "pdf_exports", PERIOD))!.reservedValue).toBe(3);
  });

  it("a replay and a refusal are told apart, not conflated", async () => {
    // Both leave nothing inserted. Reporting a refusal as a replay would let a
    // caller proceed past an exhausted cap.
    await setCounter("pdf_exports", 3);
    await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 3, jobId: "held" });

    expect(
      await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 3, jobId: "held" }),
    ).toEqual({ ok: true, remaining: null, alreadyHeld: true });
    expect(
      await reserveTierCap(db, { workspaceId, metric: "pdf_exports", periodStart: PERIOD, quantity: 1, jobId: "new" }),
    ).toEqual({ ok: false });
  });

  it("a reservation cannot exist without its counter", async () => {
    // The composite foreign key: a release can never decrement a counter that
    // was never incremented.
    await expect(
      db.query(
        `INSERT INTO usage_reservations (workspace_id, metric, job_id, period_start, quantity)
         VALUES ($1, 'pdf_exports', 'orphan', $2, 1)`,
        [workspaceId, PERIOD],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  // -------------------------------------------------------------------------
  // Scenario 8 — warnings, once per threshold per period
  // -------------------------------------------------------------------------
  it("a threshold fires once per period however many requests cross it", async () => {
    await setCounter("pdf_exports", 100, 85);

    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([80]);
    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([]);
    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([]);
  });

  it("crossing both thresholds at once reports both, once", async () => {
    // STORY-068 / owner decision 2026-10-23: the thresholds are scoring-models.md §15's 80% and 95% (was 80/90).
    await setCounter("pdf_exports", 100, 95);

    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([80, 95]);
    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([]);
  });

  it("the second threshold still fires later, in its own period", async () => {
    await setCounter("pdf_exports", 100, 82);
    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([80]);

    // STORY-068 — 90% is no longer a threshold: 94 of 100 warns about nothing new.
    await db.query(
      "UPDATE usage_counters SET used_value = 94 WHERE workspace_id = $1 AND metric = 'pdf_exports' AND period_start = $2",
      [workspaceId, PERIOD],
    );
    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([]);
    await db.query(
      "UPDATE usage_counters SET used_value = 95 WHERE workspace_id = $1 AND metric = 'pdf_exports' AND period_start = $2",
      [workspaceId, PERIOD],
    );
    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([95]);
    const stamped = await db.query(
      "SELECT warned_at_80 IS NOT NULL AS w80, warned_at_90 IS NULL AS no90, warned_at_95 IS NOT NULL AS w95 FROM usage_counters WHERE workspace_id = $1 AND metric = 'pdf_exports' AND period_start = $2",
      [workspaceId, PERIOD],
    );
    expect(stamped.rows[0]).toEqual({ w80: true, no90: true, w95: true });
  });

  it("an unlimited ceiling never warns, and a zero one never warns", async () => {
    // 80% of unlimited is meaningless; 80% of zero is true at no usage at all,
    // and would warn a customer about an allowance they never had.
    await setCounter("fair_use_captures", UNLIMITED_LIMIT, 10_000_000);
    expect(await crossedWarningThresholds(db, workspaceId, "fair_use_captures", PERIOD)).toEqual([]);

    await setCounter("pdf_exports", 0);
    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([]);
  });

  it("a reservation counts toward the threshold, not just a commit", async () => {
    // Reserved capacity is spoken for. Warning only on commit would leave a
    // customer unwarned right up to the moment they are refused.
    await setCounter("pdf_exports", 100, 0, 85);
    expect(await crossedWarningThresholds(db, workspaceId, "pdf_exports", PERIOD)).toEqual([80]);
  });

  // -------------------------------------------------------------------------
  // Scenario 9 — the internal-cost metrics
  // -------------------------------------------------------------------------
  it("an internal-cost metric is metered without a reservation", async () => {
    await setCounter("embed_tokens", UNLIMITED_LIMIT);
    await meterInternalUsage(db, workspaceId, "embed_tokens", PERIOD, 40_000);
    await meterInternalUsage(db, workspaceId, "embed_tokens", PERIOD, 2_500);

    expect(await readCounter(db, workspaceId, "embed_tokens", PERIOD)).toEqual({
      limitValue: UNLIMITED_LIMIT,
      usedValue: 42_500,
      reservedValue: 0,
    });
  });

  it("a customer-facing metric refuses to be metered without a reservation", async () => {
    await setCounter("pdf_exports", 25);
    await expect(meterInternalUsage(db, workspaceId, "pdf_exports", PERIOD, 1)).rejects.toThrow(
      /customer-facing/,
    );
  });

  it("the internal-cost metrics are the ones with no entitlement key", async () => {
    expect(METRIC_SPECS.embed_tokens).toEqual({ entitlementKey: null, customerFacing: false, publishesLimit: false });
    expect(METRIC_SPECS.arbiter_tokens).toEqual({ entitlementKey: null, customerFacing: false, publishesLimit: false });
  });

  // -------------------------------------------------------------------------
  // The billing period
  // -------------------------------------------------------------------------
  it("falls back to the calendar month for a workspace with neither wallet nor subscription", async () => {
    const now = new Date("2026-09-17T12:00:00Z");
    expect(await resolveBillingPeriod(db, workspaceId, now)).toEqual({ start: "2026-09-01", end: "2026-10-01" });
  });

  it("prefers the subscription's period over the calendar month", async () => {
    await db.query(
      `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id,
                                  stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1, 'growth', 'monthly', 'cus_x', 'sub_x', 'active', '2026-09-14', '2026-10-14')`,
      [workspaceId],
    );
    expect(await resolveBillingPeriod(db, workspaceId, new Date("2026-09-17T12:00:00Z"))).toEqual({
      start: "2026-09-14",
      end: "2026-10-14",
    });
  });

  it("prefers the wallet's cycle over the subscription's, so both allowances roll together", async () => {
    await db.query(
      `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id,
                                  stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1, 'growth', 'monthly', 'cus_x', 'sub_x', 'active', '2026-09-14', '2026-10-14')`,
      [workspaceId],
    );
    await db.query(
      "INSERT INTO credit_wallets (workspace_id, cycle_start, cycle_end) VALUES ($1, '2026-09-02', '2026-10-02')",
      [workspaceId],
    );
    expect(await resolveBillingPeriod(db, workspaceId, new Date("2026-09-17T12:00:00Z"))).toEqual({
      start: "2026-09-02",
      end: "2026-10-02",
    });
  });

  it("a canceled subscription's period is history and is not used", async () => {
    await db.query(
      `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id,
                                  stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1, 'growth', 'monthly', 'cus_x', 'sub_x', 'canceled', '2025-01-01', '2025-02-01')`,
      [workspaceId],
    );
    const now = new Date("2026-09-17T12:00:00Z");
    expect(await resolveBillingPeriod(db, workspaceId, now)).toEqual({ start: "2026-09-01", end: "2026-10-01" });
  });

  it("December rolls into the next January", () => {
    const december = new Date("2026-12-09T00:00:00Z");
    expect(calendarMonthStart(december)).toBe("2026-12-01");
    expect(nextCalendarMonthStart(december)).toBe("2027-01-01");
  });

  // -------------------------------------------------------------------------
  // Ceiling translation
  // -------------------------------------------------------------------------
  it("the open-ended strings become the unlimited sentinel and a zero stays zero", () => {
    expect(limitValueFor("pdf_exports", "unlimited")).toBe(UNLIMITED_LIMIT);
    expect(limitValueFor("fair_use_captures", "negotiated")).toBe(UNLIMITED_LIMIT);
    // AC7 needs the zero to survive to be read, so the guard can tell "your
    // tier has none of this" from "you have used yours".
    expect(limitValueFor("pdf_exports", 0)).toBe(0);
    expect(limitValueFor("pdf_exports", null)).toBe(0);
  });

  it("a value that is not a ceiling is refused rather than silently treated as unlimited", () => {
    expect(() => limitValueFor("pdf_exports", "3_core")).toThrow(/not a ceiling/);
  });

  // -------------------------------------------------------------------------
  // The new table is a tenant table
  // -------------------------------------------------------------------------
  it("usage_reservations is row-level-secured and forced, like every other tenant table", async () => {
    const flags = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'usage_reservations'",
    );
    expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policy = await db.query<{ policyname: string; with_check: string | null }>(
      "SELECT policyname, with_check FROM pg_policies WHERE tablename = 'usage_reservations'",
    );
    expect(policy.rows.map((row) => row.policyname)).toEqual(["ws_isolation_usage_reservations"]);
    // A FOR ALL policy with a null WITH CHECK would let a write cross tenants
    // even while reads were isolated.
    expect(policy.rows[0]!.with_check).not.toBeNull();
  });
});

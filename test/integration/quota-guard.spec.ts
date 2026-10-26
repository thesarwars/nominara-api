import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Meter } from "../../src/api/decorators/meter.decorator.js";
import { DomainError } from "../../src/api/errors/domain-errors.js";
import { QuotaGuard } from "../../src/api/guards/quota.guard.js";
import type { WorkspaceScopedRequest } from "../../src/api/guards/workspace.guard.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { assertFairUseCapacity } from "../../src/lib/capture/fair-use.js";
import { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../src/lib/entitlements/structural-usage.js";
import { readCounter } from "../../src/lib/usage/tier-caps.js";

// STORY-070 AC6, AC7, AC10, AC12 — test scenarios 2, 7, 10 and 12.
//
// The criterion this file exists for is AC7, and it is a criterion about
// ORDER: "A tier whose cap is zero returns the feature failure instead — the
// remediation differs, and this is checked before the counter is touched."
//
// "Before the counter is touched" is literal. A zero-limit counter refuses
// every reservation on its own, so an implementation that reserved first would
// produce a refusal for the right request and the WRONG reason — `429
// quota_exceeded`, telling a customer to wait for a reset that will never help
// them, which the story calls the worst of the three outcomes.

class ExportPdfRoute {
  @Meter("pdf_exports")
  handler(): void {}
}

class BulkExportRoute {
  @Meter("pdf_exports", 5)
  handler(): void {}
}

class InternalMetricRoute {
  @Meter("embed_tokens")
  handler(): void {}
}

class UnmeteredRoute {
  handler(): void {}
}

function makeContext(req: Partial<WorkspaceScopedRequest>, ctor: new () => object) {
  const proto = ctor.prototype as { handler?: () => void };
  return {
    getHandler: () => proto.handler ?? (() => undefined),
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as Parameters<QuotaGuard["canActivate"]>[0];
}

async function refusalFrom(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) {
      return { code: error.code, details: error.details, remediation: error.remediation };
    }
    throw error;
  }
  throw new Error("expected the guard to refuse, but it allowed the request");
}

describe("STORY-070 · QuotaGuard: a zero cap is never an exhausted counter", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let guard: QuotaGuard;
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
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  }, 240_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE notifications, usage_reservations, usage_counters, credit_wallets, subscriptions, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    guard = new QuotaGuard(
      new Reflector(),
      new EntitlementResolver(new InMemoryCacheAdapter(), pool),
      new StructuralUsage(pool),
      pool,
    );
  });

  function request(): Partial<WorkspaceScopedRequest> {
    return { tenant: { workspaceId, actorId: randomUUID() }, entitlementVersion: 1 };
  }

  /** The period the guard will have resolved — no wallet, no subscription. */
  function currentPeriod(): { start: string; end: string } {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const start = `${String(year)}-${String(month).padStart(2, "0")}-01`;
    const end =
      month === 12 ? `${String(year + 1)}-01-01` : `${String(year)}-${String(month + 1).padStart(2, "0")}-01`;
    return { start, end };
  }

  async function setPlan(planKey: string): Promise<void> {
    await db.query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [workspaceId, planKey]);
  }

  it("a route with no @Meter() passes without touching a counter", async () => {
    await expect(guard.canActivate(makeContext(request(), UnmeteredRoute))).resolves.toBe(true);

    const rows = await db.query("SELECT 1 FROM usage_counters WHERE workspace_id = $1", [workspaceId]);
    expect(rows.rowCount).toBe(0);
  });

  it("provisions the counters on first use and reserves against them", async () => {
    await expect(guard.canActivate(makeContext(request(), ExportPdfRoute))).resolves.toBe(true);

    const period = currentPeriod();
    // AC11 needs no scheduler: the first metered request of a cycle creates
    // the rows, because a new cycle is a new primary key.
    const rows = await db.query("SELECT metric FROM usage_counters WHERE workspace_id = $1", [workspaceId]);
    expect(rows.rowCount).toBe(4);
    expect(await readCounter(db, workspaceId, "pdf_exports", period.start)).toEqual({
      limitValue: 25,
      usedValue: 0,
      reservedValue: 1,
    });
  });

  it("@Meter's quantity is what gets reserved", async () => {
    await expect(guard.canActivate(makeContext(request(), BulkExportRoute))).resolves.toBe(true);
    expect((await readCounter(db, workspaceId, "pdf_exports", currentPeriod().start))!.reservedValue).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Scenario 2 — past the cap
  // -------------------------------------------------------------------------
  it("an exhausted cap returns the quota failure with the metric, the limit and the reset date", async () => {
    const period = currentPeriod();
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value)
       VALUES ($1, 'pdf_exports', $2, 25, 25)`,
      [workspaceId, period.start],
    );

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), ExportPdfRoute)));

    expect(refusal.code).toBe("quota_exceeded");
    expect(refusal.details).toEqual({ metric: "pdf_exports", limit: 25, resets_at: period.end });
    // "wait for the cycle" — never "upgrade", and never "buy credits".
    expect(refusal.remediation).toEqual({ kind: "wait_for_cycle" });
  });

  it("a refusal reserves nothing", async () => {
    const period = currentPeriod();
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value)
       VALUES ($1, 'pdf_exports', $2, 25, 25)`,
      [workspaceId, period.start],
    );

    await refusalFrom(() => guard.canActivate(makeContext(request(), ExportPdfRoute)));

    expect(await readCounter(db, workspaceId, "pdf_exports", period.start)).toEqual({
      limitValue: 25,
      usedValue: 25,
      reservedValue: 0,
    });
  });

  // -------------------------------------------------------------------------
  // STORY-068 scenario 7 / AC7 — "Cross a threshold, then load the dashboard
  // repeatedly: ONE notification." The guard turns each crossing it stamps
  // into one notification; a request that crosses nothing new writes none.
  // -------------------------------------------------------------------------
  it("[STORY-068 #7 / AC7] crossing 80% notifies once however many requests follow; 95% notifies once more; 90% is not a threshold", async () => {
    const period = currentPeriod();
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value)
       VALUES ($1, 'pdf_exports', $2, 25, 19)`,
      [workspaceId, period.start],
    );
    const notes = async () =>
      (await db.query("SELECT kind, severity, payload FROM notifications WHERE workspace_id = $1 ORDER BY created_at", [workspaceId])).rows.map((r) => [
        r.kind,
        r.severity,
        r.payload.threshold,
      ]);

    await guard.canActivate(makeContext(request(), ExportPdfRoute)); // 20 of 25 = 80%
    expect(await notes()).toEqual([["usage.quota_threshold", "warning", 80]]);
    for (let i = 0; i < 3; i += 1) await guard.canActivate(makeContext(request(), ExportPdfRoute)); // 84%, 88%, 92%
    expect(await notes(), "92% crosses nothing new").toEqual([["usage.quota_threshold", "warning", 80]]);
    await guard.canActivate(makeContext(request(), ExportPdfRoute)); // 24 of 25 = 96%
    expect(await notes()).toEqual([
      ["usage.quota_threshold", "warning", 80],
      ["usage.quota_threshold", "warning", 95],
    ]);
  });

  it("an unlimited cap never refuses", async () => {
    await setPlan("business"); // exports.pdf_per_cycle: "unlimited"
    await expect(guard.canActivate(makeContext(request(), BulkExportRoute))).resolves.toBe(true);
    expect((await readCounter(db, workspaceId, "pdf_exports", currentPeriod().start))!.limitValue).toBe(-1);
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — THE zero-cap trap (AC7)
  // -------------------------------------------------------------------------
  it("a tier whose cap is ZERO returns the FEATURE failure, and the counter is never touched", async () => {
    await setPlan("starter"); // exports.pdf_per_cycle: 0

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), ExportPdfRoute)));

    expect(refusal.code).toBe("feature_not_in_plan");
    expect(refusal.code).not.toBe("quota_exceeded");
    expect(refusal.details).toEqual({ key: "exports.pdf_per_cycle", min_plan: "growth" });
    expect(refusal.remediation).toEqual({ kind: "upgrade_plan" });

    // "checked before the counter is touched" — literally. No counter row was
    // created at all, so nothing could have been reserved and refused.
    const rows = await db.query("SELECT 1 FROM usage_counters WHERE workspace_id = $1", [workspaceId]);
    expect(rows.rowCount).toBe(0);
  });

  it("the free tier's zero cap is the same feature failure", async () => {
    await setPlan("free");
    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), ExportPdfRoute)));
    expect(refusal.code).toBe("feature_not_in_plan");
  });

  // -------------------------------------------------------------------------
  // Scenario 10 — fair use is enforced and NOT published (AC10)
  // -------------------------------------------------------------------------
  it("an exhausted fair-use ceiling refuses WITHOUT naming the figure", async () => {
    // FR-CRD-19: the ceiling "is not published — a limit nobody hits adds a
    // dimension and reduces trust at the same time". A 429 carrying
    // `limit: 6000` publishes it to precisely the customer about to ask.
    const period = currentPeriod();
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value)
       VALUES ($1, 'fair_use_captures', $2, 6000, 6000)`,
      [workspaceId, period.start],
    );

    const refusal = await refusalFrom(() => assertFairUseCapacity(db, workspaceId, period.start, 1));

    expect(refusal.code).toBe("quota_exceeded");
    expect(refusal.details).toEqual({ metric: "fair_use_captures", resets_at: period.end });
    expect(refusal.details).not.toHaveProperty("limit");
  });

  it("it is still ENFORCED — unpublished is not unenforced", async () => {
    const period = currentPeriod();
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value)
       VALUES ($1, 'fair_use_captures', $2, 100, 99)`,
      [workspaceId, period.start],
    );

    await expect(assertFairUseCapacity(db, workspaceId, period.start, 2)).rejects.toThrow();
    await expect(assertFairUseCapacity(db, workspaceId, period.start, 1)).resolves.toBeUndefined();
  });

  it("a PDF cap DOES name its figure — it is a plan number the customer already sees", async () => {
    // The other side of the same decision, so "withhold the limit" is not
    // mistaken for a blanket rule.
    const period = currentPeriod();
    await db.query(
      `INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value, used_value)
       VALUES ($1, 'pdf_exports', $2, 25, 25)`,
      [workspaceId, period.start],
    );
    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), ExportPdfRoute)));
    expect(refusal.details).toHaveProperty("limit", 25);
  });

  // -------------------------------------------------------------------------
  // AC9 — an internal-cost metric can never gate a request
  // -------------------------------------------------------------------------
  it("a route metering an internal-cost metric is refused as a configuration error", async () => {
    // "metered but marked non-billable, so a runaway is visible without ever
    // reaching a customer". A 429 over our own embedding spend would charge
    // the customer for our efficiency.
    await expect(guard.canActivate(makeContext(request(), InternalMetricRoute))).rejects.toThrow(
      /internal-cost observability/,
    );
  });

  it("refuses when no workspace is resolved rather than allowing the request", async () => {
    await expect(guard.canActivate(makeContext({}, ExportPdfRoute))).rejects.toThrow(/no workspace is resolved/);
  });

  // -------------------------------------------------------------------------
  // The reservation's job identifier
  // -------------------------------------------------------------------------
  it("reserves under the request's Idempotency-Key, so a retry does not consume the cap twice", async () => {
    // api-specification.md §1 requires the header on every billable or
    // external-effect POST, which is every route that would carry @Meter, and
    // it is exactly what a retry presents again.
    const withKey = { ...request(), headers: { "idempotency-key": "req-abc" } };

    await expect(guard.canActivate(makeContext(withKey, ExportPdfRoute))).resolves.toBe(true);
    await expect(guard.canActivate(makeContext(withKey, ExportPdfRoute))).resolves.toBe(true);

    expect((await readCounter(db, workspaceId, "pdf_exports", currentPeriod().start))!.reservedValue).toBe(1);
  });

  it("two different keys are two reservations", async () => {
    for (const key of ["req-1", "req-2"]) {
      await guard.canActivate(makeContext({ ...request(), headers: { "idempotency-key": key } }, ExportPdfRoute));
    }
    expect((await readCounter(db, workspaceId, "pdf_exports", currentPeriod().start))!.reservedValue).toBe(2);
  });

  it("without a key the cap still binds — it is the settlement that is lost, not the enforcement", async () => {
    // The reservation stands until the period rolls, which is the safe
    // direction for a ceiling. Growth allows 25.
    for (let index = 0; index < 25; index += 1) {
      await guard.canActivate(makeContext(request(), ExportPdfRoute));
    }
    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), ExportPdfRoute)));
    expect(refusal.code).toBe("quota_exceeded");

    const rows = await db.query("SELECT 1 FROM usage_reservations WHERE workspace_id = $1", [workspaceId]);
    expect(rows.rowCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 12 — the slot
  // -------------------------------------------------------------------------
  it("sits after EntitlementGuard and before DailyCapGuard and CreditGuard in the composition root", async () => {
    // security-and-tenancy.md §5's chain. Asserted here against the real
    // registration array as well as in api.module.spec.ts's live-invocation
    // test, because the order is what keeps the five refusals distinct: a
    // request refused by the plan must never first reserve credits.
    const source = await import("node:fs/promises").then(async (fs) =>
      fs.readFile(new URL("../../src/api/api.module.ts", import.meta.url), "utf8"),
    );
    const order = ["EntitlementGuard", "QuotaGuard", "DailyCapGuard", "RateLimitGuard", "CreditGuard"].map((name) =>
      source.indexOf(`useClass: ${name}`),
    );
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

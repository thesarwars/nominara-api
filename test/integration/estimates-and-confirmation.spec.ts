import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runEstimateResponseSchema } from "../../contracts/tracking/index.js";
import { CONFIRMED_CREDITS_HEADER, CreditGuard } from "../../src/api/guards/credit.guard.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { RunEstimateService } from "../../src/modules/tracking/run-estimate.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-074 — the two-step guard rail, end to end.
//
// ⚠ THE MARQUEE ASSERTION IS SCENARIO 5, and it is the one that cannot be
// faked: estimate on one plan, change the plan, execute with the figure that
// was shown. AC6 says "a customer is never charged a figure they did not
// see", and the only way to prove it is to make the figure go stale between
// the two calls and watch the execution refuse.

describe("STORY-074 · estimates, confirmation and price-changed", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    // `plans` and their entitlement matrices are seeded by migration 0002.
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE credit_ledger, credit_wallets, tracked_prompts, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    await setPlan("growth");
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, priority_prompt_limit)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 10)`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version,
                            cache_ttl_seconds, volatility_band, min_plan_key, status)
       VALUES ('perplexity', 'perplexity', 'v', 'api', '1.0.0', 86400, 'medium', 'free', 'active')`,
    );
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, sample_count)
       VALUES ($1, $2, 'perplexity', true, 1)`,
      [workspaceId, projectId],
    );
    for (const text of ["one", "two"]) {
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, text_hash,
                                      intent_archetype, funnel_stage, is_priority, status)
         VALUES (gen_random_uuid(), $1, $2, $3, sha256($4::bytea), 'recommendation', 'consideration', false, 'active')`,
        [workspaceId, projectId, text, Buffer.from(text, "utf8")],
      );
    }
  });

  async function setPlan(planKey: string): Promise<void> {
    const existing = await db.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
    if (existing.rowCount === 0) {
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, $3)", [
        workspaceId,
        `w-${randomUUID().slice(0, 8)}`,
        planKey,
      ]);
      return;
    }
    // ⚠ BUMPING `entitlement_version` IS WHAT A REAL PLAN CHANGE DOES, and
    // without it the resolver's memo would serve the old plan's price — the
    // test would then pass while proving nothing about a stale quote.
    await db.query(
      "UPDATE workspaces SET plan_key = $2, entitlement_version = entitlement_version + 1 WHERE id = $1",
      [workspaceId, planKey],
    );
  }

  async function fundWallet(included: number): Promise<void> {
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
       VALUES ($1, $2, 0, 0, (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 30)
       ON CONFLICT (workspace_id) DO UPDATE SET included_balance = $2`,
      [workspaceId, included],
    );
  }

  function estimateService(): RunEstimateService {
    return new RunEstimateService(new InMemoryCacheAdapter());
  }

  async function estimate() {
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
      estimateService().estimate(projectId),
    );
  }

  function guardContext(confirmed: number) {
    const req = {
      tenant: { workspaceId },
      headers: { [CONFIRMED_CREDITS_HEADER]: String(confirmed), "idempotency-key": `k-${randomUUID().slice(0, 8)}` },
    };
    return {
      req,
      context: {
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: () => undefined }) }),
      } as unknown as ExecutionContext,
    };
  }

  function guard(): CreditGuard {
    const reflector = { getAllAndOverride: () => "deep_scan" } as unknown as Reflector;
    // A FRESH resolver per call, each with its own cache: the memo is keyed
    // on entitlement version, and reusing one across a plan change would be
    // testing the memo rather than the guard.
    return new CreditGuard(reflector, new EntitlementResolver(new InMemoryCacheAdapter(), pool), pool);
  }

  // ───────────────────── scenarios 1, 2 and 13 ─────────────────────

  it("scenario 1 — returns the exact figure and the wallet either side of it", async () => {
    await fundWallet(2_400);
    const result = await estimate();

    // growth's `deep_scan.credits` is 200.
    expect(result.credits).toBe(200);
    expect(result.wallet).toMatchObject({ available: 2_400, after: 2_200, shortfall: null });
    expect(result.credits_charged).toBe(0);
  });

  it("satisfies the published contract", async () => {
    await fundWallet(2_400);
    expect(runEstimateResponseSchema.safeParse(await estimate()).success).toBe(true);
  });

  it("scenario 2 — a flat price is ONE number, with no range anywhere in the payload", async () => {
    // ⚠ FR-CRD-24. A range would imply arithmetic the customer has to do, and
    // the price is cache-independent — this asserts the payload cannot even
    // express one.
    await fundWallet(2_400);
    const result = await estimate();

    expect(typeof result.credits).toBe("number");
    const keys = Object.keys(result);
    expect(keys.filter((key) => /min|max|low|high|range|from|to/u.test(key))).toEqual([]);
  });

  it("scenario 13 — running it twice changes nothing: no reservation, no ledger entry", async () => {
    await fundWallet(2_400);
    const first = await estimate();
    const second = await estimate();

    expect(second).toEqual(first);
    const wallet = await db.query<{ reserved: string }>("SELECT reserved::text FROM credit_wallets WHERE workspace_id = $1", [
      workspaceId,
    ]);
    expect(wallet.rows[0]!.reserved).toBe("0");
    const ledger = await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [workspaceId]);
    expect(ledger.rowCount).toBe(0);
  });

  it("reports how many more scans the balance affords", async () => {
    await fundWallet(2_400);
    // §7's own wireframe figure: 2,400 at 200 a scan.
    expect((await estimate()).scans_affordable).toBe(12);
  });

  it("⚠ does not report a wallet-less workspace as broke", async () => {
    // `provisionWallet` runs on the first priced REQUEST, so a customer who
    // has never scanned has no row. Rendering that as "0 available" tells
    // them they cannot afford something they can.
    const result = await estimate();

    expect(result.wallet.available).toBe(1_200); // growth's included grant
    expect(result.wallet.after).toBe(1_000);
    expect(result.wallet.shortfall).toBeNull();
    // And the thresholds are evaluated against that, not against zero: a
    // wallet read as empty would have fired `balance_after_below_floor` too.
    expect(result.confirmation.reasons).not.toContain("balance_after_below_floor");
  });

  it("⚠ does not take a SECOND pool connection while the request already holds one", async () => {
    // ⚠ THE DEADLOCK THIS CAUGHT. `TenantContextInterceptor` checks a
    // connection out of `PG_POOL` and holds it in an open transaction for the
    // life of the request. The first version of this service then called
    // `EntitlementResolver.resolveForWorkspace`, which takes its own
    // connection from that same pool — the resolver's header says plainly it
    // is built to run in the guard chain "before TenantContextInterceptor has
    // opened anything".
    //
    // `createPgPool` sets no `connectionTimeoutMillis` and pg's default is
    // wait-forever, so at `max` concurrent estimates the pool deadlocks
    // PERMANENTLY — and `PG_POOL` serves every route, so the blast radius is
    // the whole API rather than this endpoint.
    //
    // A pool of ONE and two concurrent requests is the smallest shape that
    // reproduces it: if the estimate needs a second connection, the first
    // request can never get one and neither can finish.
    const tiny = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
    try {
      await fundWallet(2_400);
      const service = new RunEstimateService(new InMemoryCacheAdapter());

      const run = async (): Promise<number> => {
        const client = await tiny.connect();
        try {
          const result = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
            service.estimate(projectId),
          );
          return result.credits;
        } finally {
          client.release();
        }
      };

      // Sequential on a pool of one, because that is what a single connection
      // permits — the point is that ONE request completes without needing a
      // second connection. A version that did would hang here forever.
      const outcome = await Promise.race([
        (async () => [await run(), await run()])(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("pool deadlock")), 10_000)),
      ]);

      expect(outcome).toEqual([200, 200]);
    } finally {
      await tiny.end();
    }
  }, 30_000);

  it("⚠ names the shortfall rather than leaving a component to read it off a minus sign", async () => {
    // AC9 / FR-CST-04 — "the modal becomes a purchase step in place: the
    // shortfall and the tier-filtered options, never a dead end." `after`
    // goes negative here, which is honest for "what you would be left with"
    // and is NOT a balance; `shortfall` is that figure made explicit.
    await fundWallet(50);
    const result = await estimate();

    expect(result.wallet).toMatchObject({ available: 50, after: -150, shortfall: 150 });
    expect(result.scans_affordable).toBe(0);
  });

  it("⚠ refuses rather than reporting an enterprise workspace as broke", async () => {
    // ⚠ THE FAILURE THE SUBSTITUTION WAS SUPPOSED TO PREVENT, CAUSED BY IT.
    // `credits.included_per_cycle` is "custom" on enterprise — negotiated per
    // contract, not a number. Reading it as 0 rendered "0 available → −400
    // after · 0 more scans" and a purchase step to the largest account in the
    // product, on its very first estimate. An unknown grant is not zero.
    await setPlan("enterprise");
    await db.query("UPDATE workspaces SET entitlement_overrides = $2 WHERE id = $1", [
      workspaceId,
      JSON.stringify({ "deep_scan.credits": 400 }),
    ]);

    await expect(estimate()).rejects.toMatchObject({
      code: "feature_not_in_plan",
      details: { key: "credits.included_per_cycle" },
    });
  });

  it("serves an enterprise workspace normally once its wallet exists", async () => {
    // The refusal above is about the SUBSTITUTION, not about enterprise. With
    // a real wallet row there is nothing to substitute.
    await setPlan("enterprise");
    await db.query("UPDATE workspaces SET entitlement_overrides = $2 WHERE id = $1", [
      workspaceId,
      JSON.stringify({ "deep_scan.credits": 400 }),
    ]);
    await fundWallet(10_000);

    const result = await estimate();
    expect(result.credits).toBe(400);
    expect(result.wallet).toMatchObject({ available: 10_000, after: 9_600, shortfall: null });
  });

  it("⚠ does NOT disclose the wallet's bucket breakdown on a tracking:trigger route", async () => {
    // ⚠ PERMISSION BOUNDARY. This route is `tracking:trigger`, which a
    // MANAGER holds; `billing:read` is owner/admin only, and there is no
    // `GET /billing/wallet` at all. Shipping included/purchased/reserved here
    // would have made the estimate the one success-path route in the product
    // disclosing a wallet's internals a rank below the permission gating
    // them. §7's modal renders `available` and `after`; never the split.
    await fundWallet(2_400);
    const result = await estimate();

    expect(Object.keys(result.wallet).sort()).toEqual(["after", "available", "cycle_end", "shortfall"]);
  });

  // ───────────────────── scenarios 6 and 7 ─────────────────────

  it("scenario 6 — a comfortable scan on a funded wallet still confirms, because 200 is over the threshold", async () => {
    await fundWallet(10_000);
    expect((await estimate()).confirmation).toEqual({
      required: true,
      reasons: ["credits_above_threshold"],
    });
  });

  it("names depletion when the scan would leave the wallet nearly empty", async () => {
    await fundWallet(240);
    const { confirmation } = await estimate();

    expect(confirmation.reasons).toContain("balance_after_below_floor");
    expect(confirmation.reasons).toContain("large_share_of_balance");
  });

  it("⚠ scenario 7 — a zero-project tier cannot reach this action at all, which is a STRONGER answer than confirming", async () => {
    // ⚠ THE SCENARIO CANNOT BE DEMONSTRATED ON A DEEP SCAN, and pretending
    // otherwise would be the contrivance. free carries `projects.max = 0` AND
    // `deep_scan.credits = null`, so the estimate refuses with
    // `feature_not_in_plan` before any threshold is evaluated — that caller
    // has no projects to scan and the plan does not sell the action.
    //
    // §7's rule is implemented and exercised in
    // `test/unit/credits/confirmation.spec.ts`, where a zero-project tier
    // confirms a 1-credit action and even a 0-credit one. It becomes
    // reachable end to end when a priced action exists that such a tier CAN
    // take — the tools, STORY-081 onward. Recorded here rather than left for
    // someone to discover that this AC has no integration coverage.
    await setPlan("free");
    await fundWallet(10_000);

    await expect(estimate()).rejects.toMatchObject({ code: "feature_not_in_plan" });
  });

  // ─────────────────────── scenario 5 / AC6 ───────────────────────

  describe("⚠ scenario 5 — the plan changes between the quote and the click", () => {
    it("refuses the stale figure, names both numbers, and charges nothing", async () => {
      // ⚠ AC6, AND THE ONLY WAY TO PROVE IT. The customer saw growth's 200.
      // By the time they click, the workspace is on business, where a deep
      // scan is 500. Recomputing and charging 500 would be correct arithmetic
      // and a broken promise.
      await fundWallet(10_000);
      const quoted = (await estimate()).credits;
      expect(quoted).toBe(200);

      await setPlan("business");

      const { context } = guardContext(quoted);
      await expect(guard().canActivate(context)).rejects.toMatchObject({
        code: "price_changed",
        details: { shown: 200, recomputed: 500 },
      });

      // NOTHING MOVED. Not a reservation, not a ledger row.
      const wallet = await db.query<{ reserved: string; included_balance: string }>(
        "SELECT reserved::text, included_balance::text FROM credit_wallets WHERE workspace_id = $1",
        [workspaceId],
      );
      expect(wallet.rows[0]).toMatchObject({ reserved: "0", included_balance: "10000" });
      expect((await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rowCount).toBe(0);
    });

    it("carries a reason a person can act on, not just two numbers", async () => {
      await fundWallet(10_000);
      await setPlan("business");

      const { context } = guardContext(200);
      await expect(guard().canActivate(context)).rejects.toMatchObject({
        details: { reason: expect.stringContaining("deep_scan.credits") as unknown as string },
      });
    });

    it("scenario 4 — the figure from a FRESH estimate proceeds", async () => {
      await fundWallet(10_000);
      await setPlan("business");
      const requoted = (await estimate()).credits;
      expect(requoted).toBe(500);

      const { req, context } = guardContext(requoted);
      await expect(guard().canActivate(context)).resolves.toBe(true);
      expect(req).toHaveProperty("creditReservation");
    });

    it("⚠ refuses a fresh quote that does not match a STILL-OPEN reservation", async () => {
      // ⚠ THE HOLE IN AC6 THE REVIEW FOUND. The price check compared the
      // confirmed figure against TODAY's price; the re-attach path then
      // settles against what the standing reservation HOLDS. So a customer
      // whose first delivery reserved 500, who re-quoted after the price
      // dropped to 200 and echoed 200, passed the check and would have been
      // debited 500 — charged a figure they never saw, which is the one
      // thing AC6 forbids.
      await fundWallet(10_000);
      await setPlan("business");

      const key = `k-${randomUUID().slice(0, 8)}`;
      const deliver = (confirmed: number) => {
        const req = {
          tenant: { workspaceId },
          headers: { [CONFIRMED_CREDITS_HEADER]: String(confirmed), "idempotency-key": key },
        };
        return {
          req,
          context: {
            getHandler: () => undefined,
            getClass: () => undefined,
            switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: () => undefined }) }),
          } as unknown as ExecutionContext,
        };
      };

      // Delivery 1 reserves business's 500 and nothing settles it.
      await expect(guard().canActivate(deliver(500).context)).resolves.toBe(true);
      const held = await db.query<{ reserved: string }>(
        "SELECT reserved::text FROM credit_wallets WHERE workspace_id = $1",
        [workspaceId],
      );
      expect(held.rows[0]!.reserved).toBe("500");

      // The contracted price is renegotiated downwards, and the customer
      // re-quotes honestly.
      await setPlan("growth");
      expect((await estimate()).credits).toBe(200);

      // Re-delivering under the same key must refuse, naming the held amount.
      await expect(guard().canActivate(deliver(200).context)).rejects.toMatchObject({
        code: "price_changed",
        details: { shown: 200, recomputed: 500 },
      });

      // And nothing moved: the original hold is intact, not doubled.
      const after = await db.query<{ reserved: string }>(
        "SELECT reserved::text FROM credit_wallets WHERE workspace_id = $1",
        [workspaceId],
      );
      expect(after.rows[0]!.reserved).toBe("500");
    });

    it("re-attaches silently when the confirmed figure DOES match the held amount", async () => {
      // The ordinary redelivery — same key, same figure, nothing changed.
      // It must not be turned into a conflict by the check above.
      await fundWallet(10_000);
      const key = `k-${randomUUID().slice(0, 8)}`;
      const deliver = () => {
        const req = {
          tenant: { workspaceId },
          headers: { [CONFIRMED_CREDITS_HEADER]: "200", "idempotency-key": key },
        };
        return {
          req,
          context: {
            getHandler: () => undefined,
            getClass: () => undefined,
            switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: () => undefined }) }),
          } as unknown as ExecutionContext,
        };
      };

      await expect(guard().canActivate(deliver().context)).resolves.toBe(true);
      const second = deliver();
      await expect(guard().canActivate(second.context)).resolves.toBe(true);

      // One hold, not two.
      const wallet = await db.query<{ reserved: string }>(
        "SELECT reserved::text FROM credit_wallets WHERE workspace_id = $1",
        [workspaceId],
      );
      expect(wallet.rows[0]!.reserved).toBe("200");
    });

    it("scenario 3 — execution without the header is refused", async () => {
      await fundWallet(10_000);
      const req = { tenant: { workspaceId }, headers: { "idempotency-key": "k-1" } };
      const context = {
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: () => undefined }) }),
      } as unknown as ExecutionContext;

      await expect(guard().canActivate(context)).rejects.toMatchObject({ code: "validation_failed" });
    });
  });
});

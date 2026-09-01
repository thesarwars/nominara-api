import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProjectParam } from "../../src/api/decorators/project-param.decorator.js";
import { RequireEntitlement, RequireFeature } from "../../src/api/decorators/require-entitlement.decorator.js";
import { EntitlementGuard, EntitlementGuardMisconfiguredError } from "../../src/api/guards/entitlement.guard.js";
import type { WorkspaceScopedRequest } from "../../src/api/guards/workspace.guard.js";
import { DomainError } from "../../src/api/errors/domain-errors.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { MissingProjectScopeError, StructuralUsage } from "../../src/lib/entitlements/structural-usage.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-069 AC6, AC7, AC8 — test scenarios 7, 8 and 9.
//
// §9's two EntitlementGuard rows, and the note that matters most in practice:
// "a tier whose `exports.pdf_per_cycle` is `0` returns `403
// feature_not_in_plan`, not `429 quota_exceeded`. The remediation differs —
// upgrade versus wait — so the error must differ."
//
// Real Postgres, because both halves of a structural refusal are database
// facts: `limit` comes from resolution over the seeded plans, and `current`
// comes from counting real rows. A stubbed count would let an off-by-one in
// the count predicates pass — and those predicates (which prompt statuses
// occupy a slot, whether a suspended member holds a seat) are the part with
// judgement in them.

class CreateProjectRoute {
  @RequireEntitlement("projects.max")
  handler(): void {}
}

class CreatePromptRoute {
  @RequireEntitlement("prompts.max_per_project")
  @ProjectParam("projectId")
  handler(): void {}
}

class CreatePromptRouteWithoutProjectParam {
  @RequireEntitlement("prompts.max_per_project")
  handler(): void {}
}

class ExportPdfRoute {
  @RequireFeature("exports.pdf_per_cycle")
  handler(): void {}
}

class ShareLinkRoute {
  @RequireFeature("share_links.enabled")
  handler(): void {}
}

class SlackRoute {
  @RequireFeature("integrations.slack")
  handler(): void {}
}

class UngatedRoute {
  handler(): void {}
}

function makeContext(req: Partial<WorkspaceScopedRequest>, ctor: new () => object) {
  const proto = ctor.prototype as { handler?: () => void };
  return {
    getHandler: () => proto.handler ?? (() => undefined),
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as Parameters<EntitlementGuard["canActivate"]>[0];
}

interface Refusal {
  code: string;
  details: unknown;
  remediation: { kind: string } | undefined;
}

async function refusalFrom(run: () => Promise<unknown>): Promise<Refusal> {
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

describe("STORY-069 · EntitlementGuard: structural limits and feature flags never collapse", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let guard: EntitlementGuard;
  let workspaceId: string;
  let projectId: string;
  let seededPlans: Array<{ key: string; entitlements: unknown }>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });
    const seed = await db.query<{ key: string; entitlements: unknown }>("SELECT key, entitlements FROM plans");
    seededPlans = seed.rows;
  }, 240_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tracked_prompts, competitors, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = uuidV7();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    guard = new EntitlementGuard(
      new Reflector(),
      new EntitlementResolver(new InMemoryCacheAdapter(), pool),
      new StructuralUsage(pool),
    );
  });

  afterEach(async () => {
    for (const plan of seededPlans) {
      await db.query("UPDATE plans SET entitlements = $2 WHERE key = $1", [plan.key, JSON.stringify(plan.entitlements)]);
    }
  });

  async function addProjects(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await db.query(
        `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
         VALUES ($1, $2, $3, $4, 'https://example.com', 'example.com')`,
        [index === 0 ? projectId : uuidV7(), workspaceId, `P${String(index)}`, `p-${String(index)}`],
      );
    }
  }

  async function addPrompts(count: number, status = "active"): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await db.query(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
         VALUES ($1, $2, $3::text, sha256(convert_to($3::text, 'UTF8')), 'recommendation', 'consideration', $4)`,
        [workspaceId, projectId, `prompt ${String(index)}-${randomUUID()}`, status],
      );
    }
  }

  function request(): Partial<WorkspaceScopedRequest> & { params?: Record<string, string> } {
    return { tenant: { workspaceId, actorId: randomUUID() }, entitlementVersion: 1, params: { projectId } };
  }

  // -------------------------------------------------------------------------
  // No declaration — the guard is invisible
  // -------------------------------------------------------------------------
  it("a route declaring neither decorator passes without resolving anything", async () => {
    await expect(guard.canActivate(makeContext(request(), UngatedRoute))).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 7 — a structural limit
  // -------------------------------------------------------------------------
  it("allows the request while there is room", async () => {
    await addProjects(2); // Growth allows 3.
    await expect(guard.canActivate(makeContext(request(), CreateProjectRoute))).resolves.toBe(true);
  });

  it("refuses at the ceiling with the key, the limit, and the current count", async () => {
    await addProjects(3);

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), CreateProjectRoute)));

    expect(refusal.code).toBe("entitlement_exceeded");
    expect(refusal.details).toEqual({ key: "projects.max", limit: 3, current: 3 });
    // §9's remediation for a structural limit is an add-on OR an upgrade —
    // never "wait", which is what a quota refusal would have implied.
    expect(refusal.remediation).toEqual({ kind: "increase_limit" });
  });

  it("reports `current` as counted even when a downgrade has left it above the limit", async () => {
    await addProjects(5);
    await db.query("UPDATE workspaces SET plan_key = 'starter' WHERE id = $1", [workspaceId]); // 1 project

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), CreateProjectRoute)));

    expect(refusal.details).toEqual({ key: "projects.max", limit: 1, current: 5 });
  });

  it("an add-on raises the ceiling the guard enforces", async () => {
    // AC9 reaching the guard: the purchase is only real if it changes what the
    // guard allows, not merely what the payload reports.
    await addProjects(3);
    const subscriptionId = randomUUID();
    await db.query(
      `INSERT INTO subscriptions (id, workspace_id, plan_key, billing_interval, stripe_customer_id,
                                  stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'growth', 'monthly', 'cus_x', 'sub_x', 'active', now(), now() + interval '30 days')`,
      [subscriptionId, workspaceId],
    );
    await db.query(
      `INSERT INTO subscription_addons (workspace_id, subscription_id, kind, quantity, unit_price_usd,
                                        stripe_subscription_item_id)
       VALUES ($1, $2, 'extra_project', 1, 19.00, 'si_x')`,
      [workspaceId, subscriptionId],
    );

    await expect(guard.canActivate(makeContext(request(), CreateProjectRoute))).resolves.toBe(true);
  });

  it("an override raises the ceiling the guard enforces", async () => {
    await addProjects(3);
    await db.query(`UPDATE workspaces SET entitlement_overrides = '{"projects.max": 25}'::jsonb WHERE id = $1`, [
      workspaceId,
    ]);

    await expect(guard.canActivate(makeContext(request(), CreateProjectRoute))).resolves.toBe(true);
  });

  it("an unlimited ceiling never refuses and never counts", async () => {
    await db.query("UPDATE workspaces SET plan_key = 'enterprise' WHERE id = $1", [workspaceId]);
    await addProjects(40);

    await expect(guard.canActivate(makeContext(request(), CreateProjectRoute))).resolves.toBe(true);
  });

  it("the free tier's zero projects is a STRUCTURAL refusal, not a feature one", async () => {
    // The asymmetry AC7 turns on, seen from the other side. §3: "No project can
    // be created — `403 entitlement_exceeded` naming the tier that allows one."
    // Same zero as exports.pdf_per_cycle below, opposite code, because the two
    // keys mean different things.
    await db.query("UPDATE workspaces SET plan_key = 'free' WHERE id = $1", [workspaceId]);

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), CreateProjectRoute)));

    expect(refusal.code).toBe("entitlement_exceeded");
    expect(refusal.details).toEqual({ key: "projects.max", limit: 0, current: 0 });
  });

  // -------------------------------------------------------------------------
  // The per-project keys
  // -------------------------------------------------------------------------
  it("counts a per-project cap against the project the route names", async () => {
    await addProjects(1);
    await addPrompts(40); // Growth allows 40 per project.

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), CreatePromptRoute)));

    expect(refusal.details).toEqual({ key: "prompts.max_per_project", limit: 40, current: 40 });
  });

  it("an archived prompt does not occupy a slot; a paused one does", async () => {
    await addProjects(1);
    await addPrompts(39, "active");
    await addPrompts(10, "archived");
    await expect(guard.canActivate(makeContext(request(), CreatePromptRoute))).resolves.toBe(true);

    await addPrompts(1, "paused");
    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), CreatePromptRoute)));
    expect(refusal.details).toEqual({ key: "prompts.max_per_project", limit: 40, current: 40 });
  });

  it("a per-project key on a route with no @ProjectParam is refused rather than counted workspace-wide", async () => {
    await addProjects(1);

    await expect(
      guard.canActivate(makeContext(request(), CreatePromptRouteWithoutProjectParam)),
    ).rejects.toThrow(MissingProjectScopeError);
  });

  // -------------------------------------------------------------------------
  // Scenario 8 — a feature flag
  // -------------------------------------------------------------------------
  it("refuses an absent feature with the key and the minimum tier", async () => {
    await db.query("UPDATE workspaces SET plan_key = 'starter' WHERE id = $1", [workspaceId]);

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), ShareLinkRoute)));

    expect(refusal.code).toBe("feature_not_in_plan");
    expect(refusal.details).toEqual({ key: "share_links.enabled", min_plan: "growth" });
    expect(refusal.remediation).toEqual({ kind: "upgrade_plan" });
  });

  it("allows the feature on a tier that has it", async () => {
    await expect(guard.canActivate(makeContext(request(), ShareLinkRoute))).resolves.toBe(true);
  });

  it("min_plan is read from the plans table, not from a constant", async () => {
    // AC10 in miniature. Grant share links on starter and the reported minimum
    // tier must move with the data, with no redeploy.
    await db.query(
      `UPDATE plans
          SET entitlements = jsonb_set(entitlements, '{share_links.enabled,value}', '"5_active"'::jsonb)
        WHERE key = 'starter'`,
    );
    await db.query("UPDATE workspaces SET plan_key = 'free' WHERE id = $1", [workspaceId]);

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), ShareLinkRoute)));

    expect(refusal.details).toEqual({ key: "share_links.enabled", min_plan: "starter" });
  });

  it("a route gated on a feature no plan grants refuses to tell the caller to upgrade", async () => {
    // §1 rule 5 — a deferred entitlement renders nowhere, so no route should
    // gate on one. If one does, "upgrade" is a lie: no tier has it.
    const refusal = guard.canActivate(makeContext(request(), SlackRoute));

    await expect(refusal).rejects.toThrow(EntitlementGuardMisconfiguredError);
  });

  // -------------------------------------------------------------------------
  // Scenario 9 — the zero-cap trap (AC7)
  // -------------------------------------------------------------------------
  it("a tier whose export cap is ZERO gets the feature failure, not the quota failure", async () => {
    // §9: "The remediation differs — upgrade versus wait — so the error must
    // differ." Telling this customer to wait for a reset would be the worst of
    // the three outcomes: the reset will never help them.
    await db.query("UPDATE workspaces SET plan_key = 'starter' WHERE id = $1", [workspaceId]); // pdf_per_cycle 0

    const refusal = await refusalFrom(() => guard.canActivate(makeContext(request(), ExportPdfRoute)));

    expect(refusal.code).toBe("feature_not_in_plan");
    expect(refusal.code).not.toBe("quota_exceeded");
    expect(refusal.details).toEqual({ key: "exports.pdf_per_cycle", min_plan: "growth" });
    expect(refusal.remediation).toEqual({ kind: "upgrade_plan" });
  });

  it("a tier with a non-zero export cap passes the guard — exhaustion is QuotaGuard's to report", async () => {
    // Growth has 25. The guard's job ends at "the plan has this feature"; a
    // used-up allowance is §9's third row and a different code entirely.
    await expect(guard.canActivate(makeContext(request(), ExportPdfRoute))).resolves.toBe(true);
  });

  // -------------------------------------------------------------------------
  // Scenario 11 — a plan edit changes behaviour with no redeploy (AC11)
  // -------------------------------------------------------------------------
  it("editing a plan limit in the database changes what the guard allows, in the same process", async () => {
    // §2: "a plan change is a **data change with no redeploy**." The strongest
    // form of that claim is this one: the SAME guard instance, holding the
    // SAME memo, refuses and then allows — nothing reconstructed, nothing
    // restarted, no constant edited.
    await addProjects(3);

    const before = await refusalFrom(() => guard.canActivate(makeContext(request(), CreateProjectRoute)));
    expect(before.details).toEqual({ key: "projects.max", limit: 3, current: 3 });

    await db.query(
      `UPDATE plans SET entitlements = jsonb_set(entitlements, '{projects.max,value}', '10'::jsonb)
        WHERE key = 'growth'`,
    );
    // The version bump is the other half of the mechanism, not an extra step:
    // §8 says it bumps "on any plan, add-on, or override change", and without
    // it the memo would keep answering from the old plan for up to its TTL.
    await db.query("UPDATE workspaces SET entitlement_version = 2 WHERE id = $1", [workspaceId]);

    const after = { ...request(), entitlementVersion: 2 };
    await expect(guard.canActivate(makeContext(after, CreateProjectRoute))).resolves.toBe(true);
  });

  it("a plan edit WITHOUT a version bump is held off by the memo — which is what the version is for", async () => {
    // The negative case, so the bump above is not mistaken for decoration. A
    // plan edit that skipped the bump would take effect somewhere between
    // immediately and the TTL, non-deterministically — §8's own reason for
    // keying the memo by version, and unacceptable for a DOWNGRADE.
    await addProjects(3);
    await refusalFrom(() => guard.canActivate(makeContext(request(), CreateProjectRoute)));

    await db.query(
      `UPDATE plans SET entitlements = jsonb_set(entitlements, '{projects.max,value}', '10'::jsonb)
        WHERE key = 'growth'`,
    );

    const stillRefused = await refusalFrom(() => guard.canActivate(makeContext(request(), CreateProjectRoute)));
    expect(stillRefused.details).toEqual({ key: "projects.max", limit: 3, current: 3 });
  });

  // -------------------------------------------------------------------------
  // Fail closed
  // -------------------------------------------------------------------------
  it("refuses when no workspace is resolved rather than allowing the request", async () => {
    await expect(guard.canActivate(makeContext({ entitlementVersion: 1 }, CreateProjectRoute))).rejects.toThrow(
      EntitlementGuardMisconfiguredError,
    );
  });
});

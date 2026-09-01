import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { cacheKeyNamespace } from "../../src/lib/cache/key-namespace.js";
import { entitlementsKey } from "../../src/lib/cache/valkey-keys.js";
import { EntitlementResolver, ENTITLEMENT_MEMO_TTL_MS } from "../../src/lib/entitlements/entitlement-resolver.js";
import { EntitlementsController } from "../../src/modules/entitlements/entitlements.controller.js";
import { EntitlementsService } from "../../src/modules/entitlements/entitlements.service.js";
import { resolvedEntitlementsResponseSchema } from "../../contracts/entitlements/resolved-entitlements.schema.js";
import type { WorkspaceScopedRequest } from "../../src/api/guards/workspace.guard.js";
import {
  InvalidEntitlementOverridesError,
  UnknownWorkspaceError,
  resolveEntitlements,
} from "../../src/lib/entitlements/resolution.js";

// STORY-069 AC3, AC4, AC9, AC12 — test scenarios 2, 3, 4, 5, 6 and 10.
//
// Against a real database on purpose. The resolution order is expressed in SQL
// and jsonb (the add-on aggregate, the override merge, the plan join), and the
// one property that matters most — that an override is applied LAST, over an
// add-on, and not the other way round — is only observable when both are
// present on the same key at the same time. A stubbed plan record would let a
// wrong order pass.

const PLAN_GROWTH_PROJECTS_MAX = 3;
const PLAN_GROWTH_PROMPTS_PER_PROJECT = 40;
const PLAN_GROWTH_PROMPTS_TOTAL = 120;
const PLAN_GROWTH_SEATS_MAX = 7;

describe("STORY-069 · entitlement resolution: plan, then add-ons, then overrides", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let cache: InMemoryCacheAdapter;
  let resolver: EntitlementResolver;
  let workspaceId: string;
  let seededGrowth: Record<string, unknown>;

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
    const seed = await db.query<{ entitlements: Record<string, unknown> }>(
      "SELECT entitlements FROM plans WHERE key = 'growth'",
    );
    seededGrowth = seed.rows[0]!.entitlements;
  }, 240_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE subscription_addons, subscriptions, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    cache = new InMemoryCacheAdapter();
    resolver = new EntitlementResolver(cache, pool);
  });

  afterEach(async () => {
    // `plans` is seeded by migration 0002 and is edited in place by the
    // no-redeploy scenario. Restoring from the beforeAll snapshot here rather
    // than in that test keeps a failure there from leaking a mutated plan into
    // every later test.
    await db.query("UPDATE plans SET entitlements = $2 WHERE key = $1", ["growth", JSON.stringify(seededGrowth)]);
  });

  async function addSubscription(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO subscriptions (id, workspace_id, plan_key, billing_interval, stripe_customer_id,
                                  stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, 'growth', 'monthly', $3, $4, 'active', now(), now() + interval '30 days')`,
      [id, workspaceId, `cus_${id.slice(0, 8)}`, `sub_${id.slice(0, 8)}`],
    );
    return id;
  }

  async function addAddon(
    kind: "extra_project" | "extra_seat",
    quantity: number,
    options: { activeFrom?: string; activeUntil?: string } = {},
  ): Promise<void> {
    const subscriptionId = await addSubscription();
    await db.query(
      `INSERT INTO subscription_addons (workspace_id, subscription_id, kind, quantity, unit_price_usd,
                                        stripe_subscription_item_id, active_from, active_until)
       VALUES ($1, $2, $3, $4, 19.00, $5, COALESCE($6::timestamptz, now()), $7::timestamptz)`,
      [
        workspaceId,
        subscriptionId,
        kind,
        quantity,
        `si_${randomUUID().slice(0, 8)}`,
        options.activeFrom ?? null,
        options.activeUntil ?? null,
      ],
    );
  }

  async function setOverrides(overrides: Record<string, unknown>): Promise<void> {
    await db.query("UPDATE workspaces SET entitlement_overrides = $2 WHERE id = $1", [
      workspaceId,
      JSON.stringify(overrides),
    ]);
  }

  async function resolve() {
    return await resolver.resolveForWorkspace(workspaceId);
  }

  // -------------------------------------------------------------------------
  // Scenario 2 — resolve for a plain workspace
  // -------------------------------------------------------------------------
  it("a workspace with no add-ons and no overrides resolves to exactly its plan", async () => {
    const resolved = await resolve();

    expect(resolved.plan_key).toBe("growth");
    expect(resolved.entitlements["projects.max"]).toEqual({
      value: PLAN_GROWTH_PROJECTS_MAX,
      live: true,
      source: "plan",
      plan_value: PLAN_GROWTH_PROJECTS_MAX,
    });
    // Every key from the matrix, not the handful this test names — the payload
    // is what the whole interface renders from (AC5), so a partial resolution
    // is a defect even when the keys a screen happens to need are present.
    expect(Object.keys(resolved.entitlements)).toHaveLength(50);
  });

  it("a not-live key resolves with live:false even where the plan grants it", async () => {
    // `whitelabel.custom_domain` is the case the live flag exists for: a real
    // matrix row, and simultaneously in §2's not-live table.
    await db.query("UPDATE workspaces SET plan_key = 'business' WHERE id = $1", [workspaceId]);
    const resolved = await resolve();

    expect(resolved.entitlements["whitelabel.custom_domain"]).toEqual({
      value: true,
      live: false,
      source: "plan",
      plan_value: true,
    });
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — an add-on contributes
  // Scenario 10 — an extra project grants its prompt slots too (AC9)
  // -------------------------------------------------------------------------
  it("an extra-project add-on grants a project slot AND its prompt slots", async () => {
    await addAddon("extra_project", 1);
    const resolved = await resolve();

    expect(resolved.entitlements["projects.max"]).toEqual({
      value: PLAN_GROWTH_PROJECTS_MAX + 1,
      live: true,
      source: "add_on",
      plan_value: PLAN_GROWTH_PROJECTS_MAX,
    });

    // FR-CRD-05, and the half AC9 exists for. "A project you cannot put
    // prompts in is a broken purchase."
    expect(resolved.entitlements["prompts.max_total"]).toEqual({
      value: PLAN_GROWTH_PROMPTS_TOTAL + PLAN_GROWTH_PROMPTS_PER_PROJECT,
      live: true,
      source: "add_on",
      plan_value: PLAN_GROWTH_PROMPTS_TOTAL,
    });

    // The PER-project cap is untouched: the purchase bought one more project's
    // worth of room, not more room inside every existing project.
    expect(resolved.entitlements["prompts.max_per_project"]!.value).toBe(PLAN_GROWTH_PROMPTS_PER_PROJECT);
    expect(resolved.entitlements["prompts.max_per_project"]!.source).toBe("plan");
  });

  it("two extra projects grant two projects' worth of prompt slots", async () => {
    await addAddon("extra_project", 2);
    const resolved = await resolve();

    expect(resolved.entitlements["projects.max"]!.value).toBe(PLAN_GROWTH_PROJECTS_MAX + 2);
    expect(resolved.entitlements["prompts.max_total"]!.value).toBe(
      PLAN_GROWTH_PROMPTS_TOTAL + 2 * PLAN_GROWTH_PROMPTS_PER_PROJECT,
    );
  });

  it("an extra-seat add-on raises seats and touches nothing else", async () => {
    await addAddon("extra_seat", 3);
    const resolved = await resolve();

    expect(resolved.entitlements["seats.max"]!.value).toBe(PLAN_GROWTH_SEATS_MAX + 3);
    expect(resolved.entitlements["projects.max"]!.value).toBe(PLAN_GROWTH_PROJECTS_MAX);
    expect(resolved.entitlements["prompts.max_total"]!.value).toBe(PLAN_GROWTH_PROMPTS_TOTAL);
  });

  it("an ended add-on contributes nothing", async () => {
    await addAddon("extra_project", 1, { activeUntil: "2020-01-01T00:00:00Z" });
    const resolved = await resolve();

    expect(resolved.entitlements["projects.max"]!.value).toBe(PLAN_GROWTH_PROJECTS_MAX);
    expect(resolved.entitlements["projects.max"]!.source).toBe("plan");
  });

  it("an add-on that has not started yet contributes nothing", async () => {
    await addAddon("extra_project", 1, { activeFrom: "2099-01-01T00:00:00Z" });
    const resolved = await resolve();

    expect(resolved.entitlements["projects.max"]!.value).toBe(PLAN_GROWTH_PROJECTS_MAX);
  });

  // -------------------------------------------------------------------------
  // Scenario 4 — an override is applied LAST, and surfaced (AC3, AC12)
  // -------------------------------------------------------------------------
  it("an override wins over the plan and is surfaced with the plan's own figure", async () => {
    await setOverrides({ "projects.max": 25 });
    const resolved = await resolve();

    expect(resolved.entitlements["projects.max"]).toEqual({
      value: 25,
      live: true,
      source: "override",
      plan_value: PLAN_GROWTH_PROJECTS_MAX,
    });
  });

  it("an override wins over an add-on on the same key — the order is override LAST", async () => {
    // The one assertion that separates the specified order from its reverse.
    // Plan 3, add-on +1 = 4, override 25. Applied in §8's order the answer is
    // 25; applied the other way round it is 26, and a negotiated ceiling would
    // silently rise every time somebody bought a project slot.
    await addAddon("extra_project", 1);
    await setOverrides({ "projects.max": 25 });
    const resolved = await resolve();

    expect(resolved.entitlements["projects.max"]!.value).toBe(25);
    expect(resolved.entitlements["projects.max"]!.source).toBe("override");
  });

  it("an override to null is honoured rather than read as absent", async () => {
    // `null` is a real value in this encoding ("— / not applicable for that
    // tier"), so an override setting a key to null must apply. An `undefined`
    // check instead of a key check would silently drop it.
    await setOverrides({ "integrations.gsc": null });
    const resolved = await resolve();

    expect(resolved.entitlements["integrations.gsc"]).toEqual({
      value: null,
      live: true,
      source: "override",
      plan_value: true,
    });
  });

  it("an override cannot make a deferred entitlement live", async () => {
    // §1 rule 5: a deferred entitlement renders nowhere. Whether a feature has
    // been BUILT is a fact about the deployment, not a contract term, so an
    // override may raise the value and still leaves `live` false.
    await setOverrides({ "integrations.slack": true });
    const resolved = await resolve();

    expect(resolved.entitlements["integrations.slack"]).toEqual({
      value: true,
      live: false,
      source: "override",
      plan_value: null,
    });
  });

  it("an override naming a key that does not exist is refused, loudly", async () => {
    // AC12 is unachievable if a typo can be dropped in silence: the customer
    // would be capped at their plan's figure with nothing anywhere saying why.
    await setOverrides({ "project.max": 25 });

    const client = await pool.connect();
    try {
      await expect(resolveEntitlements(client, workspaceId)).rejects.toThrow(InvalidEntitlementOverridesError);
    } finally {
      client.release();
    }
  });

  it("a workspace that does not exist is refused rather than resolved to a default", async () => {
    const client = await pool.connect();
    try {
      await expect(resolveEntitlements(client, randomUUID())).rejects.toThrow(UnknownWorkspaceError);
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — memoised inside the window
  // Scenario 6 — a version bump is a fresh resolve
  // -------------------------------------------------------------------------
  it("resolving twice inside the memo window reads the database once", async () => {
    const first = await resolver.resolve(workspaceId, 1);

    // Change the answer underneath the memo WITHOUT bumping the version. A
    // second read of the database would see 25; the memo must not.
    await setOverrides({ "projects.max": 25 });

    const second = await resolver.resolve(workspaceId, 1);
    expect(second.entitlements["projects.max"]!.value).toBe(first.entitlements["projects.max"]!.value);
    expect(second.entitlements["projects.max"]!.value).toBe(PLAN_GROWTH_PROJECTS_MAX);
  });

  it("a version bump makes the next resolve fresh, with nothing invalidated by hand", async () => {
    await resolver.resolve(workspaceId, 1);

    await setOverrides({ "projects.max": 25 });
    await db.query("UPDATE workspaces SET entitlement_version = entitlement_version + 1 WHERE id = $1", [workspaceId]);

    // No invalidate() call anywhere — the version is IN the key, so the bump
    // moves the read to one nothing has written.
    const afterBump = await resolver.resolveForWorkspace(workspaceId);
    expect(afterBump.entitlement_version).toBe(2);
    expect(afterBump.entitlements["projects.max"]!.value).toBe(25);
  });

  it("the memo is written under the version the read returned, not the one asked for", async () => {
    // A bump landing between the caller establishing its version and the query
    // running. Asking at 1 must not stamp the version-2 values onto key 1.
    await db.query("UPDATE workspaces SET entitlement_version = 2 WHERE id = $1", [workspaceId]);
    await setOverrides({ "projects.max": 25 });

    const resolved = await resolver.resolve(workspaceId, 1);
    expect(resolved.entitlement_version).toBe(2);

    await setOverrides({ "projects.max": 99 });
    // Key 1 was never written, so this misses and re-reads rather than
    // returning the version-2 payload under a version-1 key.
    const again = await resolver.resolve(workspaceId, 1);
    expect(again.entitlements["projects.max"]!.value).toBe(99);
  });

  // -------------------------------------------------------------------------
  // AC5 — the one payload, through the actual handler
  // AC12 — an override reaching a client as something it can explain
  // -------------------------------------------------------------------------
  it("GET /billing/entitlements returns every key, the version, and where each value came from", async () => {
    await addAddon("extra_seat", 2);
    await setOverrides({ "projects.max": 25 });

    const controller = new EntitlementsController(new EntitlementsService(resolver));
    const body = await controller.resolved({
      tenant: { workspaceId, actorId: randomUUID() },
      entitlementVersion: 1,
    } as WorkspaceScopedRequest);

    // The response is its own contract's shape, not merely close to it — a
    // published client is generated from this schema.
    expect(resolvedEntitlementsResponseSchema.parse(body)).toEqual(body);

    expect(body.workspace_id).toBe(workspaceId);
    expect(body.plan_key).toBe("growth");
    expect(body.entitlement_version).toBe(1);
    expect(Object.keys(body.entitlements)).toHaveLength(50);

    // Three provenances in one payload, which is what makes the interface able
    // to say "your plan includes 3; your agreement raises it to 25" rather
    // than presenting an unexplained 25 for a Growth workspace.
    expect(body.entitlements["projects.max"]).toEqual({
      value: 25,
      live: true,
      source: "override",
      plan_value: PLAN_GROWTH_PROJECTS_MAX,
    });
    expect(body.entitlements["seats.max"]).toEqual({
      value: PLAN_GROWTH_SEATS_MAX + 2,
      live: true,
      source: "add_on",
      plan_value: PLAN_GROWTH_SEATS_MAX,
    });
    expect(body.entitlements["exports.csv"]!.source).toBe("plan");
  });

  it("the memo entry expires on its own", async () => {
    await resolver.resolve(workspaceId, 1);
    const ttl = await cache.timeToLiveMs(entitlementsKey(cacheKeyNamespace(), workspaceId, 1));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ENTITLEMENT_MEMO_TTL_MS);
  });
});

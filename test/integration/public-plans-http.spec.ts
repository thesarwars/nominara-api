import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_PLANS_WITHHELD_KEYS, publicPlansResponseSchema, type PublicPlansResponse } from "../../contracts/entitlements/public-plans.schema.js";
import { NOT_LIVE_KEYS } from "../../src/db/seed/plan-entitlements.js";
import { useApiHarness } from "../support/api-harness.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-103 (API part) - `GET /v1/public/plans` through the REAL ApiModule on the real nominara_app role: no cookie anywhere, the live
// filter over the seeded catalog, the withheld keys, cadence_by_plan from `engines`, and the `public_plans` rate class (burst 10).

describe("STORY-103 · GET /v1/public/plans over HTTP", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    runAsAppRole: true,
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }),
  });

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 240_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });

  const get = () => harness.app().inject({ method: "GET", url: apiUrl("/public/plans") });

  it("STORY-103 #1 an unauthenticated caller gets the contract-valid snapshot, cacheable, with no tenant context needed", async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=300");
    const body = dataOf<PublicPlansResponse>(response);
    expect(publicPlansResponseSchema.safeParse(body).success).toBe(true);
    expect(body.plans.map((p) => p.key)).toEqual(["free", "starter", "growth", "business", "enterprise"]);
    expect(body.plans.every((p) => p.currency === "USD")).toBe(true);
    expect(body.plans.find((p) => p.key === "growth")!.entitlements["price.monthly_usd"]).toBe(129);
  });

  it("STORY-103 #6/#8 a non-live key is absent for every plan, and flipping a key's live flag in the data changes the body with no code change", async () => {
    const before = dataOf<PublicPlansResponse>(await get());
    for (const plan of before.plans) for (const key of NOT_LIVE_KEYS) expect(key in plan.entitlements, `${plan.key}: ${key}`).toBe(false);
    expect("integrations.gsc" in before.plans.find((p) => p.key === "growth")!.entitlements).toBe(true);

    await harness.db().query(`UPDATE plans SET entitlements = jsonb_set(entitlements, '{integrations.gsc,live}', 'false') WHERE key = 'growth'`);
    const after = dataOf<PublicPlansResponse>(await get());
    expect("integrations.gsc" in after.plans.find((p) => p.key === "growth")!.entitlements).toBe(false);
    expect("integrations.gsc" in after.plans.find((p) => p.key === "business")!.entitlements).toBe(true);
  });

  it("STORY-103 review round 1 (AC1, FR-CRD-15) · the body carries the add-on rows from live data: public credit packs, and the extra project / extra seat with price, plans and grant", async () => {
    const body = dataOf<PublicPlansResponse>(await get());
    expect(publicPlansResponseSchema.safeParse(body).success).toBe(true);
    const packs = (await harness.db().query<{ key: string; credits: number; price_usd: string }>("SELECT key, credits, price_usd::text FROM credit_packs WHERE is_public ORDER BY sort_order, credits, key")).rows;
    expect(packs.length).toBeGreaterThan(0);
    expect(body.addons.credit_packs.map((p) => [p.key, p.credits, p.price])).toEqual(packs.map((p) => [p.key, p.credits, p.price_usd]));
    expect(JSON.stringify(body.addons)).not.toContain("stripe");

    const project = body.addons.subscription.find((a) => a.kind === "extra_project")!;
    expect(project).toMatchObject({ monthly_usd: "49.00", currency: "USD", available_on_plans: ["growth", "business"] });
    expect(project.grant_by_plan["growth"]!.statement).toMatch(/1 project and 40 prompt slots/);
    const seat = body.addons.subscription.find((a) => a.kind === "extra_seat")!;
    expect(seat).toMatchObject({ monthly_usd: "15.00", available_on_plans: ["starter", "growth", "business"] });
  });

  it("STORY-103 review round 1 · a non-public credit pack is absent, and flipping the plan flag in data changes the add-on rows with no code change", async () => {
    const [first] = (await harness.db().query<{ key: string }>("SELECT key FROM credit_packs WHERE is_public ORDER BY sort_order, credits, key LIMIT 1")).rows;
    await harness.db().query("UPDATE credit_packs SET is_public = false WHERE key = $1", [first!.key]);
    await harness.db().query(`UPDATE plans SET entitlements = jsonb_set(entitlements, '{projects.addon_allowed,value}', 'false') WHERE key = 'business'`);
    const body = dataOf<PublicPlansResponse>(await get());
    expect(body.addons.credit_packs.map((p) => p.key)).not.toContain(first!.key);
    expect(body.addons.subscription.find((a) => a.kind === "extra_project")!.available_on_plans).toEqual(["growth"]);
  });

  it("STORY-103 #9/#10 the fair-use ceiling and a deep scan's credit price are never in the body, on any plan", async () => {
    const response = await get();
    const text = response.body;
    for (const key of PUBLIC_PLANS_WITHHELD_KEYS) expect(text).not.toContain(key);
    expect(text).not.toContain("live");
  });

  it("STORY-103 #13 cadence_by_plan is the engines table's own, for each engine that can capture; a disabled engine is absent; a hidden plan is absent", async () => {
    await harness.db().query("UPDATE plans SET is_public = false WHERE key = 'enterprise'");
    const rows = (await harness.db().query<{ key: string; cadence_by_plan: unknown }>("SELECT key, cadence_by_plan FROM engines WHERE status <> 'disabled' ORDER BY key")).rows;
    const disabled = (await harness.db().query<{ key: string }>("SELECT key FROM engines WHERE status = 'disabled'")).rows.map((r) => r.key);
    expect(rows.length).toBeGreaterThan(0);
    expect(disabled.length).toBeGreaterThan(0);
    const body = dataOf<PublicPlansResponse>(await get());
    expect(body.engines.map((e) => [e.engine_key, e.cadence_by_plan])).toEqual(rows.map((r) => [r.key, r.cadence_by_plan]));
    for (const key of disabled) expect(body.engines.map((e) => e.engine_key)).not.toContain(key);
    expect(body.plans.map((p) => p.key)).not.toContain("enterprise");
  });

  it("STORY-103 the public_plans class answers 429 rate_limited after its burst of 10 from one address, and the refusal carries no plan data", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await get()).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    const refused = await get();
    expect(refused.statusCode).toBe(429);
    expect(refused.body).not.toContain("price.monthly_usd");
  });
});

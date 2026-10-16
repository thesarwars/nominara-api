import { describe, expect, it } from "vitest";
import { usePlanChangeFixture } from "../support/plan-change-fixture.js";

// STORY-184 scenario 28 — the `plan_change` rate class on the PRODUCTION defaults (the other plan-change specs widen it
// to the envelope's top so they can make more than two calls). Copied from the credit-pack purchase class (owner
// decision 2026-10-16): 5/hour per user, 10/hour per workspace, burst 2. The POST change and the DELETE cancel share it;
// the preview charges nothing and is an ordinary write.
describe("STORY-184 · the plan_change rate class", () => {
  const f = usePlanChangeFixture({ widenRateLimit: false });

  it("scenario 28 · the change and the cancel share a bucket of 3: the fourth rapid call from one user is 429 and never reaches Stripe", async () => {
    const { owner } = await f.newWorkspace("growth");
    const codes: number[] = [];
    codes.push((await f.post(owner, "/billing/subscription/change", { plan_key: "starter" })).statusCode); // schedules
    codes.push((await f.del(owner, "/billing/subscription/change")).statusCode); // cancels (same class)
    codes.push((await f.post(owner, "/billing/subscription/change", { plan_key: "starter" })).statusCode); // schedules again
    codes.push((await f.del(owner, "/billing/subscription/change")).statusCode); // fourth: refused
    codes.push((await f.post(owner, "/billing/subscription/change", { plan_key: "starter" })).statusCode);
    expect(codes).toEqual([202, 200, 202, 429, 429]);
    expect(f.gateway.downgrades).toHaveLength(2);
    expect(f.gateway.releases).toHaveLength(1);
  });

  it("scenario 28 · the PREVIEW has a class of its own (burst 5, 30/hour per user): five previews pass, the sixth is 429, and the change bucket is untouched", async () => {
    const { owner } = await f.newWorkspace("growth");
    const previews: number[] = [];
    for (let i = 0; i < 7; i++) previews.push((await f.post(owner, "/billing/subscription/change/preview", { plan_key: "starter" })).statusCode);
    expect(previews).toEqual([200, 200, 200, 200, 200, 429, 429]);
    // Its own bucket: the money-moving class still has its full burst.
    expect((await f.post(owner, "/billing/subscription/change", { plan_key: "starter" })).statusCode).toBe(202);
  });

  it("scenario 28 · a same-Idempotency-Key REPLAY is counted too (the rate guard runs before the idempotency interceptor): the fourth identical request is 429, not a free replay", async () => {
    const { owner } = await f.newWorkspace("growth");
    const key = "5f0c2f0e-1111-4c2b-9d51-0a1b2c3d4e5f";
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await f.post(owner, "/billing/subscription/change", { plan_key: "starter" }, key)).statusCode);
    expect(codes).toEqual([202, 202, 202, 429]);
    expect(f.gateway.downgrades).toHaveLength(1);
  });
});

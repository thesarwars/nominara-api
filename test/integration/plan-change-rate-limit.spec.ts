import { describe, expect, it } from "vitest";
import { usePlanChangeFixture } from "../support/plan-change-fixture.js";

// STORY-184 scenario 28 — the `plan_change` rate class on the PRODUCTION defaults (the other plan-change specs widen it
// to the envelope's top so they can make more than two calls). Copied from the credit-pack purchase class (owner
// decision 2026-10-16): 5/hour per user, 10/hour per workspace, burst 2. The POST change and the DELETE cancel share it;
// the preview charges nothing and is an ordinary write.
describe("STORY-184 · the plan_change rate class", () => {
  const f = usePlanChangeFixture({ widenRateLimit: false });

  it("scenario 28 · the third rapid change or cancel from one user is 429 rate_limited and never reaches Stripe; the preview is not counted", async () => {
    const { owner } = await f.newWorkspace("growth");
    // Previews are plain writes (60/min): ten of them leave the class untouched.
    for (let i = 0; i < 10; i++) expect((await f.post(owner, "/billing/subscription/change/preview", { plan_key: "starter" })).statusCode).toBe(200);

    const codes: number[] = [];
    codes.push((await f.post(owner, "/billing/subscription/change", { plan_key: "starter" })).statusCode); // schedules
    codes.push((await f.del(owner, "/billing/subscription/change")).statusCode); // cancels (same class)
    codes.push((await f.post(owner, "/billing/subscription/change", { plan_key: "starter" })).statusCode); // third: refused
    codes.push((await f.del(owner, "/billing/subscription/change")).statusCode);
    expect(codes).toEqual([202, 200, 429, 429]);
    expect(f.gateway.downgrades).toHaveLength(1);
    expect(f.gateway.releases).toHaveLength(1);
  });
});

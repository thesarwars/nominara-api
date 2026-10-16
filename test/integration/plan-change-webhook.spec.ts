import { Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { dataOf } from "../support/envelope.js";
import { PRICES, usePlanChangeFixture } from "../support/plan-change-fixture.js";
import { planChangePreviewResponseSchema } from "../../contracts/billing/index.js";

// STORY-184 T9 — THE WEBHOOK GATE. Until now a tracked subscription whose price differed from its frozen charge was
// refused. The in-app plan change adds exactly ONE way to a different price: the workspace's own pending_plan_change
// intent, matched three ways (intent id, target plan, subscription id). A subscription relabelled with no such intent (a
// Dashboard edit) is refused and alarmed. This is the dangerous-area change of the story: every test here either proves
// the one door opens for the right key, or that it stays shut for every wrong one.

describe("STORY-184 · the webhook honours only the workspace's own matching intent", () => {
  const f = usePlanChangeFixture();
  const { gateway, harness } = f;

  const PREVIEW = "/billing/subscription/change/preview";
  const CHANGE = "/billing/subscription/change";

  const charged = async (workspaceId: string) =>
    (await harness.db().query<{ charged_unit_amount_cents: number | null; charged_interval: string | null }>("SELECT charged_unit_amount_cents, charged_interval FROM subscriptions WHERE workspace_id = $1", [workspaceId])).rows[0]!;

  /** Writes an intent straight onto the row: the state the route leaves, without the route. */
  async function seedIntent(workspaceId: string, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const intent = {
      id: randomUUID(),
      direction: "upgrade",
      from_plan_key: "growth",
      to_plan_key: "business",
      billing_interval: "monthly",
      unit_amount_cents: PRICES.business.monthly,
      currency: "USD",
      effective: "immediate",
      effective_at: null,
      stripe_subscription_id: f.subIdOf(workspaceId),
      stripe_idempotency_key: `plan-change-${randomUUID()}`,
      proration_date: f.nowSeconds(),
      amount_due_now_cents: 1_000,
      schedule_id: null,
      created_at: new Date().toISOString(),
      settled_at: new Date().toISOString(),
      ...over,
    };
    await harness.db().query("UPDATE subscriptions SET pending_plan_change = $2::jsonb WHERE workspace_id = $1", [workspaceId, JSON.stringify(intent)]);
    return intent;
  }

  // ---- the two flows, end to end ------------------------------------------------------------------------------

  it("scenario 21 · an upgrade is adopted through its intent: the plan, the pro-rata top-up (once), the frozen charge, and the intent cleared", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    await f.walletFor(workspaceId, 450);
    const versionBefore = (await f.planOf(workspaceId)).entitlement_version;

    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: "growth" })));
    expect((await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(202);
    expect((await f.planOf(workspaceId)).plan_key, "the route itself changes nothing").toBe("starter");

    // Stripe applied the update (the fake moved the subscription); the signed event arrives.
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect(await f.planOf(workspaceId)).toMatchObject({ plan_key: "growth", ws_plan: "growth", entitlement_version: versionBefore + 1 });
    const topUps = (await f.ledgerRows(workspaceId)).filter((row) => row.reference_type === "plan_change");
    expect(topUps).toHaveLength(1);
    expect(topUps[0]!.credits).toBeGreaterThan(450);
    expect(topUps[0]!.credits).toBeLessThan(750);
    expect(await f.includedOf(workspaceId)).toBe(450 + topUps[0]!.credits);
    expect(await charged(workspaceId)).toEqual({ charged_unit_amount_cents: 12_900, charged_interval: "month" });
    expect(await f.intentOf(workspaceId), "adopted: the intent is spent").toBeNull();

    // A redelivery changes nothing and tops up nothing.
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.ledgerRows(workspaceId)).filter((row) => row.reference_type === "plan_change")).toHaveLength(1);
    expect((await f.planOf(workspaceId)).entitlement_version).toBe(versionBefore + 1);
  });

  it("scenario 22 · a downgrade is adopted at its cut-over: the plan, the wallet rolled to the TARGET grant, and the intent cleared", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    await f.walletFor(workspaceId, 1_200);
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    const call = gateway.downgrades[0]!;

    // Before the cut-over Stripe's phase-0 events still describe growth: nothing changes, and the intent is KEPT.
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("growth");
    expect(await f.intentOf(workspaceId)).not.toBeNull();

    // The cut-over: phase 1 starts. The plan line is the starter price, the phase's metadata replaced the subscription's, and a new period began.
    const start = f.periodEnd();
    f.stripeSubscription(workspaceId, { plan: "starter", metadata: { plan_change_intent_id: String(call.metadata.plan_change_intent_id) }, periodStart: start, periodEnd: start + 30 * 86_400 });
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect(await f.planOf(workspaceId)).toMatchObject({ plan_key: "starter", ws_plan: "starter" });
    expect(await f.includedOf(workspaceId), "rolled to starter's grant, not topped up").toBe(450);
    expect(await charged(workspaceId)).toEqual({ charged_unit_amount_cents: 4_900, charged_interval: "month" });
    expect(await f.intentOf(workspaceId)).toBeNull();
  });

  // ---- the gate stays shut ------------------------------------------------------------------------------------

  it("scenario 23 · a tracked subscription RELABELLED in the Dashboard (a dearer plan at that plan's real price, no intent) is refused and alarmed; nothing is granted", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    await f.walletFor(workspaceId, 1_200);
    const before = { plan: await f.planOf(workspaceId), included: await f.includedOf(workspaceId), ledger: await f.ledgerRows(workspaceId) };
    const alarm = vi.spyOn(Logger.prototype, "error");
    // The price AND the label both say business, and business really costs that: before this story the catalog vouched for it.
    f.stripeSubscription(workspaceId, { plan: "business" });
    expect((await f.reconcile(workspaceId)).statusCode, "refusing is a 2xx: a retry cannot fix a price").toBe(200);
    expect({ plan: await f.planOf(workspaceId), included: await f.includedOf(workspaceId), ledger: await f.ledgerRows(workspaceId) }).toEqual(before);
    expect(alarm, "a refused relabel is alarmed").toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("does not match its claimed plan") }));
  });

  it("scenario 23 · and a Dashboard DOWNGRADE with no intent is refused too: the customer keeps the plan they are tracked on", async () => {
    const { workspaceId } = await f.newWorkspace("business");
    const before = await f.planOf(workspaceId);
    f.stripeSubscription(workspaceId, { plan: "starter" });
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect(await f.planOf(workspaceId)).toEqual(before);
  });

  describe("scenario 24 · every way the intent can be wrong", () => {
    const relabelled = (workspaceId: string, over: Parameters<typeof f.stripeSubscription>[1] = {}) => f.stripeSubscription(workspaceId, { plan: "business", ...over });

    it("POSITIVE CONTROL · an intent whose id, target plan, subscription and price all match is adopted", async () => {
      const { workspaceId } = await f.newWorkspace("growth");
      const intent = await seedIntent(workspaceId);
      relabelled(workspaceId, { metadata: { plan_change_intent_id: String(intent.id) } });
      expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
      expect(await f.planOf(workspaceId)).toMatchObject({ plan_key: "business", ws_plan: "business" });
      expect(await f.intentOf(workspaceId)).toBeNull();
    });

    it("the charge verified is the INTENT'S frozen price, not today's catalog: an upgrade quoted before a catalog move is still adopted at the price the customer saw", async () => {
      const { workspaceId } = await f.newWorkspace("growth");
      // The customer was quoted (and Stripe charges) 300.00 for business; the catalog says 349.00 by the time the event lands.
      const intent = await seedIntent(workspaceId, { unit_amount_cents: 30_000 });
      relabelled(workspaceId, { amount: 30_000, metadata: { plan_change_intent_id: String(intent.id) } });
      expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
      expect(await f.planOf(workspaceId)).toMatchObject({ plan_key: "business" });
      expect(await charged(workspaceId)).toEqual({ charged_unit_amount_cents: 30_000, charged_interval: "month" });
    });

    it.each([
      ["the subscription carries no intent id", (intent: Record<string, unknown>) => ({ intent, metadata: {} })],
      ["the subscription carries a DIFFERENT intent id", (intent: Record<string, unknown>) => ({ intent, metadata: { plan_change_intent_id: randomUUID() } })],
      ["the intent targets another plan than the metadata claims", (intent: Record<string, unknown>) => ({ intent: { ...intent, to_plan_key: "starter" }, metadata: { plan_change_intent_id: String(intent.id) } })],
      ["the intent was recorded for a different Stripe subscription", (intent: Record<string, unknown>) => ({ intent: { ...intent, stripe_subscription_id: "sub_somebody_else" }, metadata: { plan_change_intent_id: String(intent.id) } })],
      ["the price charged is not the intent's frozen price", (intent: Record<string, unknown>) => ({ intent, metadata: { plan_change_intent_id: String(intent.id) }, amount: 30_000 })],
      ["the currency is not the intent's", (intent: Record<string, unknown>) => ({ intent: { ...intent, currency: "EUR" }, metadata: { plan_change_intent_id: String(intent.id) } })],
      ["the interval is not the intent's", (intent: Record<string, unknown>) => ({ intent: { ...intent, billing_interval: "annual" }, metadata: { plan_change_intent_id: String(intent.id) } })],
    ])("refused and alarmed when %s", async (_label, build) => {
      const { workspaceId } = await f.newWorkspace("growth");
      const base = await seedIntent(workspaceId);
      const { intent, metadata, amount } = build(base) as { intent: Record<string, unknown>; metadata: Record<string, string>; amount?: number };
      await seedIntent(workspaceId, intent);
      const before = await f.planOf(workspaceId);
      const alarm = vi.spyOn(Logger.prototype, "error");
      relabelled(workspaceId, { metadata, ...(amount === undefined ? {} : { amount }) });
      expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
      expect(await f.planOf(workspaceId)).toEqual(before);
      expect(alarm).toHaveBeenCalled();
      expect(await f.intentOf(workspaceId), "a refused event does not spend the intent").not.toBeNull();
    });

    it("ANOTHER workspace's intent id buys nothing: B's relabelled subscription carrying A's intent is refused, and A's intent is untouched", async () => {
      const a = await f.newWorkspace("growth");
      const b = await f.newWorkspace("growth");
      const intentA = await seedIntent(a.workspaceId);
      const beforeB = await f.planOf(b.workspaceId);
      relabelled(b.workspaceId, { metadata: { plan_change_intent_id: String(intentA.id) } });
      expect((await f.reconcile(b.workspaceId)).statusCode).toBe(200);
      expect(await f.planOf(b.workspaceId)).toEqual(beforeB);
      expect(await f.intentOf(a.workspaceId)).toMatchObject({ id: intentA.id });
      expect((await f.planOf(a.workspaceId)).plan_key).toBe("growth");
    });

    it("an intent is not a licence for any plan: the same valid intent does not adopt a THIRD plan at that plan's price", async () => {
      const { workspaceId } = await f.newWorkspace("starter");
      const intent = await seedIntent(workspaceId, { from_plan_key: "starter", to_plan_key: "growth", unit_amount_cents: PRICES.growth.monthly });
      f.stripeSubscription(workspaceId, { plan: "business", metadata: { plan_change_intent_id: String(intent.id) } });
      expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
      expect((await f.planOf(workspaceId)).plan_key).toBe("starter");
    });
  });

  it("an unrelated event for the plan the row already tracks (a phase-0 event while a downgrade is pending) keeps the intent", async () => {
    const { workspaceId } = await f.newWorkspace("business");
    const intent = await seedIntent(workspaceId, { direction: "downgrade", from_plan_key: "business", to_plan_key: "growth", unit_amount_cents: PRICES.growth.monthly, effective: "period_end" });
    f.stripeSubscription(workspaceId, { plan: "business", cancelAtPeriodEnd: false });
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("business");
    expect(await f.intentOf(workspaceId)).toMatchObject({ id: intent.id });
  });

  it("item 3 · a STALE fetch (taken before the upgrade was adopted) is skipped BEFORE it is judged: no false mismatch alarm for the customer's own upgrade", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const alarm = vi.spyOn(Logger.prototype, "error");
    // Event A fetches the subscription as it is NOW (starter) and is held before it can commit.
    const release = gateway.holdNextFetch("subscription", f.subIdOf(workspaceId));
    const fetchesBefore = gateway.fetches.length;
    const stale = f.reconcile(workspaceId);
    while (gateway.fetches.length === fetchesBefore) await new Promise((resolve) => setTimeout(resolve, 5));

    // The customer upgrades and event B (a newer fetch) adopts growth, spending the intent.
    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: "growth" })));
    expect((await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(202);
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("growth");
    expect(await f.intentOf(workspaceId)).toBeNull();

    // A's stale starter fetch now lands: it describes the old plan with no intent, which read as a relabel.
    release();
    expect((await stale).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key, "the stale event did not put the old plan back").toBe("growth");
    expect(alarm, "and it did not alarm").not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("does not match its claimed plan") }));
  });

  it("item 13 · adoption spends only the intent whose id the subscription names: a different (stale) intent for the same plan stays", async () => {
    const { workspaceId } = await f.newWorkspace("business");
    const other = await seedIntent(workspaceId, { direction: "downgrade", from_plan_key: "business", to_plan_key: "business", unit_amount_cents: PRICES.business.monthly });
    f.stripeSubscription(workspaceId, { plan: "business", metadata: { plan_change_intent_id: randomUUID() } });
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect(await f.intentOf(workspaceId)).toMatchObject({ id: other.id });
  });

  it("an ENDED subscription (cancelled) takes the plan away as always, and its stale intent goes with it", async () => {
    const { workspaceId } = await f.newWorkspace("business");
    await seedIntent(workspaceId, { direction: "downgrade", from_plan_key: "business", to_plan_key: "growth", unit_amount_cents: PRICES.growth.monthly, effective: "period_end" });
    f.stripeSubscription(workspaceId, { plan: "business", status: "canceled" });
    expect((await f.deliver(f.eventBody(`evt_${randomUUID()}`, "customer.subscription.deleted", f.subIdOf(workspaceId)))).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("free");
    expect(await f.intentOf(workspaceId)).toBeNull();
  });

  it("a malformed intent opens nothing: the relabel is refused", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    await harness.db().query("UPDATE subscriptions SET pending_plan_change = '{\"id\":\"x\"}'::jsonb WHERE workspace_id = $1", [workspaceId]);
    f.stripeSubscription(workspaceId, { plan: "business", metadata: { plan_change_intent_id: "x" } });
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("growth");
  });
});

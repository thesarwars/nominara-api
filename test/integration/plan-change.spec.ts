import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planChangeCancelResponseSchema, planChangePreviewResponseSchema, planChangeResponseSchema, subscriptionSchema } from "../../contracts/billing/index.js";
import { centsToDecimal } from "../../src/lib/billing/stripe/invoice-state.js";
import { StripeUpstreamError } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { dataOf } from "../support/envelope.js";
import { usePlanChangeFixture } from "../support/plan-change-fixture.js";

// STORY-184 — the in-app paid plan change, over the REAL ApiModule, real Postgres with RLS, and the fake Stripe gateway.
// Each test is named with the scenario it proves (the story's Test scenarios table); the rows below that are not scenarios
// are the hazards the plan named, each of which was mutation-checked.

const PREVIEW = "/billing/subscription/change/preview";
const CHANGE = "/billing/subscription/change";

describe("STORY-184 · in-app plan change", () => {
  const f = usePlanChangeFixture();
  const { gateway, harness } = f;

  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  const quoteOf = async (owner: Awaited<ReturnType<typeof f.newWorkspace>>["owner"], plan: string) => {
    const res = await f.post(owner, PREVIEW, { plan_key: plan });
    expect(res.statusCode, res.body).toBe(200);
    return planChangePreviewResponseSchema.parse(dataOf(res));
  };
  /** An upgrade end to end: preview, then change with the echoed quote. */
  const upgrade = async (owner: Awaited<ReturnType<typeof f.newWorkspace>>["owner"], plan: string, key?: string) => {
    const preview = await quoteOf(owner, plan);
    return await f.post(owner, CHANGE, { plan_key: plan, quote: preview.quote }, key);
  };

  // ---- previews ---------------------------------------------------------------------------------------------

  it("scenario 1 · an upgrade preview carries Stripe's figure as the quote, a LABELLED credit estimate, and changes nothing", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    await f.walletFor(workspaceId, 450);
    gateway.previewAmountCents = 5_025;
    const before = { plan: await f.planOf(workspaceId), intent: await f.intentOf(workspaceId), ledger: await f.ledgerRows(workspaceId) };

    const preview = await quoteOf(owner, "growth");
    expect(preview).toMatchObject({
      direction: "upgrade",
      current_plan_key: "starter",
      target_plan_key: "growth",
      billing_interval: "monthly",
      effective: "immediate",
      effective_at: null,
      amount_due_now: "50.25",
      currency: "USD",
      purchased_credits_kept: true,
      exceeds: [],
      blocked_by: null,
    });
    expect(preview.quote).toMatchObject({ amount_due_now: "50.25", currency: "USD" });
    // The figure is Stripe's: the preview was ASKED for at the quote's own instant, on the plan item only.
    expect(gateway.planPreviews).toHaveLength(1);
    expect(gateway.planPreviews[0]).toMatchObject({ subscriptionId: f.subIdOf(workspaceId), planItemId: "si_plan", prorationDate: preview.quote!.proration_date });
    expect(gateway.planPreviews[0]!.target).toMatchObject({ planKey: "growth", unitAmountCents: 12_900, interval: "month" });
    // Estimate: (1200 - 450) x ~20/30 of the cycle, floored, and labelled as an estimate.
    expect(preview.credit_estimate.basis).toBe("estimate");
    expect(preview.credit_estimate.top_up_now).toBeGreaterThan(450);
    expect(preview.credit_estimate.top_up_now).toBeLessThan(750);
    expect(preview.credit_estimate.grant_at_next_cycle).toBe(1_200);
    // Nothing was written, charged or granted.
    expect({ plan: await f.planOf(workspaceId), intent: await f.intentOf(workspaceId), ledger: await f.ledgerRows(workspaceId) }).toEqual(before);
    expect(gateway.upgradeAttempts).toHaveLength(0);
  });

  it("scenario 2 · a downgrade preview over the target's limits names the exact excess, newest projects first, and says blocked", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5); // oldest first: ids[4] is the newest
    const res = await f.post(owner, PREVIEW, { plan_key: "growth" });
    expect(res.statusCode, res.body).toBe(200);
    const preview = planChangePreviewResponseSchema.parse(dataOf(res));
    expect(preview).toMatchObject({ direction: "downgrade", effective: "period_end", amount_due_now: "0.00", quote: null, blocked_by: "exceeds_limits", purchased_credits_kept: true });
    expect(preview.effective_at).not.toBeNull();
    const structural = preview.exceeds.filter((e) => e.kind === "structural");
    expect(structural).toEqual([{ kind: "structural", key: "projects.max", limit: 3, current: 5, excess: 2, items: [{ id: ids[4], name: "P4" }, { id: ids[3], name: "P3" }] }]);
    expect(gateway.downgradeAttempts).toHaveLength(0);
  });

  it("scenario 3 · features lost and a shortened retention are named, never block, and are not 'exceeded' limits", async () => {
    const { owner } = await f.newWorkspace("business");
    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: "growth" })));
    expect(preview.blocked_by).toBeNull();
    expect(preview.exceeds.some((e) => e.kind === "feature_lost" && e.key === "whitelabel.email_digest")).toBe(true);
    expect(preview.exceeds).toContainEqual({ kind: "retention_shortened", key: "retention.raw_captures_days", from_days: 395, to_days: 180 });
    expect(preview.exceeds.filter((e) => e.kind === "structural")).toEqual([]);
  });

  it("scenario 3 · an add-on the target plan does not allow is named as dropped", async () => {
    const { owner } = await f.newWorkspace("growth", { held: [{ kind: "extra_project", quantity: 1 }] });
    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: "starter" })));
    expect(preview.exceeds).toContainEqual({ kind: "addon_dropped", addon: "extra_project", quantity: 1 });
  });

  // ---- the upgrade ----------------------------------------------------------------------------------------------

  it("scenario 4 · an upgrade with the echoed quote is 202 pending: the plan item ONLY, charged now, Stripe key from the intent, add-ons untouched, NOTHING local changes", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter", { held: [{ kind: "extra_seat", quantity: 2 }] });
    const before = await f.planOf(workspaceId);
    const res = await upgrade(owner, "growth");
    expect(res.statusCode, res.body).toBe(202);
    expect(planChangeResponseSchema.parse(dataOf(res))).toEqual({ status: "pending", direction: "upgrade", target_plan_key: "growth", effective: "immediate", effective_at: null });

    expect(gateway.upgrades).toHaveLength(1);
    const call = gateway.upgrades[0]!;
    const intent = (await f.intentOf(workspaceId))!;
    expect(call).toMatchObject({
      subscriptionId: f.subIdOf(workspaceId),
      planItemId: "si_plan",
      target: { planKey: "growth", unitAmountCents: 12_900, currency: "USD", interval: "month" },
      metadata: { plan_key: "growth", billing_interval: "monthly", plan_change_intent_id: intent.id },
      idempotencyKey: `plan-change-${String(intent.id)}`,
    });
    // The add-on line is still exactly as it was in Stripe: only the plan item was addressed.
    const lines = (gateway.objects.get(`subscription:${f.subIdOf(workspaceId)}`)!.raw as { items: { data: Array<{ id: string; quantity: number }> } }).items.data;
    expect(lines.find((l) => l.id === "si_extra_seat")?.quantity).toBe(2);
    // Settled intent, plan UNCHANGED locally until the webhook.
    expect(intent).toMatchObject({ direction: "upgrade", from_plan_key: "starter", to_plan_key: "growth", unit_amount_cents: 12_900, stripe_subscription_id: f.subIdOf(workspaceId) });
    expect(intent.settled_at).toBeTypeOf("string");
    expect(await f.planOf(workspaceId)).toEqual(before);
  });

  it("scenario 5 · the quote is ECHOED: a re-preview at the same instant that differs is 409 quote_changed, and nothing is charged or recorded", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    gateway.previewAmountCents = 5_000;
    const preview = await quoteOf(owner, "growth");
    gateway.previewAmountCents = 5_001; // Stripe's figure moved by a cent
    const res = await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "conflict", details: { reason: "quote_changed" } });
    expect(gateway.upgradeAttempts).toHaveLength(0);
    expect(await f.intentOf(workspaceId)).toBeNull();
    // The same instant was re-previewed (the re-preview is at the QUOTE's proration_date, not a fresh one).
    expect(gateway.planPreviews.at(-1)!.prorationDate).toBe(preview.quote!.proration_date);
  });

  it("scenario 5 · the same quote with the same figure is accepted (the comparison is on the amount, not on object identity)", async () => {
    const { owner } = await f.newWorkspace("starter");
    expect((await upgrade(owner, "growth")).statusCode).toBe(202);
  });

  it("scenario 6 · the proration date is bounded: older than 30 minutes, in the future, or before the period start is 409 quote_changed", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    const quote = preview.quote!;
    const cases: Array<[string, number]> = [
      ["31 minutes old", f.nowSeconds() - 31 * 60],
      ["an hour ahead", f.nowSeconds() + 3_600],
      ["before the period started", f.periodStart() - 1],
      ["near the period end (a cheap upgrade with a whole top-up)", f.periodEnd() - 5],
    ];
    for (const [label, prorationDate] of cases) {
      const res = await f.post(owner, CHANGE, { plan_key: "growth", quote: { ...quote, proration_date: prorationDate } });
      expect(res.statusCode, label).toBe(409);
      expect(errorOf(res).details, label).toMatchObject({ reason: "quote_changed" });
    }
    expect(gateway.upgradeAttempts).toHaveLength(0);
    expect(await f.intentOf(workspaceId)).toBeNull();
    // BOUNDARY: 29 minutes old is still a quote.
    const ok = await f.post(owner, CHANGE, { plan_key: "growth", quote: { ...quote, proration_date: f.nowSeconds() - 29 * 60 } });
    expect(ok.statusCode, ok.body).toBe(202);
  });

  it("scenario 5 · the re-preview is taken at the QUOTE's own instant (a 29-minute-old quote is re-priced at that moment, not at 'now')", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    // Stripe's figure depends on WHEN: a fresh-instant re-preview would price it differently and the quote would never hold.
    gateway.previewAmountCents = (input) => 1_000 + (input.prorationDate % 7_919);
    const oldInstant = f.nowSeconds() - 29 * 60;
    const quote = { proration_date: oldInstant, amount_due_now: centsToDecimal(1_000 + (oldInstant % 7_919)), currency: "USD" };
    const res = await f.post(owner, CHANGE, { plan_key: "growth", quote });
    expect(res.statusCode, res.body).toBe(202);
    expect(gateway.planPreviews.at(-1)!.prorationDate).toBe(oldInstant);
    expect(gateway.upgrades[0]!.prorationDate, "and the update is applied at the same instant it was quoted at").toBe(oldInstant);
    void workspaceId;
  });

  it("scenario 6 · a quote from before the PERIOD began is refused even when it is younger than 30 minutes (a period that began 5 minutes ago)", async () => {
    const start = f.nowSeconds() - 5 * 60;
    const { workspaceId, owner } = await f.newWorkspace("starter", { periodStart: start, periodEnd: start + 30 * 86_400 });
    const before = await f.post(owner, CHANGE, { plan_key: "growth", quote: { proration_date: start - 120, amount_due_now: centsToDecimal(3_850), currency: "USD" } });
    expect(before.statusCode).toBe(409);
    expect(errorOf(before).details).toMatchObject({ reason: "quote_changed" });
    expect(gateway.upgradeAttempts).toHaveLength(0);
    expect(await f.intentOf(workspaceId)).toBeNull();
    // Inside the period (and inside 30 minutes) it is a quote.
    const inside = await f.post(owner, CHANGE, { plan_key: "growth", quote: { proration_date: start + 60, amount_due_now: centsToDecimal(3_850), currency: "USD" } });
    expect(inside.statusCode, inside.body).toBe(202);
  });

  it("scenario 7 · an upgrade without a quote is 400 validation_failed naming the quote; the preview is not optional", async () => {
    const { owner } = await f.newWorkspace("starter");
    const res = await f.post(owner, CHANGE, { plan_key: "growth" });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(errorOf(res).details)).toContain("quote");
    expect(gateway.upgradeAttempts).toHaveLength(0);
  });

  it("scenario 8 · a declined card (or 3-D Secure) is 422 payment_failed and NOTHING changes: not the plan, the version, the wallet, or the intent", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    await f.walletFor(workspaceId, 450);
    const before = { plan: await f.planOf(workspaceId), ledger: await f.ledgerRows(workspaceId), included: await f.includedOf(workspaceId) };
    gateway.upgradeOutcome = "payment_failed";
    const res = await upgrade(owner, "growth");
    expect(res.statusCode, res.body).toBe(422);
    expect(errorOf(res)).toMatchObject({ code: "precondition_unmet", details: { reason: "payment_failed" } });
    expect(await f.intentOf(workspaceId)).toBeNull();
    expect({ plan: await f.planOf(workspaceId), ledger: await f.ledgerRows(workspaceId), included: await f.includedOf(workspaceId) }).toEqual(before);
    // A webhook for the (unchanged) subscription changes nothing either: there is no intent for it to honour.
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("starter");
    // And the customer can try again with a card that works.
    gateway.upgradeOutcome = "applied";
    expect((await upgrade(owner, "growth")).statusCode).toBe(202);
  });

  it("hazard · the reply of an APPLIED upgrade is lost: the retry replays the SAME Stripe key and charges ONCE; a different target meanwhile is plan_change_pending", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    gateway.failUpgradeAfterApplying = new StripeUpstreamError(504);
    const first = await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote }, randomUUID());
    expect(first.statusCode).toBe(503);
    expect(gateway.upgrades).toHaveLength(1); // Stripe did apply it
    const unsettled = (await f.intentOf(workspaceId))!;
    expect(unsettled.settled_at).toBeUndefined();

    // Another target while the first is unresolved: refused, not guessed at.
    const other = await f.post(owner, CHANGE, { plan_key: "business", quote: { ...preview.quote, amount_due_now: "10.00" } });
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).details).toMatchObject({ reason: "plan_change_pending" });

    gateway.failUpgradeAfterApplying = undefined;
    const retry = await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote }, randomUUID());
    expect(retry.statusCode, retry.body).toBe(202);
    expect(gateway.upgrades, "Stripe applied it once").toHaveLength(1);
    expect(gateway.upgradeAttempts).toHaveLength(2);
    expect(gateway.upgradeAttempts[1]!.idempotencyKey).toBe(gateway.upgradeAttempts[0]!.idempotencyKey);
    expect((await f.intentOf(workspaceId))!.settled_at).toBeTypeOf("string");
  });

  it("hazard · an upstream outage that applied nothing keeps the intent, and the retry (a new Idempotency-Key, the same quote) re-sends the same call", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    gateway.failUpgradeWith = new StripeUpstreamError(503);
    expect((await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(503);
    const kept = (await f.intentOf(workspaceId))!;
    expect(kept).not.toBeNull();
    expect(kept.settled_at).toBeUndefined();
    gateway.failUpgradeWith = undefined;
    expect((await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(202);
    expect(gateway.upgrades).toHaveLength(1);
    expect(gateway.upgradeAttempts.map((a) => a.idempotencyKey)).toEqual([`plan-change-${String(kept.id)}`, `plan-change-${String(kept.id)}`]);
  });

  it("hazard · a definite Stripe rejection (a 4xx that is not a conflict) releases the intent", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    gateway.failUpgradeWith = new StripeUpstreamError(400, "invalid_request_error");
    expect((await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(503);
    expect(await f.intentOf(workspaceId)).toBeNull();
  });

  it("hazard · the intent is COMMITTED before Stripe is asked (the webhook can arrive before the request returns), for an upgrade and for a downgrade", async () => {
    const up = await f.newWorkspace("starter");
    const preview = await quoteOf(up.owner, "growth");
    let seenByStripe: Record<string, unknown> | null = null;
    gateway.beforePlanChangeCall = async () => {
      // A connection of its own sees only what has COMMITTED: the request's own transaction is still open.
      seenByStripe = await f.intentOf(up.workspaceId);
    };
    expect((await f.post(up.owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(202);
    expect(seenByStripe).toMatchObject({ direction: "upgrade", to_plan_key: "growth" });
    expect((seenByStripe as unknown as Record<string, unknown>).settled_at, "unsettled at that instant: Stripe had not yet answered").toBeUndefined();

    const down = await f.newWorkspace("growth");
    seenByStripe = null;
    gateway.beforePlanChangeCall = async () => {
      seenByStripe = await f.intentOf(down.workspaceId);
    };
    expect((await f.post(down.owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    expect(seenByStripe).toMatchObject({ direction: "downgrade", to_plan_key: "starter" });
  });

  it("hazard · the SCHEDULE of a downgrade was created and the reply lost: the retry is a replay (not 'change_scheduled'), schedules ONCE, and the customer can see and cancel it meanwhile", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    gateway.failDowngradeAfterApplying = new StripeUpstreamError(504);
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(503);
    expect(gateway.downgrades).toHaveLength(1); // Stripe holds the schedule
    const unsettled = (await f.intentOf(workspaceId))!;
    expect(unsettled.settled_at).toBeUndefined();
    // The outcome is unknown, so the downgrade is SHOWN (it may happen at the period end) and can be cancelled.
    expect(subscriptionSchema.parse(dataOf(await f.get(owner, "/billing/subscription"))).pending_plan_change).toMatchObject({ direction: "downgrade", target_plan_key: "starter" });

    gateway.failDowngradeAfterApplying = undefined;
    const retry = await f.post(owner, CHANGE, { plan_key: "starter" });
    expect(retry.statusCode, retry.body).toBe(202);
    expect(gateway.downgrades, "one schedule, however many retries").toHaveLength(1);
    expect((await f.intentOf(workspaceId))!).toMatchObject({ id: unsettled.id, schedule_id: "sub_sched_1" });
  });

  it("hazard · an OLD unsettled downgrade while Stripe holds a schedule is never released as 'never applied': a different change is plan_change_pending and a cancel releases the schedule", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    gateway.failDowngradeAfterApplying = new StripeUpstreamError(504);
    await f.post(owner, CHANGE, { plan_key: "growth" });
    gateway.failDowngradeAfterApplying = undefined;
    await harness.db().query(
      "UPDATE subscriptions SET pending_plan_change = jsonb_set(pending_plan_change, '{created_at}', to_jsonb(to_char(now() - interval '1 hour', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE workspace_id = $1",
      [workspaceId],
    );
    const other = await f.post(owner, CHANGE, { plan_key: "starter" });
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).details).toMatchObject({ reason: "plan_change_pending" });
    expect(await f.intentOf(workspaceId)).not.toBeNull();

    const cancelled = await f.del(owner, CHANGE);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(gateway.releases.map((r) => r.scheduleId)).toEqual(["sub_sched_1"]);
    expect(await f.intentOf(workspaceId)).toBeNull();
  });

  it("MAJOR · a full cycle after a downgrade took effect the schedule is still attached: an UPGRADE is not locked out (the finished schedule is released first)", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    const intent = (await f.intentOf(workspaceId))!;
    cutOver(workspaceId, "starter", String(intent.id));
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("starter");
    expect(await f.intentOf(workspaceId)).toBeNull();
    gateway.finishedScheduleIds.add("sub_sched_1");

    const owner2 = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const res = await upgrade(owner2, "growth");
    expect(res.statusCode, res.body).toBe(202);
    expect(gateway.finishedReleases).toHaveLength(1);
    expect(gateway.upgrades).toHaveLength(1);
  });

  it("MAJOR (round 2) · the lost reply BETWEEN the schedule's create and its update leaves a ONE-phase schedule (with the subscription's metadata copied onto it): the replay COMPLETES it - never releases and replaces it", async () => {
    for (const copies of [true, false]) {
      const { workspaceId, owner } = await f.newWorkspace("growth");
      gateway.fromSubscriptionCopiesMetadata = copies;
      gateway.failDowngradeBetweenCreateAndUpdate = new StripeUpstreamError(504);
      expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(503);
      expect(gateway.downgrades, "the update never ran").toHaveLength(0);
      const created = [...gateway.schedules.keys()];
      expect(created).toHaveLength(1);
      expect(((await f.intentOf(workspaceId))!).settled_at).toBeUndefined();

      gateway.failDowngradeBetweenCreateAndUpdate = undefined;
      const retry = await f.post(owner, CHANGE, { plan_key: "starter" });
      expect(retry.statusCode, `copies metadata: ${String(copies)} · ${retry.body}`).toBe(202);
      expect(gateway.replacedSchedules, "the one-phase schedule was NOT mistaken for a finished one").toEqual([]);
      expect([...gateway.schedules.keys()], "and no second schedule was made").toEqual(created);
      expect(gateway.downgrades).toHaveLength(1);
      expect(((await f.intentOf(workspaceId))!)).toMatchObject({ settled_at: expect.any(String) });
      gateway.reset();
    }
  });

  it("MINOR (round 2) · the PREVIEW treats a finished schedule as non-blocking but does NOT release it; the change releases it", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    cutOver(workspaceId, "starter", String((await f.intentOf(workspaceId))!.id));
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    gateway.finishedScheduleIds.add("sub_sched_1");
    const owner2 = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const preview = await f.post(owner2, PREVIEW, { plan_key: "growth" });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(gateway.finishedReleases, "a preview changes nothing at Stripe").toHaveLength(0);
    const preview2 = planChangePreviewResponseSchema.parse(dataOf(preview));
    const change = await f.post(owner2, CHANGE, { plan_key: "growth", quote: preview2.quote });
    expect(change.statusCode, change.body).toBe(202);
    expect(gateway.finishedReleases).toHaveLength(1);
  });

  it("MAJOR · and while a schedule is NOT finished (an add-on removal still to come) the same upgrade is still change_scheduled", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    f.stripeSubscription(workspaceId, { plan: "starter", schedule: "sub_sched_addon" });
    const res = await f.post(owner, CHANGE, { plan_key: "growth", quote: { proration_date: f.nowSeconds(), amount_due_now: "38.50", currency: "USD" } });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "change_scheduled" });
    expect(errorOf(res).message).not.toMatch(/^an add-on removal/u); // it is not always an add-on removal
  });

  it("MAJOR · an ADD-ON purchase after the cut-over is not refused either", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    cutOver(workspaceId, "starter", String((await f.intentOf(workspaceId))!.id));
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    gateway.finishedScheduleIds.add("sub_sched_1");
    const owner2 = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const res = await f.post(owner2, "/billing/addons", { kind: "extra_seat", quantity: 1 });
    expect(res.statusCode, res.body).toBe(202);
    expect(gateway.finishedReleases).toHaveLength(1);
    expect(gateway.addonChanges).toHaveLength(1);
  });

  it("item 4 · the proration date is bounded by STRIPE'S current period start, not the local row's (a renewal the webhook has not applied)", async () => {
    const { owner, workspaceId } = await f.newWorkspace("starter");
    // Stripe renewed 5 minutes ago; the local row still has the old period (10 days back).
    f.stripeSubscription(workspaceId, { plan: "starter", periodStart: f.nowSeconds() - 300, periodEnd: f.nowSeconds() + 30 * 86_400 });
    const res = await f.post(owner, CHANGE, { plan_key: "growth", quote: { proration_date: f.nowSeconds() - 600, amount_due_now: centsToDecimal(3_850), currency: "USD" } });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "quote_changed" });
    expect(gateway.upgradeAttempts).toHaveLength(0);
  });

  it("item 5 · an unsettled intent OLDER than Stripe's key retention (24h) is NOT replayed: it is released and the request is validated as a new one", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    gateway.failUpgradeWith = new StripeUpstreamError(503);
    expect((await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(503);
    const old = (await f.intentOf(workspaceId))!;
    gateway.failUpgradeWith = undefined;
    await harness.db().query(
      "UPDATE subscriptions SET pending_plan_change = jsonb_set(pending_plan_change, '{created_at}', to_jsonb(to_char(now() - interval '25 hours', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE workspace_id = $1",
      [workspaceId],
    );
    const fresh = await quoteOf(owner, "growth");
    const res = await f.post(owner, CHANGE, { plan_key: "growth", quote: fresh.quote });
    expect(res.statusCode, res.body).toBe(202);
    const now = (await f.intentOf(workspaceId))!;
    expect(now.id, "a NEW intent, not the old one replayed").not.toBe(old.id);
    expect(gateway.upgradeAttempts.map((a) => a.idempotencyKey)).toEqual([`plan-change-${String(old.id)}`, `plan-change-${String(now.id)}`]);
  });

  it("item 5 · the reply of an applied upgrade is lost AND the webhook has already adopted the plan: the retry with the same quote is 202, not 400", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    gateway.failUpgradeAfterApplying = new StripeUpstreamError(504);
    expect((await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(503);
    expect((await f.reconcile(workspaceId)).statusCode).toBe(200);
    expect((await f.planOf(workspaceId)).plan_key).toBe("growth");
    expect(await f.intentOf(workspaceId)).toBeNull();
    gateway.failUpgradeAfterApplying = undefined;
    const owner2 = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    const retry = await f.post(owner2, CHANGE, { plan_key: "growth", quote: preview.quote });
    expect(retry.statusCode, retry.body).toBe(202);
    expect(gateway.upgrades, "Stripe was not asked again").toHaveLength(1);
    expect(gateway.upgradeAttempts).toHaveLength(1);
    // The same trace but ANOTHER quote (a different proration date) is not this request's change: 400.
    const other = await f.post(owner2, CHANGE, { plan_key: "growth", quote: { ...preview.quote, proration_date: preview.quote!.proration_date - 7 } });
    expect(other.statusCode, "a different quote is not a replay").toBe(400);
    expect(gateway.upgradeAttempts).toHaveLength(1);
    // A workspace on growth with NO such trace is still told it is already on that plan.
    const plain = await f.newWorkspace("growth");
    expect((await f.post(plain.owner, CHANGE, { plan_key: "growth", quote: preview.quote })).statusCode).toBe(400);
  });

  it("item 7 · the preview reports a pending change as plan_change_pending, ahead of the schedule it owns (not change_scheduled)", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    expect((await f.post(owner, CHANGE, { plan_key: "growth" })).statusCode).toBe(202);
    f.stripeSubscription(workspaceId, { plan: "business", schedule: "sub_sched_1" });
    const res = await f.post(owner, PREVIEW, { plan_key: "starter" });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "plan_change_pending" });
  });

  it("item 12 · a Free target is DESCRIBED whatever the state: past_due on Stripe's own state does not turn the preview into a refusal", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    f.stripeSubscription(workspaceId, { plan: "starter", status: "past_due" });
    const res = await f.post(owner, PREVIEW, { plan_key: "free" });
    expect(res.statusCode, res.body).toBe(200);
    expect(planChangePreviewResponseSchema.parse(dataOf(res)).blocked_by).toBe("cancel_in_portal");
  });

  it("hazard · two simultaneous upgrades (different Idempotency-Keys, one quote): exactly one is charged, the other is plan_change_pending", async () => {
    const { owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    const [a, b] = await Promise.all([
      f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote }, randomUUID()),
      f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote }, randomUUID()),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([202, 409]);
    expect(gateway.upgrades).toHaveLength(1);
  });

  it("hazard · an unsettled intent Stripe never saw, older than the in-flight window, is released and the new change proceeds", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    gateway.failUpgradeWith = new StripeUpstreamError(503);
    await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote });
    gateway.failUpgradeWith = undefined;
    await harness.db().query(
      "UPDATE subscriptions SET pending_plan_change = jsonb_set(pending_plan_change, '{created_at}', to_jsonb(to_char(now() - interval '1 hour', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE workspace_id = $1",
      [workspaceId],
    );
    // A DIFFERENT change: the old intent is older than the in-flight window and is not on Stripe's metadata, so it goes.
    const res = await upgrade(owner, "business");
    expect(res.statusCode, res.body).toBe(202);
    expect((await f.intentOf(workspaceId))!.to_plan_key).toBe("business");
  });

  // ---- the downgrade --------------------------------------------------------------------------------------------

  it("scenario 9 · a downgrade within limits is a schedule: metadata on BOTH phases' source, phase 1 = target plan + surviving add-ons, the unsupported add-on dropped, effective at the period end", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth", { held: [{ kind: "extra_seat", quantity: 2 }, { kind: "extra_project", quantity: 1 }] });
    await f.projects(workspaceId, 1);
    const res = await f.post(owner, CHANGE, { plan_key: "starter" });
    expect(res.statusCode, res.body).toBe(202);
    const body = planChangeResponseSchema.parse(dataOf(res));
    expect(body).toMatchObject({ status: "pending", direction: "downgrade", target_plan_key: "starter", effective: "period_end" });
    expect(body.effective_at).not.toBeNull();

    expect(gateway.downgrades).toHaveLength(1);
    const call = gateway.downgrades[0]!;
    const intent = (await f.intentOf(workspaceId))!;
    expect(call.target).toMatchObject({ planKey: "starter", unitAmountCents: 4_900, interval: "month" });
    // The seat survives (starter allows seats); the project add-on does not (starter allows none).
    expect(call.keepAddons).toEqual([{ priceId: "price_si_extra_seat", quantity: 2 }]);
    expect(call.metadata).toMatchObject({ workspace_id: workspaceId, plan_key: "starter", billing_interval: "monthly", plan_change_intent_id: intent.id });
    expect(call.idempotencyKey).toBe(`plan-change-${String(intent.id)}`);
    expect(intent).toMatchObject({ direction: "downgrade", to_plan_key: "starter", effective: "period_end", schedule_id: "sub_sched_1" });
    expect(intent.settled_at).toBeTypeOf("string");
    // Nothing local moved: it is a schedule, and the plan holds until the cut-over.
    expect((await f.planOf(workspaceId)).plan_key).toBe("growth");
  });

  it("scenario 10 · a downgrade above the target's limits is 409 downgrade_exceeds_limits with the EXACT list, and Stripe is never asked", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const ids = await f.projects(workspaceId, 5);
    const res = await f.post(owner, CHANGE, { plan_key: "growth" });
    expect(res.statusCode).toBe(409);
    const error = errorOf(res);
    expect(error.code).toBe("conflict");
    expect(error.details).toEqual({
      reason: "downgrade_exceeds_limits",
      excess: [{ kind: "structural", key: "projects.max", limit: 3, current: 5, excess: 2, items: [{ id: ids[4], name: "P4" }, { id: ids[3], name: "P3" }] }],
    });
    expect(gateway.downgradeAttempts).toHaveLength(0);
    expect(await f.intentOf(workspaceId)).toBeNull();
  });

  it("scenario 10 · BOUNDARY: usage exactly at the target's limit downgrades; one over is refused", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    await f.projects(workspaceId, 3);
    expect((await f.post(owner, CHANGE, { plan_key: "growth" })).statusCode).toBe(202);
    expect(gateway.downgrades).toHaveLength(1);
    const second = await f.newWorkspace("business");
    await f.projects(second.workspaceId, 4);
    expect((await f.post(second.owner, CHANGE, { plan_key: "growth" })).statusCode).toBe(409);
  });

  it("scenario 11 · a move to Free is never a plan change: the preview describes it, the change route points at the portal, whatever the usage", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    await f.projects(workspaceId, 1);
    const preview = planChangePreviewResponseSchema.parse(dataOf(await f.post(owner, PREVIEW, { plan_key: "free" })));
    expect(preview.blocked_by).toBe("cancel_in_portal");
    expect(preview.exceeds.some((e) => e.kind === "structural" && e.key === "projects.max")).toBe(true);

    const res = await f.post(owner, CHANGE, { plan_key: "free" });
    expect(res.statusCode).toBe(422);
    expect(errorOf(res)).toMatchObject({ code: "precondition_unmet", details: { reason: "cancel_in_portal" } });
    expect(gateway.downgradeAttempts).toHaveLength(0);

    // No usage at all: still the portal, never a schedule to Free.
    const empty = await f.newWorkspace("starter");
    expect(errorOf(await f.post(empty.owner, CHANGE, { plan_key: "free" })).details).toMatchObject({ reason: "cancel_in_portal" });
    expect(gateway.downgradeAttempts).toHaveLength(0);
  });

  it("scenario 12 · enterprise, the current plan and an unknown plan are 400 validation_failed", async () => {
    const { owner } = await f.newWorkspace("growth");
    for (const plan_key of ["enterprise", "growth", "scale"]) {
      expect((await f.post(owner, CHANGE, { plan_key })).statusCode, plan_key).toBe(400);
      expect((await f.post(owner, PREVIEW, { plan_key })).statusCode, plan_key).toBe(400);
    }
    expect(gateway.upgradeAttempts).toHaveLength(0);
  });

  it("scenario 13 · there is no interval switch: a request that names an interval is a 400, not a silent drop", async () => {
    const { owner } = await f.newWorkspace("starter");
    expect((await f.post(owner, PREVIEW, { plan_key: "growth", billing_interval: "annual" })).statusCode).toBe(400);
    expect((await f.post(owner, CHANGE, { plan_key: "growth", billing_interval: "annual" })).statusCode).toBe(400);
  });

  it("an ANNUAL subscription is priced on its own interval, from the annual catalog price", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter", { interval: "annual" });
    const res = await upgrade(owner, "growth");
    expect(res.statusCode, res.body).toBe(202);
    expect(gateway.upgrades[0]!.target).toMatchObject({ unitAmountCents: 129_000, interval: "year" });
    expect(gateway.upgrades[0]!.metadata.billing_interval).toBe("annual");
    expect((await f.intentOf(workspaceId))!.billing_interval).toBe("annual");
  });

  // ---- the state refusals ---------------------------------------------------------------------------------------

  it("scenario 14 · a past_due subscription cannot change plan: 409 subscription_past_due, on the preview and the change", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    await harness.db().query("UPDATE subscriptions SET status = 'past_due' WHERE workspace_id = $1", [workspaceId]);
    for (const [path, body] of [[PREVIEW, { plan_key: "growth" }], [CHANGE, { plan_key: "growth", quote: { proration_date: f.nowSeconds(), amount_due_now: "1.00", currency: "USD" } }]] as const) {
      const res = await f.post(owner, path, body);
      expect(res.statusCode, path).toBe(409);
      expect(errorOf(res).details, path).toMatchObject({ reason: "subscription_past_due" });
    }
    expect(gateway.upgradeAttempts).toHaveLength(0);
  });

  it("scenario 14 · and Stripe's own status wins over a lagging local row (fresh fetch past_due)", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    f.stripeSubscription(workspaceId, { plan: "starter", status: "past_due" });
    expect(errorOf(await f.post(owner, PREVIEW, { plan_key: "growth" })).details).toMatchObject({ reason: "subscription_past_due" });
  });

  it("scenario 15 · a subscription set to cancel at the period end cannot change plan: 409 cancellation_pending (the local row, and Stripe's own fresh state, each on their own)", async () => {
    const { workspaceId, ownerId } = await f.newWorkspace("starter");
    const body = (path: string) => (path === PREVIEW ? { plan_key: "growth" } : { plan_key: "growth", quote: { proration_date: f.nowSeconds(), amount_due_now: "1.00", currency: "USD" } });

    // (a) the LOCAL row says so, Stripe's fetch does not (the webhook lagged the other way).
    await harness.db().query("UPDATE subscriptions SET cancel_at_period_end = true WHERE workspace_id = $1", [workspaceId]);
    for (const path of [PREVIEW, CHANGE]) {
      const res = await f.post(await f.enter(ownerId, workspaceId), path, body(path));
      expect(res.statusCode, `local · ${path}`).toBe(409);
      expect(errorOf(res).details, `local · ${path}`).toMatchObject({ reason: "cancellation_pending" });
    }
    await harness.db().query("UPDATE subscriptions SET cancel_at_period_end = false WHERE workspace_id = $1", [workspaceId]);

    // (b) STRIPE says so, the local row does not yet (no webhook has landed).
    f.stripeSubscription(workspaceId, { plan: "starter", cancelAtPeriodEnd: true });
    for (const path of [PREVIEW, CHANGE]) {
      const res = await f.post(await f.enter(ownerId, workspaceId), path, body(path));
      expect(res.statusCode, `stripe · ${path}`).toBe(409);
      expect(errorOf(res).details, `stripe · ${path}`).toMatchObject({ reason: "cancellation_pending" });
    }
    expect(gateway.upgradeAttempts).toHaveLength(0);
  });

  it("scenario 16 · an add-on removal already scheduled on the subscription blocks both directions: 409 change_scheduled", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter", { held: [{ kind: "extra_seat", quantity: 1 }] });
    f.stripeSubscription(workspaceId, { plan: "starter", held: [{ kind: "extra_seat", quantity: 1 }], schedule: "sub_sched_addon" });
    expect(errorOf(await f.post(owner, PREVIEW, { plan_key: "growth" })).details).toMatchObject({ reason: "change_scheduled" });
    const down = await f.newWorkspace("growth");
    f.stripeSubscription(down.workspaceId, { plan: "growth", schedule: "sub_sched_addon" });
    expect(errorOf(await f.post(down.owner, CHANGE, { plan_key: "starter" })).details).toMatchObject({ reason: "change_scheduled" });
    expect(gateway.upgradeAttempts).toHaveLength(0);
    expect(gateway.downgradeAttempts).toHaveLength(0);
    void workspaceId;
  });

  it("scenario 17 · with a downgrade pending, an upgrade (and a second downgrade) is 409 plan_change_pending until it is cancelled", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    expect((await f.post(owner, CHANGE, { plan_key: "growth" })).statusCode).toBe(202);
    // Stripe now has the schedule on the subscription, as it would.
    f.stripeSubscription(workspaceId, { plan: "business", schedule: "sub_sched_1" });
    const up = await f.post(owner, CHANGE, { plan_key: "business", quote: { proration_date: f.nowSeconds(), amount_due_now: "1.00", currency: "USD" } });
    // (business is the current plan, so use a real upgrade target on a growth workspace below)
    expect(up.statusCode).toBe(400);
    const again = await f.post(owner, CHANGE, { plan_key: "starter" });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).details).toMatchObject({ reason: "plan_change_pending" });

    const g = await f.newWorkspace("growth");
    expect((await f.post(g.owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    f.stripeSubscription(g.workspaceId, { plan: "growth", schedule: "sub_sched_1" });
    const upgradeRes = await f.post(g.owner, CHANGE, { plan_key: "business", quote: { proration_date: f.nowSeconds(), amount_due_now: "1.00", currency: "USD" } });
    expect(upgradeRes.statusCode).toBe(409);
    expect(errorOf(upgradeRes).details).toMatchObject({ reason: "plan_change_pending" });
    expect(gateway.upgradeAttempts).toHaveLength(0);
  });

  it("an add-on removal while a downgrade is pending is 409 plan_change_pending (it would rewrite the downgrade's schedule)", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth", { held: [{ kind: "extra_seat", quantity: 1 }] });
    await harness.db().query("INSERT INTO subscription_addons (workspace_id, subscription_id, kind, quantity, unit_price_usd, stripe_subscription_item_id) SELECT $1, id, 'extra_seat', 1, 15, 'si_extra_seat' FROM subscriptions WHERE workspace_id = $1 ON CONFLICT DO NOTHING", [workspaceId]);
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    const removal = await f.del(owner, "/billing/addons/extra_seat");
    expect(removal.statusCode).toBe(409);
    expect(errorOf(removal).details).toMatchObject({ reason: "plan_change_pending" });
    expect(gateway.addonRemovals).toHaveLength(0);
  });

  // ---- cancel -------------------------------------------------------------------------------------------------

  it("scenario 18 · cancelling a scheduled downgrade releases the schedule, clears the intent, and the subscription read shows both states", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    const during = subscriptionSchema.parse(dataOf(await f.get(owner, "/billing/subscription")));
    expect(during.pending_plan_change).toMatchObject({ direction: "downgrade", target_plan_key: "starter" });
    expect(during.pending_plan_change!.effective_at).not.toBeNull();

    const res = await f.del(owner, CHANGE);
    expect(res.statusCode, res.body).toBe(200);
    expect(planChangeCancelResponseSchema.parse(dataOf(res))).toEqual({ status: "cancelled", target_plan_key: "starter" });
    expect(gateway.releases).toHaveLength(1);
    expect(gateway.releases[0]!.scheduleId).toBe("sub_sched_1");
    expect(await f.intentOf(workspaceId)).toBeNull();
    expect(subscriptionSchema.parse(dataOf(await f.get(owner, "/billing/subscription"))).pending_plan_change).toBeNull();
    // With the intent gone the customer can schedule again.
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
  });

  /** The cut-over as Stripe shows it: phase 1 is running (the plan line, the phase's metadata naming the intent, a new period), the schedule still attached. */
  const cutOver = (workspaceId: string, plan: "starter" | "growth", intentId: string) => {
    const start = f.nowSeconds() - 86_400; // a day ago
    f.stripeSubscription(workspaceId, { plan, metadata: { plan_change_intent_id: intentId }, schedule: "sub_sched_1", periodStart: start, periodEnd: start + 30 * 86_400 });
  };

  it("scenario 19 · with nothing pending a cancel is plan_change_not_pending", async () => {
    const { owner } = await f.newWorkspace("growth");
    const none = await f.del(owner, CHANGE);
    expect(none.statusCode).toBe(409);
    expect(errorOf(none).details).toMatchObject({ reason: "plan_change_not_pending" });
  });

  it("scenario 19 · a cancel AFTER the downgrade took effect (the subscription carries the intent) is 409 downgrade_already_effective and the intent is KEPT for the webhook", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    const intent = (await f.intentOf(workspaceId))!;
    cutOver(workspaceId, "starter", String(intent.id));
    const late = await f.del(owner, CHANGE);
    expect(late.statusCode, late.body).toBe(409);
    expect(errorOf(late).details).toMatchObject({ reason: "downgrade_already_effective" });
    expect(gateway.releases, "nothing was released: it had already run").toHaveLength(0);
    expect(await f.intentOf(workspaceId)).toMatchObject({ id: intent.id });
  });

  it("BLOCKER · the BOUNDARY RACE: release is applied while Stripe moves to phase 1 between our read and the release - re-read the subscription: 409 downgrade_already_effective, intent KEPT", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    const intent = (await f.intentOf(workspaceId))!;
    gateway.onReleaseApplied = () => cutOver(workspaceId, "starter", String(intent.id));
    const res = await f.del(owner, CHANGE);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "downgrade_already_effective" });
    expect(gateway.releases).toHaveLength(1);
    expect(await f.intentOf(workspaceId)).toMatchObject({ id: intent.id });
  });

  it("BLOCKER · release APPLIED and the reply lost: the retry is 200 (the schedule is gone and the subscription does not carry the intent) and the intent is null", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    gateway.failReleaseAfterApplying = new StripeUpstreamError(504);
    expect((await f.del(owner, CHANGE)).statusCode).toBe(503);
    expect(await f.intentOf(workspaceId), "outcome unknown: the intent stays").not.toBeNull();
    gateway.failReleaseAfterApplying = undefined;
    const retry = await f.del(owner, CHANGE);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(await f.intentOf(workspaceId)).toBeNull();
  });

  it("BLOCKER · a schedule released in the Stripe DASHBOARD is a successful cancel, not 'already effective'", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    // Someone released it in the Dashboard: the subscription has no schedule, still describes growth, and the schedule says released.
    f.stripeSubscription(workspaceId, { plan: "growth", schedule: null });
    gateway.releaseOutcome = "not_releasable";
    const res = await f.del(owner, CHANGE);
    expect(res.statusCode, res.body).toBe(200);
    expect(await f.intentOf(workspaceId)).toBeNull();
    // and the customer can schedule again
    gateway.releaseOutcome = "released";
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
  });

  it("BLOCKER · a schedule Stripe no longer has (resource_missing -> not releasable) on a subscription that does not carry the intent is 200", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    expect((await f.post(owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    gateway.releaseOutcome = "not_releasable"; // schedule still named on the subscription, but Stripe says it cannot be released
    const res = await f.del(owner, CHANGE);
    expect(res.statusCode, res.body).toBe(200);
    expect(await f.intentOf(workspaceId)).toBeNull();
  });

  it("scenario 19 · an upgrade cannot be cancelled: it is already charged (409 plan_change_pending)", async () => {
    const { owner } = await f.newWorkspace("starter");
    expect((await upgrade(owner, "growth")).statusCode).toBe(202);
    const res = await f.del(owner, CHANGE);
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "plan_change_pending" });
    expect(gateway.releases).toHaveLength(0);
  });

  // ---- permissions, audit, idempotency, isolation ---------------------------------------------------------------------

  it("scenario 26 · billing:write is required on all three routes (403 naming it); owner and admin pass with no step-up", async () => {
    const { workspaceId, owner } = await f.newWorkspace("business");
    const admin = await f.memberIn(workspaceId, "admin");
    for (const role of ["manager", "viewer"] as const) {
      const member = await f.memberIn(workspaceId, role);
      for (const res of [await f.post(member, PREVIEW, { plan_key: "growth" }), await f.post(member, CHANGE, { plan_key: "growth" }), await f.del(member, CHANGE)]) {
        expect(res.statusCode, role).toBe(403);
        expect(errorOf(res)).toMatchObject({ code: "forbidden", details: { required_permission: "billing:write" } });
      }
    }
    expect(gateway.downgradeAttempts).toHaveLength(0);
    expect((await f.post(admin, PREVIEW, { plan_key: "growth" })).statusCode).toBe(200);
    expect((await f.post(owner, PREVIEW, { plan_key: "growth" })).statusCode).toBe(200);
    const byAdmin = await f.post(admin, CHANGE, { plan_key: "growth" });
    expect(byAdmin.statusCode, byAdmin.body).toBe(202);
    const byOwner = await f.del(owner, CHANGE);
    expect(byOwner.statusCode, byOwner.body).toBe(200);
  });

  it("scenario 27 · the change and the cancel are each audited against the workspace; the preview is audited as `previewed` (a mutating verb must be), never as a request", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    await f.post(owner, PREVIEW, { plan_key: "starter" });
    expect(await f.auditActions(workspaceId, "billing.plan_change.previewed")).toHaveLength(1);
    expect(await f.auditActions(workspaceId, "billing.plan_change.requested")).toHaveLength(0);
    await f.post(owner, CHANGE, { plan_key: "starter" });
    expect(await f.auditActions(workspaceId, "billing.plan_change.requested")).toHaveLength(1);
    await f.del(owner, CHANGE);
    expect(await f.auditActions(workspaceId, "billing.plan_change.cancelled")).toHaveLength(1);
  });

  it("scenario 27 · the same Idempotency-Key replays the stored answer: one Stripe upgrade, one audit row", async () => {
    const { workspaceId, owner } = await f.newWorkspace("starter");
    const preview = await quoteOf(owner, "growth");
    const key = randomUUID();
    const first = await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote }, key);
    const second = await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote }, key);
    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(gateway.upgradeAttempts).toHaveLength(1);
    expect(await f.auditActions(workspaceId, "billing.plan_change.requested")).toHaveLength(1);
    // The change route refuses a missing key.
    expect((await f.post(owner, CHANGE, { plan_key: "growth", quote: preview.quote }, null)).statusCode).toBe(400);
  });

  it("scenario 30 · checkout on an already-subscribed workspace names the in-app change", async () => {
    const { owner } = await f.newWorkspace("starter");
    const res = await f.post(owner, "/billing/checkout-session", { plan_key: "business", billing_interval: "monthly" });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res).message).toMatch(/Settings > Plan/u);
    expect(gateway.checkouts).toHaveLength(0);
  });

  it("tenant isolation · another workspace's pending downgrade neither blocks nor leaks into this workspace", async () => {
    const a = await f.newWorkspace("growth");
    const b = await f.newWorkspace("growth");
    expect((await f.post(a.owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    expect(await f.intentOf(b.workspaceId)).toBeNull();
    expect(subscriptionSchema.parse(dataOf(await f.get(b.owner, "/billing/subscription"))).pending_plan_change).toBeNull();
    expect((await f.post(b.owner, CHANGE, { plan_key: "starter" })).statusCode).toBe(202);
    // The change addressed B's OWN subscription, never A's.
    expect(gateway.downgrades.map((d) => d.subscriptionId).sort()).toEqual([f.subIdOf(a.workspaceId), f.subIdOf(b.workspaceId)].sort());
  });

  it("fail closed · a subscription whose Stripe metadata names another workspace is refused before any change", async () => {
    const { workspaceId, owner } = await f.newWorkspace("growth");
    f.stripeSubscription(workspaceId, { plan: "growth", metadata: { workspace_id: randomUUID() } });
    const res = await f.post(owner, CHANGE, { plan_key: "starter" });
    expect(res.statusCode).toBe(422);
    expect(gateway.downgradeAttempts).toHaveLength(0);
  });

  it("fail closed · unconfigured Stripe is 503 and an outage is a 503 carrying no Stripe text; a workspace with no paid subscription is 422", async () => {
    const { owner } = await f.newWorkspace("growth");
    gateway.configured = false;
    expect((await f.post(owner, PREVIEW, { plan_key: "starter" })).statusCode).toBe(503);
    gateway.configured = true;
    gateway.failFetchWith = new StripeUpstreamError(500);
    const outage = await f.post(owner, PREVIEW, { plan_key: "starter" });
    expect(outage.statusCode).toBe(503);
    expect(outage.body).not.toMatch(/stripe request failed/iu);
    gateway.failFetchWith = undefined;

    const ownerId = await f.createUser();
    const free = await harness.db().query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ('F', $1, 'free') RETURNING id", [`f-${randomUUID().slice(0, 8)}`]);
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,'owner','active')", [free.rows[0]!.id, ownerId]);
    await harness.db().query(
      `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1,'free','monthly','','','active', now(), now() + interval '30 days')`,
      [free.rows[0]!.id],
    );
    const actor = await f.enter(ownerId, free.rows[0]!.id);
    expect((await f.post(actor, PREVIEW, { plan_key: "growth" })).statusCode).toBe(422);
  });
});

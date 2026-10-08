import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PLAN_ENTITLEMENTS } from "../../db/seed/plan-entitlements.js";
import { StripeUpstreamError, type StripeGateway } from "../../lib/billing/stripe/stripe-gateway.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { BillingAddonsService } from "./billing-addons.service.js";

// STORY-076b — the service's decisions against a scripted database client (no
// Postgres): the ORDER of its checks (refuse before Stripe), the arithmetic of
// the total, and the reconciler's write set. The real-database proof of the
// same criteria is test/integration/billing-addons.spec.ts.

const append = vi.hoisted(() => vi.fn((..._args: unknown[]) => Promise.resolve()));
vi.mock("../audit/audit-chain.service.js", () => ({ AuditChainService: class { append = append; } }));

type Script = Array<[RegExp, unknown[] | ((params: unknown[]) => unknown[])]>;

function client(script: Script): ClientBase & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const hit = script.find(([re]) => re.test(sql));
      const rows = hit === undefined ? [] : typeof hit[1] === "function" ? hit[1](params) : hit[1];
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as ClientBase & { calls: Array<{ sql: string; params: unknown[] }> };
}

function gateway(over: Partial<StripeGateway> = {}): StripeGateway & { changes: unknown[]; removals: unknown[]; fetches: string[] } {
  const changes: unknown[] = [];
  const removals: unknown[] = [];
  const fetches: string[] = [];
  return {
    changes,
    removals,
    fetches,
    isConfigured: () => true,
    fetchObject: (kind: string, id: string) => {
      fetches.push(`${kind}:${id}`);
      return Promise.resolve({ kind, id, metadata: {}, raw: { items: { data: [] } } });
    },
    changeAddonQuantity: (input: unknown) => {
      changes.push(input);
      return Promise.resolve();
    },
    scheduleAddonRemoval: (input: unknown) => {
      removals.push(input);
      return Promise.resolve();
    },
    ...over,
  } as unknown as StripeGateway & { changes: unknown[]; removals: unknown[]; fetches: string[] };
}

const WS = "00000000-0000-7000-8000-000000000001";
const planRow = (plan: keyof typeof PLAN_ENTITLEMENTS) => [{ plan_key: plan, entitlements: PLAN_ENTITLEMENTS[plan] }];
const subRow = (over: Record<string, unknown> = {}) => [
  { plan_key: "growth", billing_interval: "monthly", provider: "stripe", stripe_subscription_id: "sub_1", current_period_end: new Date("2026-11-01T00:00:00Z"), ...over },
];
const inTenant = <T>(c: ClientBase, fn: () => Promise<T>): Promise<T> => withTenantContext(c, { workspaceId: WS, actorId: WS }, fn);

describe("STORY-076b · add (the handler changes Stripe and writes nothing local)", () => {
  const base: Script = [
    [/FROM workspaces w JOIN plans/u, planRow("growth")],
    [/FROM subscriptions WHERE workspace_id/u, subRow()],
  ];

  it("AC1 · sets the item to the requested TOTAL from a FRESH fetch, and issues no INSERT/UPDATE of its own", async () => {
    const gw = gateway({
      fetchObject: (kind: string, id: string) =>
        Promise.resolve({
          kind,
          id,
          metadata: {},
          raw: { items: { data: [{ id: "si_seat", quantity: 3, price: { unit_amount: 1500, currency: "usd", product: { metadata: { nominara_kind: "extra_seat" } } } }] } },
        }),
    } as never);
    const c = client(base);
    const out = await inTenant(c, () => new BillingAddonsService(gw).add({ kind: "extra_seat", quantity: 5 }, "key-1"));
    expect(out).toMatchObject({ kind: "extra_seat", status: "pending", quantity_requested: 5, effective: "immediate" });
    expect(gw.changes).toEqual([expect.objectContaining({ quantity: 5, existingItemId: "si_seat", unitAmountCents: 1500, currency: "usd", interval: "month", proration: "create_prorations" })]);
    expect(c.calls.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/iu.test(sql))).toEqual([]);
  });

  it("AC1 boundary · a total of exactly the cap is accepted, one over is a 400 and Stripe is not called", async () => {
    const held = (quantity: number) =>
      gateway({
        fetchObject: (kind: string, id: string) =>
          Promise.resolve({ kind, id, metadata: {}, raw: { items: { data: [{ id: "si", quantity, price: { unit_amount: 4900, currency: "usd", product: { metadata: { nominara_kind: "extra_project" } } } }] } } }),
      } as never);
    const ok = held(99);
    expect((await inTenant(client(base), () => new BillingAddonsService(ok).add({ kind: "extra_project", quantity: 100 }, "key-1"))).quantity_requested).toBe(100);
    const over = held(100);
    await expect(inTenant(client(base), () => new BillingAddonsService(over).add({ kind: "extra_project", quantity: 101 }, "key-1"))).rejects.toMatchObject({ code: "validation_failed" });
    expect(over.changes).toEqual([]);
  });

  it("AC6 · a plan that does not grant the flag is feature_not_in_plan naming the tier from `plans`, before any lock or Stripe call", async () => {
    const gw = gateway();
    const c = client([
      [/FROM workspaces w JOIN plans/u, planRow("free")],
      [/SELECT key FROM plans WHERE entitlements/u, [{ key: "growth" }]],
    ]);
    await expect(inTenant(c, () => new BillingAddonsService(gw).add({ kind: "extra_project", quantity: 1 }, "key-1"))).rejects.toMatchObject({
      code: "feature_not_in_plan",
      details: { key: "projects.addon_allowed", min_plan: "growth" },
    });
    expect(c.calls.some(({ sql }) => /FOR UPDATE/u.test(sql))).toBe(false);
    expect(gw.fetches).toEqual([]);
    expect(gw.changes).toEqual([]);
  });

  it("an annual subscription is a 409 and Stripe is not called", async () => {
    const gw = gateway();
    const c = client([[/FROM workspaces w JOIN plans/u, planRow("growth")], [/FROM subscriptions WHERE workspace_id/u, subRow({ billing_interval: "annual" })]]);
    await expect(inTenant(c, () => new BillingAddonsService(gw).add({ kind: "extra_seat", quantity: 1 }, "key-1"))).rejects.toMatchObject({ code: "conflict" });
    expect(gw.fetches).toEqual([]);
  });

  it("no Stripe subscription (operator-comped or none) is precondition_unmet, never an upstream call", async () => {
    const gw = gateway();
    const c = client([[/FROM workspaces w JOIN plans/u, planRow("growth")], [/FROM subscriptions WHERE workspace_id/u, subRow({ provider: "operator", stripe_subscription_id: "" })]]);
    await expect(inTenant(c, () => new BillingAddonsService(gw).add({ kind: "extra_seat", quantity: 1 }, "key-1"))).rejects.toMatchObject({ code: "precondition_unmet" });
    expect(gw.changes).toEqual([]);
  });

  it("an unconfigured provider is degraded before any database read; an upstream failure is degraded and leaks no Stripe text", async () => {
    const off = gateway({ isConfigured: () => false } as never);
    const c = client(base);
    await expect(inTenant(c, () => new BillingAddonsService(off).add({ kind: "extra_seat", quantity: 1 }, "key-1"))).rejects.toMatchObject({ code: "degraded" });
    expect(c.calls.filter(({ sql }) => /FROM/u.test(sql))).toEqual([]);

    const down = gateway({ changeAddonQuantity: () => Promise.reject(new StripeUpstreamError(500)) } as never);
    const err = await inTenant(client(base), () => new BillingAddonsService(down).add({ kind: "extra_seat", quantity: 1 }, "key-1")).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "degraded" });
    expect(JSON.stringify((err as { details?: unknown }).details ?? "")).not.toContain("500");
  });
});

describe("STORY-076b · remove (period-end policy, seat refusal first)", () => {
  const held = (quantity: number): Script[number] => [/FROM subscription_addons WHERE kind/u, [{ id: "a1", kind: "extra_seat", quantity, unit_price_usd: "15.00", stripe_subscription_item_id: "si_seat", subscription_id: "s1" }]];
  const resolution = (value: number, source: string): Script[number] => [
    /jsonb_object_agg/u,
    [{ plan_key: "growth", entitlement_version: 1, entitlement_overrides: {}, plan_entitlements: PLAN_ENTITLEMENTS.growth, addons: source === "add_on" ? { extra_seat: value - 7 } : {} }],
  ];
  const members = (n: number): Script[number] => [/count\(\*\)::int AS n FROM workspace_members/u, [{ n }]];

  const script = (memberCount: number, quantity = 2): Script => [
    held(quantity),
    resolution(7 + quantity, "add_on"),
    members(memberCount),
    [/FROM workspaces w JOIN plans/u, planRow("growth")],
    [/FROM subscriptions WHERE workspace_id/u, subRow()],
  ];

  it("AC3 · scenario 12 · members over the reduced limit is a 409 and NO Stripe call of any kind", async () => {
    const gw = gateway();
    await expect(inTenant(client(script(8)), () => new BillingAddonsService(gw).remove("extra_seat"))).rejects.toMatchObject({ code: "conflict" });
    expect(gw.removals).toEqual([]);
    expect(gw.fetches).toEqual([]);
    expect(gw.changes).toEqual([]);
  });

  it("AC3 boundary · members exactly at the reduced limit may remove; the message carries the figures", async () => {
    const gw = gateway();
    expect(await inTenant(client(script(7)), () => new BillingAddonsService(gw).remove("extra_seat"))).toMatchObject({ kind: "extra_seat", quantity_requested: 0 });
    const err = await inTenant(client(script(8)), () => new BillingAddonsService(gateway()).remove("extra_seat")).catch((e: Error) => e);
    expect((err as Error).message).toContain("8 members");
    expect((err as Error).message).toContain("limit would be 7");
  });

  it("AC3 · an override is absolute: removing the add-on cannot lower a negotiated ceiling, so it is never refused for it", async () => {
    const gw = gateway();
    const c = client([
      held(2),
      [/jsonb_object_agg/u, [{ plan_key: "growth", entitlement_version: 1, entitlement_overrides: { "seats.max": 60 }, plan_entitlements: PLAN_ENTITLEMENTS.growth, addons: { extra_seat: 2 } }]],
      members(59),
      [/FROM workspaces w JOIN plans/u, planRow("growth")],
      [/FROM subscriptions WHERE workspace_id/u, subRow()],
    ]);
    await inTenant(c, () => new BillingAddonsService(gw).remove("extra_seat"));
    expect(gw.removals).toHaveLength(1);
  });

  it("AC4 · scenario 13 · schedules at the CURRENT PERIOD END against the held item and writes nothing local", async () => {
    const gw = gateway();
    const c = client(script(3));
    const out = await inTenant(c, () => new BillingAddonsService(gw).remove("extra_seat"));
    expect(out).toMatchObject({ status: "pending", effective: "period_end", effective_at: "2026-11-01T00:00:00.000Z" });
    expect(gw.removals).toEqual([expect.objectContaining({ subscriptionId: "sub_1", itemId: "si_seat" })]);
    expect(c.calls.filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)/iu.test(sql))).toEqual([]);
  });

  it("removing an add-on that is not held is a 404 and calls nothing", async () => {
    const gw = gateway();
    await expect(inTenant(client([]), () => new BillingAddonsService(gw).remove("extra_project"))).rejects.toMatchObject({ code: "not_found" });
    expect(gw.removals).toEqual([]);
  });
});

describe("STORY-076b · reconcile (the only writer)", () => {
  const item = (kind: "extra_project" | "extra_seat", quantity: number, itemId = `si_${kind}`, unitAmountCents = kind === "extra_seat" ? 1500 : 4900) => ({ kind, quantity, itemId, unitAmountCents, currency: "usd" });
  const input = (items: ReturnType<typeof item>[], versionAlreadyBumped = false) => ({ workspaceId: WS, stripeSubscriptionId: "sub_1", items, eventId: "evt_1", eventType: "customer.subscription.updated", versionAlreadyBumped });
  const existing = (kind: string, quantity: number, price: string, itemId: string) => ({ id: `row_${kind}`, kind, quantity, unit_price_usd: price, stripe_subscription_item_id: itemId, subscription_id: "s1" });
  const withRows = (rows: unknown[]): Script => [[/FROM subscriptions WHERE workspace_id/u, [{ id: "s1" }]], [/FROM subscription_addons WHERE workspace_id/u, rows as unknown[]]];
  const writes = (c: { calls: Array<{ sql: string }> }) => c.calls.map(({ sql }) => sql.trim().split(/\s+/u).slice(0, 3).join(" ")).filter((s) => /^(INSERT|UPDATE)/u.test(s));

  it("AC1 · opens a row per new add-on with the price Stripe charges as numeric text, bumps the version once and audits", async () => {
    append.mockClear();
    const c = client(withRows([]));
    expect(await new BillingAddonsService(gateway()).reconcile(c, input([item("extra_project", 2), item("extra_seat", 3)]))).toEqual({ changed: true });
    const inserts = c.calls.filter(({ sql }) => /INSERT INTO subscription_addons/u.test(sql));
    expect(inserts.map(({ params }) => params.slice(2))).toEqual([["extra_project", 2, "49.00", "si_extra_project"], ["extra_seat", 3, "15.00", "si_extra_seat"]]);
    expect(c.calls.filter(({ sql }) => /entitlement_version = entitlement_version \+ 1/u.test(sql))).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![1]).toMatchObject({ action: "billing.addons_reconciled", actorType: "system", requestId: "evt_1", beforeState: { addons: {} }, afterState: { addons: { extra_project: 2, extra_seat: 3 } } });
  });

  it("AC5 · does not bump a second time when applyPlanChange already did in this transaction (still audits)", async () => {
    append.mockClear();
    const c = client(withRows([]));
    await new BillingAddonsService(gateway()).reconcile(c, input([item("extra_seat", 1)], true));
    expect(c.calls.filter(({ sql }) => /entitlement_version = entitlement_version \+ 1/u.test(sql))).toEqual([]);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("idempotent · an identical set writes nothing, bumps nothing and audits nothing", async () => {
    append.mockClear();
    const c = client(withRows([existing("extra_seat", 3, "15.00", "si_extra_seat")]));
    expect(await new BillingAddonsService(gateway()).reconcile(c, input([item("extra_seat", 3)]))).toEqual({ changed: false });
    expect(writes(c)).toEqual([]);
    expect(append).not.toHaveBeenCalled();
  });

  it("a changed quantity, price or item id updates the row in place", async () => {
    for (const changed of [item("extra_seat", 4), item("extra_seat", 3, "si_extra_seat", 1600), item("extra_seat", 3, "si_new")]) {
      const c = client(withRows([existing("extra_seat", 3, "15.00", "si_extra_seat")]));
      expect(await new BillingAddonsService(gateway()).reconcile(c, input([changed]))).toEqual({ changed: true });
      expect(writes(c)).toEqual(expect.arrayContaining([expect.stringMatching(/^UPDATE subscription_addons/u)]));
    }
  });

  it("an add-on missing from the fetch is closed with active_until, not deleted", async () => {
    const c = client(withRows([existing("extra_project", 1, "49.00", "si_extra_project")]));
    expect(await new BillingAddonsService(gateway()).reconcile(c, input([]))).toEqual({ changed: true });
    expect(c.calls.some(({ sql }) => /SET active_until = now\(\)/u.test(sql))).toBe(true);
    expect(c.calls.some(({ sql }) => /^\s*DELETE/iu.test(sql))).toBe(false);
  });

  it("null path · no live local subscription for that Stripe id (a stale or foreign one) writes nothing", async () => {
    const c = client([[/FROM subscriptions WHERE workspace_id/u, []]]);
    expect(await new BillingAddonsService(gateway()).reconcile(c, input([item("extra_seat", 1)]))).toEqual({ changed: false });
    expect(writes(c)).toEqual([]);
  });

  it("empty collections · no add-ons held and none fetched is a no-op", async () => {
    const c = client(withRows([]));
    expect(await new BillingAddonsService(gateway()).reconcile(c, input([]))).toEqual({ changed: false });
  });
});

describe("STORY-076b audit · a retried POST charges once (the quantity is a total and the Stripe key is replayable)", () => {
  const base: Script = [
    [/FROM workspaces w JOIN plans/u, planRow("growth")],
    [/FROM subscriptions WHERE workspace_id/u, subRow()],
  ];

  /** A Stripe that holds a quantity, applies a change, and (once) loses the reply. */
  function stripe(start: number, loseFirstReply: boolean) {
    const state = { quantity: start, calls: [] as Array<{ key: string; quantity: number }>, seen: new Map<string, number>() };
    let lost = loseFirstReply;
    const gw = gateway({
      fetchObject: (kind: string, id: string) =>
        Promise.resolve({
          kind,
          id,
          metadata: {},
          raw: { items: { data: state.quantity === 0 ? [] : [{ id: "si_seat", quantity: state.quantity, price: { unit_amount: 1500, currency: "usd", product: { metadata: { nominara_kind: "extra_seat" } } } }] } },
        }),
      changeAddonQuantity: (input: { idempotencyKey: string; quantity: number }) => {
        state.calls.push({ key: input.idempotencyKey, quantity: input.quantity });
        // Stripe replays a request carrying a key it has already applied.
        if (!state.seen.has(input.idempotencyKey)) {
          state.seen.set(input.idempotencyKey, input.quantity);
          state.quantity = input.quantity;
        }
        if (lost) {
          lost = false;
          return Promise.reject(new StripeUpstreamError(503));
        }
        return Promise.resolve();
      },
    } as never);
    return { state, gw };
  }

  it("AC1 retry · Stripe applies the change and the reply is lost: the same Idempotency-Key retried leaves exactly ONE unit added", async () => {
    const { state, gw } = stripe(0, true);
    const svc = new BillingAddonsService(gw);
    await expect(inTenant(client(base), () => svc.add({ kind: "extra_seat", quantity: 1 }, "client-key-1"))).rejects.toMatchObject({ code: "degraded" });
    expect(state.quantity).toBe(1);
    const retry = await inTenant(client(base), () => svc.add({ kind: "extra_seat", quantity: 1 }, "client-key-1"));
    expect(retry).toMatchObject({ status: "pending", quantity_requested: 1 });
    expect(state.quantity).toBe(1);
  });

  it("AC1 retry · the Stripe key is derived from the workspace and the request's Idempotency-Key: stable on a retry, different for another key or workspace", async () => {
    const keys = async (ws: string, key: string) => {
      const { state, gw } = stripe(0, false);
      await withTenantContext(client(base), { workspaceId: ws, actorId: ws }, () => new BillingAddonsService(gw).add({ kind: "extra_seat", quantity: 1 }, key));
      return state.calls[0]!.key;
    };
    const a = await keys(WS, "client-key-1");
    expect(await keys(WS, "client-key-1")).toBe(a);
    expect(await keys(WS, "client-key-2")).not.toBe(a);
    expect(await keys("00000000-0000-7000-8000-000000000002", "client-key-1")).not.toBe(a);
    expect(a.length).toBeLessThanOrEqual(255);
    expect(a).not.toContain("client-key-1");
  });

  it("AC1 retry · a total already held is a no-op: no Stripe change is issued", async () => {
    const { state, gw } = stripe(3, false);
    const out = await inTenant(client(base), () => new BillingAddonsService(gw).add({ kind: "extra_seat", quantity: 3 }, "client-key-1"));
    expect(out).toMatchObject({ status: "pending", quantity_requested: 3 });
    expect(state.calls).toEqual([]);
  });

  it("AC1 boundary · a total below what is held is a 409 (removal is DELETE) and Stripe is not called", async () => {
    const { state, gw } = stripe(3, false);
    await expect(inTenant(client(base), () => new BillingAddonsService(gw).add({ kind: "extra_seat", quantity: 2 }, "client-key-1"))).rejects.toMatchObject({ code: "conflict" });
    expect(state.calls).toEqual([]);
    expect(state.quantity).toBe(3);
  });
});

describe("STORY-076b audit · an add-on change is refused while a removal is scheduled (phase 2 is frozen at DELETE time)", () => {
  const projectRow = [/FROM subscription_addons WHERE kind/u, [{ id: "a1", kind: "extra_project", quantity: 1, unit_price_usd: "49.00", stripe_subscription_item_id: "si_project", subscription_id: "s1" }]] as Script[number];
  const removeScript: Script = [
    [/jsonb_object_agg/u, [{ plan_key: "growth", entitlement_version: 1, entitlement_overrides: {}, plan_entitlements: PLAN_ENTITLEMENTS.growth, addons: {} }]],
    [/count\(\*\)::int AS n FROM workspace_members/u, [{ n: 1 }]],
    [/FROM workspaces w JOIN plans/u, planRow("growth")],
    [/FROM subscriptions WHERE workspace_id/u, subRow()],
  ];
  const addScript: Script = [
    [/FROM workspaces w JOIN plans/u, planRow("growth")],
    [/FROM subscriptions WHERE workspace_id/u, subRow()],
  ];

  /** A Stripe whose subscription grows a schedule the moment a removal is scheduled, and keeps it. */
  function stripe() {
    const state = { schedule: null as string | null, changes: [] as unknown[], removals: [] as unknown[] };
    const gw = gateway({
      fetchObject: (kind: string, id: string) =>
        Promise.resolve({
          kind,
          id,
          metadata: {},
          raw: { schedule: state.schedule, items: { data: [{ id: "si_project", quantity: 1, price: { unit_amount: 4900, currency: "usd", product: { metadata: { nominara_kind: "extra_project" } } } }, { id: "si_seat", quantity: 1, price: { unit_amount: 1500, currency: "usd", product: { metadata: { nominara_kind: "extra_seat" } } } }] } },
        }),
      scheduleAddonRemoval: (input: unknown) => {
        state.schedule = "sub_sched_1";
        state.removals.push(input);
        return Promise.resolve();
      },
      changeAddonQuantity: (input: unknown) => {
        state.changes.push(input);
        return Promise.resolve();
      },
    } as never);
    return { state, gw };
  }

  it("AC13 · DELETE extra_project then POST extra_seat {3} is a 409 naming the scheduled removal: Stripe is NOT changed and the frozen phase 2 is not touched", async () => {
    const { state, gw } = stripe();
    const svc = new BillingAddonsService(gw);
    await inTenant(client([projectRow, ...removeScript]), () => svc.remove("extra_project"));
    expect(state.removals).toHaveLength(1);
    expect(state.schedule).toBe("sub_sched_1");
    await expect(inTenant(client(addScript), () => svc.add({ kind: "extra_seat", quantity: 3 }, "k1"))).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/removal.*scheduled/iu) });
    expect(state.changes).toEqual([]);
    expect(state.removals).toHaveLength(1);
  });

  it("AC13 · with no schedule attached the same POST goes through", async () => {
    const { state, gw } = stripe();
    await inTenant(client(addScript), () => new BillingAddonsService(gw).add({ kind: "extra_seat", quantity: 3 }, "k1"));
    expect(state.changes).toHaveLength(1);
  });

  it("AC13 · a total already held is still a no-op while a removal is scheduled (a retry of a POST that landed first)", async () => {
    const { state, gw } = stripe();
    state.schedule = "sub_sched_1";
    const out = await inTenant(client(addScript), () => new BillingAddonsService(gw).add({ kind: "extra_seat", quantity: 1 }, "k1"));
    expect(out).toMatchObject({ status: "pending", quantity_requested: 1 });
    expect(state.changes).toEqual([]);
  });
});

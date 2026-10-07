import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { IS_PUBLIC_KEY } from "../../src/api/decorators/public.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../../src/api/decorators/skip-tenant-context.decorator.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { StripeUpstreamError, STRIPE_GATEWAY } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { sweepStripeWebhookEvents, WEBHOOK_EVENT_RETENTION_DAYS } from "../../src/lib/billing/stripe/webhook-events.js";
import { STRIPE_EVENT_HANDLERS, type StripeEventContext, type StripeEventHandler } from "../../src/modules/billing/stripe-event-handler.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { discoverRealRoutes } from "../support/discover-contract-routes.js";
import { FAKE_WEBHOOK_SECRET, FakeStripeGateway, signFakeStripePayload } from "../support/fake-stripe-gateway.js";

// NEW-D-2 / STORY-075 — the webhook ingress through the REAL ApiModule (real
// guards, real interceptors, real filter), against a real Postgres, with the
// pool connected as `nominara_app` so RLS is actually in force (a superuser
// bypasses it and would make every tenancy assertion here vacuous). Stripe is
// the fake gateway: NO TEST CALLS THE REAL STRIPE API.

const gateway = new FakeStripeGateway();
const handlerCalls: StripeEventContext[] = [];
const handlers: StripeEventHandler[] = [];

function recordingHandler(types: string[], effect?: (ctx: StripeEventContext) => Promise<void>): StripeEventHandler {
  return {
    types,
    handle: async (ctx) => {
      handlerCalls.push(ctx);
      await effect?.(ctx);
    },
  };
}

describe("STORY-075 · Stripe webhook ingress (NEW-D-2)", () => {
  const harness = useApiHarness({
    env: () => {
      // The harness has set DATABASE_URL to the container's superuser URI just before this runs.
      const url = new URL(process.env.DATABASE_URL!);
      url.username = "nominara_app";
      url.password = resolvePassword("nominara_app", {});
      return { DATABASE_URL_POOLED: url.toString() };
    },
    configure: (builder) => {
      builder.overrideProvider(STRIPE_GATEWAY).useValue(gateway);
      builder.overrideProvider(STRIPE_EVENT_HANDLERS).useValue(handlers);
    },
  });

  let workspaceA: string;
  let workspaceB: string;
  let warn: MockInstance<(...args: unknown[]) => void>;
  let log: MockInstance<(...args: unknown[]) => void>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    gateway.objects.clear();
    gateway.fetches.length = 0;
    gateway.configured = true;
    gateway.failFetchWith = undefined;
    handlerCalls.length = 0;
    handlers.length = 0;
    workspaceA = await workspace("Alpha");
    workspaceB = await workspace("Beta");
    warn = vi.spyOn(Logger.prototype, "warn") as unknown as typeof warn;
    log = vi.spyOn(Logger.prototype, "log") as unknown as typeof log;
  });

  async function workspace(name: string): Promise<string> {
    const id = randomUUID();
    await harness.db().query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, $2, $3, 'growth')", [id, name, `w-${id.slice(0, 8)}`]);
    return id;
  }

  const eventBody = (id: string, type: string, objectId: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ id, object: "event", type, data: { object: { id: objectId, ...extra } } });

  async function post(body: string, signature: string | null = signFakeStripePayload(body)) {
    return await harness.app().inject({
      method: "POST",
      url: apiUrl("/webhooks/stripe"),
      headers: { "content-type": "application/json", ...(signature === null ? {} : { "stripe-signature": signature }) },
      payload: body,
    });
  }

  const errorCode = (res: { json: <T>() => T }): string | undefined => res.json<{ error?: { code?: string } }>().error?.code;
  const outcomeOf = (res: { json: <T>() => T }): string => res.json<{ data: { outcome: string } }>().data.outcome;
  const ledgerIds = async (): Promise<string[]> =>
    (await harness.db().query<{ event_id: string }>("SELECT event_id FROM stripe_webhook_events ORDER BY event_id")).rows.map((r) => r.event_id);

  function subscriptionFor(id: string, workspaceId: string | undefined): void {
    gateway.putObject("subscription", id, workspaceId === undefined ? {} : { workspace_id: workspaceId });
  }

  // -- the route's declared posture ------------------------------------------------------------------

  it("the route is @Public() and @SkipTenantContext() (a session is not how Stripe authenticates)", async () => {
    const routes = await discoverRealRoutes();
    const route = routes.find((r) => r.fullPath === "webhooks/stripe");
    expect(route, "POST /v1/webhooks/stripe is registered").toBeDefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, route!.handler)).toBe(true);
    expect(Reflect.getMetadata(SKIP_TENANT_CONTEXT_KEY, route!.handler)).toBe(true);
  });

  // -- STORY-075 scenarios 2 and 3 -------------------------------------------------------------------

  it("scenario 3 · a valid signature is processed, and the response keeps the envelope", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    subscriptionFor("sub_1", workspaceA);
    const res = await post(eventBody("evt_ok", "customer.subscription.updated", "sub_1"));
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown; meta: unknown }>()).toMatchObject({ data: { received: true, outcome: "processed" } });
    expect(handlerCalls).toHaveLength(1);
    expect(await ledgerIds()).toEqual(["evt_ok"]);
  });

  it("scenario 2 · a signature made with the wrong secret is a 400 and writes nothing, fetches nothing", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    subscriptionFor("sub_1", workspaceA);
    const body = eventBody("evt_bad", "customer.subscription.updated", "sub_1");
    const res = await post(body, signFakeStripePayload(body, "whsec_someone_else"));
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe("validation_failed");
    expect(await ledgerIds()).toEqual([]);
    expect(gateway.fetches).toEqual([]);
    expect(handlerCalls).toEqual([]);
  });

  it("scenario 2 · a missing Stripe-Signature header is a 400 and writes nothing", async () => {
    const res = await post(eventBody("evt_nosig", "customer.subscription.updated", "sub_1"), null);
    expect(res.statusCode).toBe(400);
    expect(await ledgerIds()).toEqual([]);
  });

  it("scenario 2 · a body tampered with after signing is a 400", async () => {
    const body = eventBody("evt_tamper", "customer.subscription.updated", "sub_1");
    const res = await post(body.replace("sub_1", "sub_2"), signFakeStripePayload(body));
    expect(res.statusCode).toBe(400);
    expect(await ledgerIds()).toEqual([]);
  });

  it("scenario 2 · a validly signed but stale delivery (outside the 300 s tolerance) is a 400, and just inside it is accepted", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    subscriptionFor("sub_1", workspaceA);
    const now = Math.floor(Date.now() / 1000);
    const stale = eventBody("evt_stale", "customer.subscription.updated", "sub_1");
    expect((await post(stale, signFakeStripePayload(stale, FAKE_WEBHOOK_SECRET, now - 301))).statusCode).toBe(400);
    expect(await ledgerIds()).toEqual([]);
    const fresh = eventBody("evt_fresh", "customer.subscription.updated", "sub_1");
    expect((await post(fresh, signFakeStripePayload(fresh, FAKE_WEBHOOK_SECRET, now - 290))).statusCode).toBe(200);
  });

  it("a refused signature logs a warn line and bumps the bad_signature counter, with no signature material in either", async () => {
    const body = eventBody("evt_bad2", "customer.subscription.updated", "sub_1");
    const header = signFakeStripePayload(body, "whsec_someone_else");
    await post(body, header);
    const emitted = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(emitted).toContain("signature did not verify");
    expect(emitted).toContain("nominara_billing_stripe_webhook_events_total");
    expect(emitted).toContain("bad_signature");
    expect(emitted).not.toContain(header.split("v1=")[1]);
    expect(emitted).not.toContain(FAKE_WEBHOOK_SECRET);
  });

  // -- STORY-075 AC3 / scenario 4 -------------------------------------------------------------------

  it("scenario 4 · the same event delivered twice is a no-op: one effect, one ledger row, one Stripe fetch", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    subscriptionFor("sub_1", workspaceA);
    const body = eventBody("evt_dup", "customer.subscription.updated", "sub_1");
    expect(outcomeOf(await post(body))).toBe("processed");
    expect(outcomeOf(await post(body))).toBe("duplicate");
    expect(handlerCalls).toHaveLength(1);
    expect(await ledgerIds()).toEqual(["evt_dup"]);
    expect(gateway.fetches).toEqual(["subscription:sub_1"]);
  });

  it("scenario 4 · eight concurrent deliveries of one event run the effect exactly once", async () => {
    handlers.push(
      recordingHandler(["customer.subscription.updated"], async (ctx) => {
        // Hold the transaction open so the others genuinely race the unique key rather than the pre-check.
        await ctx.tx.query("SELECT pg_sleep(0.15)");
      }),
    );
    subscriptionFor("sub_1", workspaceA);
    const body = eventBody("evt_race", "customer.subscription.updated", "sub_1");
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body)));
    expect(results.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    const outcomes = results.map(outcomeOf).sort();
    expect(outcomes.filter((o) => o === "processed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(7);
    expect(handlerCalls).toHaveLength(1);
    expect(await ledgerIds()).toEqual(["evt_race"]);
  });

  it("AC3 · the claim and the effect are ONE transaction: a handler that writes then fails leaves neither", async () => {
    handlers.push(
      recordingHandler(["customer.subscription.updated"], async (ctx) => {
        await ctx.tx.query("UPDATE workspaces SET name = 'WRITTEN-BY-HANDLER' WHERE id = $1", [ctx.workspaceId]);
        throw new Error("crash between the effect and the commit");
      }),
    );
    subscriptionFor("sub_1", workspaceA);
    const res = await post(eventBody("evt_crash", "customer.subscription.updated", "sub_1"));
    expect(res.statusCode).toBe(500);
    expect(await ledgerIds(), "the event must NOT be recorded as processed").toEqual([]);
    const name = await harness.db().query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [workspaceA]);
    expect(name.rows[0]!.name, "the effect rolled back with the claim").toBe("Alpha");
  });

  it("AC3 · after a failed attempt, Stripe's redelivery of the same event is processed, not deduplicated away", async () => {
    let fail = true;
    handlers.push(
      recordingHandler(["customer.subscription.updated"], () => {
        if (fail) throw new Error("transient");
        return Promise.resolve();
      }),
    );
    subscriptionFor("sub_1", workspaceA);
    const body = eventBody("evt_retry", "customer.subscription.updated", "sub_1");
    expect((await post(body)).statusCode).toBe(500);
    fail = false;
    expect(outcomeOf(await post(body))).toBe("processed");
    expect(await ledgerIds()).toEqual(["evt_retry"]);
  });

  // -- STORY-075 AC12 / scenario 12 ------------------------------------------------------------------

  it("scenario 12 · an object with no workspace_id is acknowledged 2xx, logged at warn, recorded, and no handler runs", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    subscriptionFor("sub_orphan", undefined);
    const res = await post(eventBody("evt_orphan", "customer.subscription.updated", "sub_orphan"));
    expect(res.statusCode).toBe(200);
    expect(outcomeOf(res)).toBe("ignored");
    expect(handlerCalls).toEqual([]);
    expect(warn.mock.calls.map((c) => JSON.stringify(c)).join("\n")).toContain("no resolvable workspace_id");
    expect(await ledgerIds()).toEqual(["evt_orphan"]);
    // Recorded, so Stripe's redelivery is a cheap no-op rather than another fetch.
    expect(outcomeOf(await post(eventBody("evt_orphan", "customer.subscription.updated", "sub_orphan")))).toBe("duplicate");
  });

  it.each([
    ["not a uuid", "not-a-uuid"],
    ["an empty string", ""],
    ["a well-formed uuid for a workspace that does not exist", randomUUID()],
  ])("scenario 12 · workspace_id that is %s is acknowledged 2xx, never 5xx", async (_label, value) => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    gateway.putObject("subscription", "sub_x", { workspace_id: value });
    const res = await post(eventBody(`evt_${randomUUID()}`, "customer.subscription.updated", "sub_x"));
    expect(res.statusCode).toBe(200);
    expect(outcomeOf(res)).toBe("ignored");
    expect(handlerCalls).toEqual([]);
  });

  it("scenario 12 · an object Stripe no longer has (a test-mode id at this endpoint) is acknowledged, not retried forever", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    const res = await post(eventBody("evt_gone", "customer.subscription.updated", "sub_gone"));
    expect(res.statusCode).toBe(200);
    expect(outcomeOf(res)).toBe("ignored");
  });

  it("an event type no handler consumes is acknowledged without a Stripe fetch", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    const res = await post(eventBody("evt_other", "customer.created", "cus_1"));
    expect(outcomeOf(res)).toBe("ignored");
    expect(gateway.fetches).toEqual([]);
    expect(await ledgerIds()).toEqual(["evt_other"]);
  });

  it("with the real (empty) handler list every verified event is acknowledged — the ingress alone has no effect", async () => {
    const res = await post(eventBody("evt_noop", "customer.subscription.updated", "sub_1"));
    expect(res.statusCode).toBe(200);
    expect(outcomeOf(res)).toBe("ignored");
  });

  it("a Stripe outage during the re-fetch is a 503 and records nothing, so Stripe's retry gets a clean attempt", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    gateway.failFetchWith = new StripeUpstreamError(500);
    const res = await post(eventBody("evt_outage", "customer.subscription.updated", "sub_1"));
    expect(res.statusCode).toBe(503);
    expect(errorCode(res)).toBe("degraded");
    expect(await ledgerIds()).toEqual([]);
  });

  // -- the workspace is resolved from the FETCHED object, under tenant context -----------------------

  it("the workspace comes from the re-fetched object's metadata — the event payload's claim is ignored", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    subscriptionFor("sub_1", workspaceA);
    // The signed event body claims workspace B in every place a forger could put it.
    const body = eventBody("evt_forged", "customer.subscription.updated", "sub_1", {
      metadata: { workspace_id: workspaceB },
      workspace_id: workspaceB,
    });
    await post(body);
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]!.workspaceId).toBe(workspaceA);
  });

  it("the handler's transaction carries the workspace's tenant context as nominara_app, and RLS hides the other tenant", async () => {
    let seen: { current: string; role: string; visible: string[] } | undefined;
    handlers.push(
      recordingHandler(["customer.subscription.updated"], async (ctx) => {
        const row = await ctx.tx.query<{ current: string; role: string }>("SELECT current_setting('app.current_workspace_id') AS current, current_user AS role");
        const visible = await ctx.tx.query<{ id: string }>("SELECT id FROM workspaces");
        seen = { current: row.rows[0]!.current, role: row.rows[0]!.role, visible: visible.rows.map((r) => r.id) };
      }),
    );
    subscriptionFor("sub_1", workspaceA);
    await post(eventBody("evt_rls", "customer.subscription.updated", "sub_1"));
    expect(seen).toEqual({ current: workspaceA, role: "nominara_app", visible: [workspaceA] });
  });

  it("the handler cannot write into another tenant: an UPDATE of workspace B from A's context touches zero rows", async () => {
    let touched: number | null = null;
    handlers.push(
      recordingHandler(["customer.subscription.updated"], async (ctx) => {
        const r = await ctx.tx.query("UPDATE workspaces SET name = 'HIJACKED' WHERE id = $1", [workspaceB]);
        touched = r.rowCount;
      }),
    );
    subscriptionFor("sub_1", workspaceA);
    await post(eventBody("evt_x", "customer.subscription.updated", "sub_1"));
    expect(touched).toBe(0);
    const name = await harness.db().query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [workspaceB]);
    expect(name.rows[0]!.name).toBe("Beta");
  });

  it("no tenant context leaks onto the pooled connection afterwards (set_config is transaction-local)", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    subscriptionFor("sub_1", workspaceA);
    await post(eventBody("evt_leak", "customer.subscription.updated", "sub_1"));
    // Whatever connection serves the next unauthenticated request must see no workspace.
    const next = await harness.app().inject({ method: "POST", url: apiUrl("/webhooks/stripe"), payload: "{}", headers: { "content-type": "application/json" } });
    expect(next.statusCode).toBe(400);
    const probe = await harness.db().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'nominara_app' AND state = 'idle in transaction'",
    );
    expect(probe.rows[0]!.n).toBe(0);
  });

  it("the unauthenticated warn log carries the workspace ID and never its name or raw Stripe text", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    gateway.putObject("subscription", "sub_ghost", { workspace_id: randomUUID(), customer_email: "pii@example.com" }, { description: "RAW-STRIPE-TEXT" });
    await post(eventBody("evt_log", "customer.subscription.updated", "sub_ghost"));
    const emitted = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(emitted).toContain("workspace does not exist");
    expect(emitted).not.toContain("pii@example.com");
    expect(emitted).not.toContain("RAW-STRIPE-TEXT");
    expect(emitted).not.toContain("Alpha");
  });

  it("the outcome counter is emitted for a processed event", async () => {
    handlers.push(recordingHandler(["customer.subscription.updated"]));
    subscriptionFor("sub_1", workspaceA);
    await post(eventBody("evt_metric", "customer.subscription.updated", "sub_1"));
    const metrics = log.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((c) => typeof c === "object" && c?.metric === "nominara_billing_stripe_webhook_events_total");
    expect(metrics).toEqual([{ metric: "nominara_billing_stripe_webhook_events_total", value: 1, outcome: "processed" }]);
  });

  // -- configuration --------------------------------------------------------------------------------

  it("with Stripe unconfigured every delivery is a 503 degraded and nothing is written", async () => {
    gateway.configured = false;
    const res = await post(eventBody("evt_unconf", "customer.subscription.updated", "sub_1"));
    expect(res.statusCode).toBe(503);
    expect(errorCode(res)).toBe("degraded");
    expect(await ledgerIds()).toEqual([]);
  });

  // -- STORY-075 AC2 / scenario 14 — through the real router -----------------------------------------

  it("scenario 14 · another JSON route still validates strictly and still receives parsed JSON", async () => {
    const unknownField = await harness.app().inject({
      method: "POST",
      url: apiUrl("/auth/otp/request"),
      payload: { email: "someone@example.com", surprise: true },
    });
    expect(unknownField.statusCode, "an unknown key on a strict request schema is a 400").toBe(400);

    const ok = await harness.app().inject({ method: "POST", url: apiUrl("/auth/otp/request"), payload: { email: "someone@example.com" } });
    expect(ok.statusCode, "a valid body is parsed and accepted").toBe(201);
  });

  it("scenario 14 · the webhook route's own body, once parsed, is untouched by the raw capture (malformed JSON is still a 400)", async () => {
    const res = await post("{not json", signFakeStripePayload("{not json"));
    expect(res.statusCode).toBe(400);
    expect(await ledgerIds()).toEqual([]);
  });

  // -- the ledger and its retention -------------------------------------------------------------------

  it("the ledger is a platform table: the worker, report and portal roles cannot touch it", async () => {
    for (const role of ["nominara_worker", "nominara_report", "nominara_portal"]) {
      const r = await harness.db().query<{ s: boolean; i: boolean }>(
        "SELECT has_table_privilege($1, 'stripe_webhook_events', 'SELECT') AS s, has_table_privilege($1, 'stripe_webhook_events', 'INSERT') AS i",
        [role],
      );
      expect(r.rows[0], role).toEqual({ s: false, i: false });
    }
  });

  it("retention · rows older than 30 days are swept; a row exactly 30 days old and a younger one are kept", async () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const insert = (id: string, receivedAt: string) =>
      harness.db().query("INSERT INTO stripe_webhook_events (event_id, type, received_at) VALUES ($1, 't', $2)", [id, receivedAt]);
    await insert("evt_31d", "2026-09-06T11:59:59Z");
    await insert("evt_30d_exact", "2026-09-07T12:00:00Z");
    await insert("evt_29d", "2026-09-08T12:00:00Z");
    expect(WEBHOOK_EVENT_RETENTION_DAYS).toBe(30);
    expect(await sweepStripeWebhookEvents(harness.db(), now)).toBe(1);
    expect(await ledgerIds()).toEqual(["evt_29d", "evt_30d_exact"]);
  });

  it("retention · sweeping an empty ledger removes nothing and does not throw", async () => {
    expect(await sweepStripeWebhookEvents(harness.db())).toBe(0);
  });

  it("the ledger refuses an empty event id or type", async () => {
    await expect(harness.db().query("INSERT INTO stripe_webhook_events (event_id, type) VALUES ('', 't')")).rejects.toThrow();
    await expect(harness.db().query("INSERT INTO stripe_webhook_events (event_id, type) VALUES ('e', '')")).rejects.toThrow();
  });
});

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { STRIPE_GATEWAY } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { useApiHarness } from "../support/api-harness.js";
import { apiUrl } from "../support/api-url.js";
import { FakeStripeGateway, signFakeStripePayload } from "../support/fake-stripe-gateway.js";

// STORY-075a / STORY-076a / STORY-076b checkpoint-4 (pool hold-and-wait). Checkout, the credit-pack purchase and add-ons each hold the
// request's pooled connection and take a SECOND one from the SAME pool for a short write. With more requests
// in flight than the pool holds, every holder waits for a connection that only another holder can return: a
// permanent, API-wide hang. These specs fire MORE concurrent requests than the main pool has connections (the
// default max of 10) and assert the run finishes before a deadline, and that the API still answers afterwards.
//
// Its own file on purpose: a deadlocked pool never recovers, so a regression must not take the add-on spec's
// other tests down with it.

const gateway = new FakeStripeGateway();
const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };
const T0 = Math.floor(Date.now() / 1000);
const PERIOD_END = T0 + 30 * 86_400;
/** More than the main pool's default max of 10; the most one user may burst on the `writes` class (20). */
const CONCURRENCY = 20;
/** Across distinct users the writes burst is not the limit. */
const MIXED = 30;
/** Long enough for 30 serialised requests with a 3 s bounded lock wait; far shorter than a hang. */
const DEADLINE_MS = 25_000;

describe("STORY-075a / STORY-076a / STORY-076b checkpoint-4 · a holder of the main pool never waits on the main pool", () => {
  const harness = useApiHarness({
    env: () => {
      const url = new URL(process.env.DATABASE_URL!);
      url.username = "nominara_app";
      url.password = resolvePassword("nominara_app", {});
      return { DATABASE_URL_POOLED: url.toString() };
    },
    configure: (builder) => {
      builder.overrideProvider(STRIPE_GATEWAY).useValue(gateway);
    },
  });

  let pool: Pool;
  let sessions: SessionService;
  let workspaces: WorkspacesService;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await harness.db().query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    gateway.reset();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(pool, new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"), new AuditChainService(), membership, sessions, new NoopRealtimePublisher());
  });
  afterEach(async () => {
    await pool.end();
  });

  interface Actor {
    readonly accessToken: string;
    readonly csrfToken: string;
  }
  const cookies = (a: Actor) => ({ [ACCESS_COOKIE_NAME]: a.accessToken, [CSRF_COOKIE_NAME]: a.csrfToken });
  const post = (a: Actor, path: string, payload: unknown) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(path),
      cookies: cookies(a),
      headers: { [CSRF_HEADER_NAME]: a.csrfToken, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: payload as object,
    });
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), cookies: cookies(a) });

  const subIdOf = (workspaceId: string): string => `sub_${workspaceId}`;
  const eventBody = (id: string, type: string, objectId: string): string => JSON.stringify({ id, object: "event", type, data: { object: { id: objectId } } });
  const deliver = (body: string) =>
    harness.app().inject({ method: "POST", url: apiUrl("/webhooks/stripe"), headers: { "content-type": "application/json", "stripe-signature": signFakeStripePayload(body) }, payload: body });

  async function newWorkspace(plan: "free" | "growth"): Promise<{ workspaceId: string; owner: Actor }> {
    const user = await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
    const ownerId = user.rows[0]!.id;
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    if (plan === "growth") {
      const line = (kind: string, id: string, cents: number) => ({
        id,
        quantity: 1,
        current_period_start: T0,
        current_period_end: PERIOD_END,
        price: { id: `price_${id}`, unit_amount: cents, currency: "usd", recurring: { interval: "month" }, product: { metadata: { nominara_kind: kind } } },
      });
      gateway.putObject("subscription", subIdOf(ws.id), { workspace_id: ws.id, plan_key: "growth", billing_interval: "monthly" }, {
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        trial_end: null,
        items: { data: [line("plan", "si_plan", 12_900)] },
      });
      expect((await deliver(eventBody(`evt_${randomUUID()}`, "customer.subscription.created", subIdOf(ws.id)))).statusCode).toBe(200);
    }
    const tokens = await sessions.createSession(ownerId);
    const entered = await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta);
    return { workspaceId: ws.id, owner: entered };
  }

  /** Resolves with every response, or fails the test the moment the deadline passes (a deadlocked pool). */
  async function allBeforeDeadline<T>(label: string, work: Promise<T[]>, count = CONCURRENCY): Promise<T[]> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: ${String(count)} concurrent requests did not finish within ${String(DEADLINE_MS)} ms: the pool is deadlocked`)), DEADLINE_MS);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("STORY-075a AC-pool-checkout . 20 concurrent checkouts from ONE workspace (distinct Idempotency-Keys) finish before the deadline: each is a 200 or a retryable 409, and the API still answers", async () => {
    const { owner } = await newWorkspace("free");
    const responses = await allBeforeDeadline(
      "checkout",
      Promise.all(Array.from({ length: CONCURRENCY }, () => post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" }))),
    );
    expect(responses.map((r) => r.statusCode).every((code) => code === 200 || code === 409), responses.map((r) => r.body).join("\n")).toBe(true);
    expect(responses.some((r) => r.statusCode === 200)).toBe(true);
    expect((await get(owner, "/billing/subscription")).statusCode).toBe(200);
  }, 60_000);

  it("STORY-076a AC-pool-pack . 14 concurrent credit-pack purchases (one per workspace: the purchase has its own rate class) finish before the deadline and every one is created", async () => {
    const owners = await Promise.all(Array.from({ length: 14 }, () => newWorkspace("free")));
    const responses = await allBeforeDeadline("credit pack", Promise.all(owners.map(({ owner }) => post(owner, "/billing/credit-packs/starter_vault/purchase", {}))), 14);
    expect(responses.map((r) => r.statusCode), responses.map((r) => r.body).join("\n")).toEqual(Array.from({ length: 14 }, () => 200));
    expect(gateway.packCheckouts).toHaveLength(14);
    expect((await get(owners[0]!.owner, "/billing/subscription")).statusCode).toBe(200);
  }, 60_000);

  it("STORY-075a / STORY-076a / STORY-076b AC-pool-mixed . 30 concurrent billing writes ACROSS workspaces (add-ons, checkouts and pack purchases mixed) finish before the deadline: the add-on lock timeout covers only one workspace", async () => {
    const third = MIXED / 3;
    const addonOwners = await Promise.all(Array.from({ length: third }, () => newWorkspace("growth")));
    const checkoutOwners = await Promise.all(Array.from({ length: third }, () => newWorkspace("free")));
    const packOwners = await Promise.all(Array.from({ length: third }, () => newWorkspace("free")));
    const responses = await allBeforeDeadline("mixed", Promise.all([
      ...addonOwners.map(({ owner }) => post(owner, "/billing/addons", { kind: "extra_seat", quantity: 1 })),
      ...checkoutOwners.map(({ owner }) => post(owner, "/billing/checkout-session", { plan_key: "growth", billing_interval: "monthly" })),
      ...packOwners.map(({ owner }) => post(owner, "/billing/credit-packs/starter_vault/purchase", {})),
    ]), MIXED);
    const codes = responses.map((r) => r.statusCode);
    expect(codes.slice(0, third), responses.map((r) => r.body).join("\n")).toEqual(Array.from({ length: third }, () => 202));
    expect(codes.slice(third), responses.map((r) => r.body).join("\n")).toEqual(Array.from({ length: 2 * third }, () => 200));
    expect((await get(packOwners[0]!.owner, "/billing/subscription")).statusCode).toBe(200);
  }, 90_000);
});

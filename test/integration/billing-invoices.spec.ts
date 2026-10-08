import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { invoiceListResponseSchema, invoiceSchema } from "../../contracts/billing/index.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { STRIPE_GATEWAY } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { claimDueProjects } from "../../src/lib/capture/scheduler.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { AuditChainService } from "../../src/modules/audit/audit-chain.service.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { useApiHarness } from "../support/api-harness.js";
import { apiUrl } from "../support/api-url.js";
import { dataOf } from "../support/envelope.js";
import { FakeStripeGateway, signFakeStripePayload } from "../support/fake-stripe-gateway.js";

// STORY-075b — invoices as a read model, past-due handling, GET /billing/invoices.
// The REAL ApiModule, real Postgres, RLS in force (the pool connects as
// nominara_app). Stripe is the fake gateway: NO TEST CALLS THE REAL STRIPE API.

const gateway = new FakeStripeGateway();
const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };
const T0 = Math.floor(Date.now() / 1000);

describe("STORY-075b · invoices", () => {
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
    gateway.objects.clear();
    gateway.fetches.length = 0;
    gateway.configured = true;
    gateway.failFetchWith = undefined;
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const membership = new MembershipService(new MembershipCacheService());
    sessions = new SessionService(pool, membership, new InMemoryCacheAdapter());
    workspaces = new WorkspacesService(
      pool,
      new LocalDekProvisioner(Buffer.alloc(32, 7), "local:dev"),
      new AuditChainService(),
      membership,
      sessions,
      new NoopRealtimePublisher(),
    );
  });
  afterEach(async () => {
    await pool.end();
  });

  async function createUser(): Promise<string> {
    const r = await harness.db().query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
    return r.rows[0]!.id;
  }
  interface Actor {
    readonly accessToken: string;
    readonly csrfToken: string;
  }
  async function actorIn(workspaceId: string, role: "owner" | "admin" | "manager" | "viewer"): Promise<Actor> {
    const userId = await createUser();
    await harness.db().query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [workspaceId, userId, role]);
    const tokens = await sessions.createSession(userId);
    return workspaces.switchTo(userId, tokens.sid, workspaceId, meta);
  }
  async function newWorkspace(): Promise<{ workspaceId: string; owner: Actor }> {
    const ownerId = await createUser();
    const ws = await workspaces.create(ownerId, { name: `Workspace ${randomUUID()}` }, meta);
    const tokens = await sessions.createSession(ownerId);
    return { workspaceId: ws.id, owner: await workspaces.switchTo(ownerId, tokens.sid, ws.id, meta) };
  }
  const cookies = (a: Actor) => ({ [ACCESS_COOKIE_NAME]: a.accessToken, [CSRF_COOKIE_NAME]: a.csrfToken });
  const get = (a: Actor, path: string) => harness.app().inject({ method: "GET", url: apiUrl(path), cookies: cookies(a) });

  const eventBody = (id: string, type: string, objectId: string): string =>
    JSON.stringify({ id, object: "event", type, data: { object: { id: objectId } } });
  const deliver = (body: string) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/webhooks/stripe"),
      headers: { "content-type": "application/json", "stripe-signature": signFakeStripePayload(body) },
      payload: body,
    });
  const outcomeOf = (res: { json: <T>() => T }): string => res.json<{ data: { outcome: string } }>().data.outcome;

  /** Stripe's CURRENT state of an invoice, as the gateway will fetch it. */
  function stripeInvoice(
    workspaceId: string | null,
    over: Record<string, unknown> & { id?: string } = {},
  ): string {
    const id = over.id ?? "in_1";
    const { id: _ignored, ...rest } = over;
    gateway.putObject("invoice", id, workspaceId === null ? {} : { workspace_id: workspaceId }, {
      number: "NOM-0001",
      status: "open",
      subtotal: 12_900,
      total: 12_900,
      currency: "usd",
      period_start: T0,
      period_end: T0 + 30 * 86_400,
      hosted_invoice_url: `https://invoice.stripe.test/i/${id}`,
      invoice_pdf: `https://pay.stripe.test/invoice/${id}/pdf`,
      status_transitions: { paid_at: null },
      ...rest,
    });
    return id;
  }
  function stripeSubscription(workspaceId: string, over: { id?: string; status?: string } = {}): string {
    const id = over.id ?? "sub_1";
    gateway.putObject(
      "subscription",
      id,
      { workspace_id: workspaceId, plan_key: "growth", billing_interval: "monthly" },
      {
        customer: "cus_1",
        status: over.status ?? "active",
        cancel_at_period_end: false,
        trial_end: null,
        items: {
          data: [
            {
              quantity: 1,
              current_period_start: T0,
              current_period_end: T0 + 30 * 86_400,
              price: { unit_amount: 12_900, currency: "usd", recurring: { interval: "month" }, product: { metadata: { nominara_kind: "plan" } } },
            },
          ],
        },
      },
    );
    return id;
  }

  const invoiceRows = async (workspaceId: string) =>
    (await harness.db().query("SELECT * FROM invoices WHERE workspace_id = $1 ORDER BY created_at", [workspaceId])).rows;
  const invoiceAudits = async (workspaceId: string) =>
    (
      await harness.db().query(
        "SELECT actor_type, action, resource_type, resource_id, request_id, before_state, after_state FROM audit_log WHERE workspace_id = $1 AND action = 'billing.invoice_recorded' ORDER BY seq",
        [workspaceId],
      )
    ).rows;
  const wsStatus = async (workspaceId: string): Promise<string> =>
    (await harness.db().query<{ status: string }>("SELECT status FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.status;

  // ---- STORY-075 AC9 / scenario 9 ----------------------------------------------------------------

  it("scenario 9 · an invoice event re-fetches the invoice and records it as Stripe issued it", async () => {
    const { workspaceId } = await newWorkspace();
    stripeInvoice(workspaceId, {
      status: "paid",
      subtotal: 12_900,
      total: 11_610,
      status_transitions: { paid_at: T0 + 60 },
    });
    // The event body names only an id: everything below must come from the FETCH.
    const res = await deliver(eventBody("evt_i1", "invoice.paid", "in_1"));
    expect(res.statusCode, res.body).toBe(200);
    expect(outcomeOf(res)).toBe("processed");
    expect(gateway.fetches).toContain("invoice:in_1");

    const rows = await invoiceRows(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stripe_invoice_id: "in_1",
      number: "NOM-0001",
      status: "paid",
      subtotal: "129.00",
      total: "116.10",
      currency: "USD",
      hosted_invoice_url: "https://invoice.stripe.test/i/in_1",
      pdf_url: "https://pay.stripe.test/invoice/in_1/pdf",
    });
    expect(rows[0].period_start.getTime()).toBe(T0 * 1000);
    expect(rows[0].period_end.getTime()).toBe((T0 + 30 * 86_400) * 1000);
    expect(rows[0].paid_at.getTime()).toBe((T0 + 60) * 1000);
  });

  it("scenario 9 · NO LOCAL ARITHMETIC PRODUCES `total`: lines, tax and discount that disagree with Stripe's total change nothing", async () => {
    const { workspaceId } = await newWorkspace();
    stripeInvoice(workspaceId, {
      status: "open",
      subtotal: 10_000,
      total: 9_725, // 100.00 - 10.00 discount + 7.25 tax; the lines below sum to something else again
      amount_due: 1,
      lines: { data: [{ amount: 6_000 }, { amount: 5_000 }] },
      total_discount_amounts: [{ amount: 1_000 }],
      total_taxes: [{ amount: 725 }],
    });
    await deliver(eventBody("evt_i2", "invoice.finalized", "in_1"));
    expect(await invoiceRows(workspaceId)).toMatchObject([{ subtotal: "100.00", total: "97.25" }]);
  });

  it.each([
    ["invoice.created", "draft", null],
    ["invoice.finalized", "open", null],
    ["invoice.paid", "paid", T0 + 5],
    ["invoice.payment_failed", "open", null],
    ["invoice.voided", "void", null],
  ] as const)("scenario 9 · %s is consumed and recorded", async (type, status, paidAt) => {
    const { workspaceId } = await newWorkspace();
    stripeInvoice(workspaceId, { status, status_transitions: { paid_at: paidAt } });
    expect(outcomeOf(await deliver(eventBody(`evt_t_${type}`, type, "in_1")))).toBe("processed");
    expect(await invoiceRows(workspaceId)).toMatchObject([{ status }]);
  });

  it("scenario 9 · uncollectible is a recorded status (the contract covers it)", async () => {
    const { workspaceId } = await newWorkspace();
    stripeInvoice(workspaceId, { status: "uncollectible" });
    await deliver(eventBody("evt_unc", "invoice.payment_failed", "in_1"));
    expect(await invoiceRows(workspaceId)).toMatchObject([{ status: "uncollectible" }]);
  });

  it("scenario 9 · successive events for one invoice upsert ONE row on ux_invoices_stripe, each re-fetch writing the whole record", async () => {
    const { workspaceId } = await newWorkspace();
    stripeInvoice(workspaceId, { status: "draft", number: null, hosted_invoice_url: null, invoice_pdf: null });
    await deliver(eventBody("evt_u1", "invoice.created", "in_1"));
    stripeInvoice(workspaceId, { status: "open" });
    await deliver(eventBody("evt_u2", "invoice.finalized", "in_1"));
    stripeInvoice(workspaceId, { status: "paid", status_transitions: { paid_at: T0 + 9 } });
    await deliver(eventBody("evt_u3", "invoice.paid", "in_1"));
    const rows = await invoiceRows(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "paid", number: "NOM-0001", hosted_invoice_url: "https://invoice.stripe.test/i/in_1" });
  });

  it("scenario 9 · a redelivered event id is a no-op: one row, one audit row, the second answers duplicate", async () => {
    const { workspaceId } = await newWorkspace();
    stripeInvoice(workspaceId, { status: "paid", status_transitions: { paid_at: T0 + 1 } });
    const body = eventBody("evt_dup", "invoice.paid", "in_1");
    expect(outcomeOf(await deliver(body))).toBe("processed");
    expect(outcomeOf(await deliver(body))).toBe("duplicate");
    expect(await invoiceRows(workspaceId)).toHaveLength(1);
    expect(await invoiceAudits(workspaceId)).toHaveLength(1);
  });

  it("scenario 9 · a stale fetch cannot walk an invoice backwards: a held 'open' fetch committing after 'paid' leaves it paid", async () => {
    const { workspaceId } = await newWorkspace();
    stripeInvoice(workspaceId, { status: "open" });
    const release = gateway.holdNextFetch("invoice", "in_1"); // snapshots 'open', then waits
    const late = deliver(eventBody("evt_late", "invoice.finalized", "in_1"));
    await vi.waitFor(() => expect(gateway.fetches).toContain("invoice:in_1"));

    stripeInvoice(workspaceId, { status: "paid", status_transitions: { paid_at: T0 + 3 } });
    expect(outcomeOf(await deliver(eventBody("evt_paid", "invoice.paid", "in_1")))).toBe("processed");
    release();
    expect((await late).statusCode).toBe(200);
    expect(await invoiceRows(workspaceId)).toMatchObject([{ status: "paid" }]);
  });

  it("an invoice with no resolvable workspace, or for a workspace that does not exist, is acknowledged and writes nothing (not retried forever)", async () => {
    stripeInvoice(null, { id: "in_orphan" });
    const orphan = await deliver(eventBody("evt_o1", "invoice.created", "in_orphan"));
    expect(orphan.statusCode).toBe(200);
    expect(outcomeOf(orphan)).toBe("ignored");

    stripeInvoice(randomUUID(), { id: "in_ghost" });
    const ghost = await deliver(eventBody("evt_o2", "invoice.created", "in_ghost"));
    expect(ghost.statusCode).toBe(200);
    expect(outcomeOf(ghost)).toBe("ignored");
    expect((await harness.db().query("SELECT 1 FROM invoices")).rowCount).toBe(0);
  });

  it("an invoice Stripe states in a shape we cannot record (an unrecognised status) is refused with a warning, not guessed at", async () => {
    const { workspaceId } = await newWorkspace();
    const warn = vi.spyOn(Logger.prototype, "warn");
    stripeInvoice(workspaceId, { status: "refunded" });
    expect((await deliver(eventBody("evt_bad", "invoice.paid", "in_1"))).statusCode).toBe(200);
    expect(await invoiceRows(workspaceId)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  // ---- "Every state change writes an audit row" ----------------------------------------------------

  it("every invoice state change writes one audit row (actor_type 'system', the Stripe event id as request_id); an unchanged re-fetch writes none", async () => {
    const { workspaceId } = await newWorkspace();
    stripeInvoice(workspaceId, { status: "open" });
    await deliver(eventBody("evt_a1", "invoice.finalized", "in_1"));
    await deliver(eventBody("evt_a2", "invoice.payment_failed", "in_1")); // same state: nothing changed
    stripeInvoice(workspaceId, { status: "paid", status_transitions: { paid_at: T0 + 2 } });
    await deliver(eventBody("evt_a3", "invoice.paid", "in_1"));

    const audits = await invoiceAudits(workspaceId);
    expect(audits.map((a) => [a.actor_type, a.request_id, a.after_state.status, a.before_state?.status ?? null])).toEqual([
      ["system", "evt_a1", "open", null],
      ["system", "evt_a3", "paid", "open"],
    ]);
    const [{ id }] = await invoiceRows(workspaceId);
    expect(audits.every((a) => a.resource_type === "invoice" && a.resource_id === id)).toBe(true);
  });

  it("the audit row and the log line carry no hosted-invoice URL (a bearer link to pay) and the log names the workspace by id", async () => {
    const { workspaceId } = await newWorkspace();
    const log = vi.spyOn(Logger.prototype, "log");
    stripeInvoice(workspaceId, { status: "paid", status_transitions: { paid_at: T0 + 2 } });
    await deliver(eventBody("evt_pii", "invoice.paid", "in_1"));
    const [audit] = await invoiceAudits(workspaceId);
    expect(JSON.stringify(audit)).not.toContain("invoice.stripe.test");
    const lines = log.mock.calls.map((c) => JSON.stringify(c[0])).join("\n");
    expect(lines).toContain(workspaceId);
    expect(lines).not.toContain("invoice.stripe.test");
    expect(lines).not.toContain("NOM-0001");
  });

  // ---- STORY-075 AC10 / scenario 10 ----------------------------------------------------------------

  async function projectDue(workspaceId: string): Promise<string> {
    const id = randomUUID();
    await harness.db().query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, next_run_at)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', 'active', now() - interval '10 minutes')`,
      [id, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    return id;
  }
  async function claimed(): Promise<string[]> {
    const db = harness.db();
    await db.query("BEGIN");
    try {
      return (await claimDueProjects(db, new Date())).map((p) => p.projectId);
    } finally {
      await db.query("ROLLBACK");
    }
  }

  it("scenario 10 · a past_due subscription sets the subscription status AND the workspace status, with an audit row", async () => {
    const { workspaceId } = await newWorkspace();
    stripeSubscription(workspaceId, { status: "active" });
    await deliver(eventBody("evt_s1", "customer.subscription.created", "sub_1"));
    expect(await wsStatus(workspaceId)).toBe("active");

    stripeSubscription(workspaceId, { status: "past_due" });
    expect(outcomeOf(await deliver(eventBody("evt_s2", "customer.subscription.updated", "sub_1")))).toBe("processed");
    const sub = await harness.db().query("SELECT status, plan_key FROM subscriptions WHERE workspace_id = $1", [workspaceId]);
    expect(sub.rows[0]).toMatchObject({ status: "past_due", plan_key: "growth" });
    expect(await wsStatus(workspaceId)).toBe("past_due");

    const audit = await harness.db().query(
      "SELECT actor_type, request_id, before_state, after_state FROM audit_log WHERE workspace_id = $1 AND action = 'workspace.billing_status_changed'",
      [workspaceId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_type: "system", request_id: "evt_s2", before_state: { status: "active" }, after_state: { status: "past_due" } });
  });

  it("scenario 10 · THE SCHEDULER SKIPS A PAST-DUE WORKSPACE and picks it up again once the payment recovers", async () => {
    const { workspaceId } = await newWorkspace();
    const projectId = await projectDue(workspaceId);
    stripeSubscription(workspaceId, { status: "active" });
    await deliver(eventBody("evt_p1", "customer.subscription.created", "sub_1"));
    expect(await claimed()).toContain(projectId);

    stripeSubscription(workspaceId, { status: "past_due" });
    await deliver(eventBody("evt_p2", "customer.subscription.updated", "sub_1"));
    expect(await claimed()).not.toContain(projectId);

    stripeSubscription(workspaceId, { status: "active" });
    await deliver(eventBody("evt_p3", "customer.subscription.updated", "sub_1"));
    expect(await wsStatus(workspaceId)).toBe("active");
    expect(await claimed()).toContain(projectId);
  });

  it("scenario 10 · a past_due redelivery or a second past_due event is a no-op: one status audit row", async () => {
    const { workspaceId } = await newWorkspace();
    stripeSubscription(workspaceId, { status: "past_due" });
    await deliver(eventBody("evt_r1", "customer.subscription.created", "sub_1"));
    await deliver(eventBody("evt_r2", "customer.subscription.updated", "sub_1"));
    const audits = await harness.db().query("SELECT 1 FROM audit_log WHERE workspace_id = $1 AND action = 'workspace.billing_status_changed'", [workspaceId]);
    expect(audits.rowCount).toBe(1);
  });

  it.each(["soft_capped", "suspended"])("scenario 10 · a %s workspace is NOT overwritten by billing: past_due must not lift a stronger restriction", async (status) => {
    const { workspaceId } = await newWorkspace();
    stripeSubscription(workspaceId, { status: "active" });
    await deliver(eventBody("evt_k1", "customer.subscription.created", "sub_1"));
    await harness.db().query("UPDATE workspaces SET status = $2 WHERE id = $1", [workspaceId, status]);
    stripeSubscription(workspaceId, { status: "past_due" });
    await deliver(eventBody("evt_k2", "customer.subscription.updated", "sub_1"));
    expect(await wsStatus(workspaceId)).toBe(status);
    stripeSubscription(workspaceId, { status: "active" });
    await deliver(eventBody("evt_k3", "customer.subscription.updated", "sub_1"));
    expect(await wsStatus(workspaceId)).toBe(status);
  });

  it("scenario 10 · a subscription that ends while past_due returns the workspace to a capturable status on the free plan", async () => {
    const { workspaceId } = await newWorkspace();
    stripeSubscription(workspaceId, { status: "past_due" });
    await deliver(eventBody("evt_e1", "customer.subscription.created", "sub_1"));
    expect(await wsStatus(workspaceId)).toBe("past_due");
    stripeSubscription(workspaceId, { status: "canceled" });
    await deliver(eventBody("evt_e2", "customer.subscription.deleted", "sub_1"));
    expect(await wsStatus(workspaceId)).toBe("active");
  });

  // ---- GET /billing/invoices ------------------------------------------------------------------------

  async function seedInvoice(workspaceId: string, over: { id?: string; status?: string; periodStart?: Date; total?: string } = {}): Promise<string> {
    const id = randomUUID();
    await harness.db().query(
      `INSERT INTO invoices (id, workspace_id, stripe_invoice_id, number, status, subtotal, total, period_start, period_end, hosted_invoice_url)
       VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$7,$8)`,
      [id, workspaceId, `in_${id}`, `N-${id.slice(0, 6)}`, over.status ?? "paid", over.total ?? "10.00", over.periodStart ?? new Date(T0 * 1000), `https://invoice.stripe.test/i/${id}`],
    );
    return id;
  }

  it("GET /billing/invoices is billing:read: owner and admin read, manager and viewer get a 403 naming the permission", async () => {
    const { workspaceId, owner } = await newWorkspace();
    expect((await get(owner, "/billing/invoices")).statusCode).toBe(200);
    expect((await get(await actorIn(workspaceId, "admin"), "/billing/invoices")).statusCode).toBe(200);
    for (const role of ["manager", "viewer"] as const) {
      const res = await get(await actorIn(workspaceId, role), "/billing/invoices");
      expect(res.statusCode, role).toBe(403);
      expect(res.body).toContain("billing:read");
    }
  });

  it("GET /billing/invoices · a workspace never invoiced gets an empty list, not an error, and no next page", async () => {
    const { owner } = await newWorkspace();
    const res = await get(owner, "/billing/invoices");
    expect(res.statusCode).toBe(200);
    expect(dataOf<unknown[]>(res)).toEqual([]);
    expect(res.json<{ pagination: { has_more: boolean; cursor_next: string | null } }>().pagination).toMatchObject({ has_more: false, cursor_next: null });
  });

  it("GET /billing/invoices · returns the contract: money as two-digit strings, nullable URLs and paid_at, newest period first", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await seedInvoice(workspaceId, { periodStart: new Date((T0 - 86_400) * 1000), total: "5.00" });
    await seedInvoice(workspaceId, { periodStart: new Date(T0 * 1000), total: "116.10" });
    const res = await get(owner, "/billing/invoices");
    const data = dataOf<unknown[]>(res);
    expect(invoiceListResponseSchema.safeParse(data).success).toBe(true);
    expect(data.map((i) => invoiceSchema.parse(i).total)).toEqual(["116.10", "5.00"]);
    expect(data[0]).toMatchObject({ currency: "USD", pdf_url: null, paid_at: null, addon_amount: "0.00", credit_pack_amount: "0.00" });
  });

  it("STORY-075b audit · an invoice that charged for an add-on publishes addon_amount from its lines (49.00), and an update rewrites it", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const planLine = { amount: 12_900, pricing: { price_details: { product: "prod_plan" } } };
    const addonLine = { amount: 4_900, pricing: { price_details: { product: { id: "nominara_addon_extra_project", metadata: { nominara_kind: "extra_project" } } } } };
    stripeInvoice(workspaceId, { status: "open", subtotal: 17_800, total: 17_800, lines: { data: [planLine, addonLine] } });
    expect(outcomeOf(await deliver(eventBody("evt_addon_1", "invoice.finalized", "in_1")))).toBe("processed");
    const first = dataOf<Array<Record<string, unknown>>>(await get(owner, "/billing/invoices"));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ subtotal: "178.00", total: "178.00", addon_amount: "49.00", credit_pack_amount: "0.00" });

    // The same invoice re-fetched with the add-on line gone: the stored figure follows Stripe.
    stripeInvoice(workspaceId, { status: "open", subtotal: 12_900, total: 12_900, lines: { data: [planLine] }, number: "NOM-0002" });
    expect(outcomeOf(await deliver(eventBody("evt_addon_2", "invoice.updated", "in_1")))).toBe("processed");
    const second = dataOf<Array<Record<string, unknown>>>(await get(owner, "/billing/invoices"));
    expect(second[0]).toMatchObject({ addon_amount: "0.00", total: "129.00" });
  });

  it("GET /billing/invoices · the cursor walks every invoice exactly once, including rows that share a period_start", async () => {
    const { workspaceId, owner } = await newWorkspace();
    const same = new Date(T0 * 1000);
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) ids.add(await seedInvoice(workspaceId, { periodStart: i < 3 ? same : new Date((T0 - (i + 1) * 3600) * 1000) }));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const res = await get(owner, `/billing/invoices?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
      expect(res.statusCode, res.body).toBe(200);
      seen.push(...dataOf<Array<{ id: string }>>(res).map((i) => i.id));
      const p = res.json<{ pagination: { has_more: boolean; cursor_next: string | null } }>().pagination;
      if (!p.has_more) break;
      cursor = p.cursor_next;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(ids);
  });

  it("GET /billing/invoices · filters by status; an unknown status, an unknown key and a forged cursor are 400s", async () => {
    const { workspaceId, owner } = await newWorkspace();
    await seedInvoice(workspaceId, { status: "paid" });
    await seedInvoice(workspaceId, { status: "open" });
    expect(dataOf<Array<{ status: string }>>(await get(owner, "/billing/invoices?status=open")).map((i) => i.status)).toEqual(["open"]);
    expect((await get(owner, "/billing/invoices?status=refunded")).statusCode).toBe(400);
    expect((await get(owner, "/billing/invoices?workspace_id=" + randomUUID())).statusCode).toBe(400);
    expect((await get(owner, "/billing/invoices?cursor=Zm9yZ2Vk")).statusCode).toBe(400);
  });

  // ---- tenant isolation: RLS alone ------------------------------------------------------------------

  it("tenant isolation · the list returns only the caller's invoices (the query carries no workspace_id predicate; RLS is the guarantee)", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    const mine = await seedInvoice(a.workspaceId);
    await seedInvoice(b.workspaceId);
    await seedInvoice(b.workspaceId);
    expect(dataOf<Array<{ id: string }>>(await get(a.owner, "/billing/invoices")).map((i) => i.id)).toEqual([mine]);
  });

  it("tenant isolation · as nominara_app, an unfiltered read in A's context sees none of B's rows and cannot write one for B", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    await seedInvoice(a.workspaceId);
    await seedInvoice(b.workspaceId);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "nominara_app";
    url.password = resolvePassword("nominara_app", {});
    const app = new Pool({ connectionString: url.toString() });
    try {
      const client = await app.connect();
      try {
        await withTenantContext(client, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          const seen = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM invoices");
          expect(seen.rows.map((r) => r.workspace_id)).toEqual([a.workspaceId]);
        });
        await expect(
          withTenantContext(client, { workspaceId: a.workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
            tx.query(
              `INSERT INTO invoices (workspace_id, stripe_invoice_id, status, subtotal, total, period_start, period_end)
               VALUES ($1, 'in_forged', 'paid', 1, 1, now(), now())`,
              [b.workspaceId],
            ),
          ),
        ).rejects.toThrow();
      } finally {
        client.release();
      }
    } finally {
      await app.end();
    }
  });

  it("tenant isolation · an invoice event for workspace A writes nothing in workspace B", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    stripeInvoice(a.workspaceId, { status: "paid", status_transitions: { paid_at: T0 } });
    await deliver(eventBody("evt_iso", "invoice.paid", "in_1"));
    expect(await invoiceRows(b.workspaceId)).toHaveLength(0);
    expect(await invoiceRows(a.workspaceId)).toHaveLength(1);
  });
});

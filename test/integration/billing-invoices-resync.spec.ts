import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { resyncInvoices } from "../../src/workers/billing/invoices-resync.js";
import { FakeStripeGateway } from "../support/fake-stripe-gateway.js";

// The one-off operator re-sync (`pnpm billing:invoices-resync`): a recorded invoice that Stripe will never redeliver (a
// paid first invoice is terminal) is fetched again and written through BillingInvoicesService.record. The real Postgres,
// RLS in force on the write side (nominara_app); Stripe is the fake gateway, so NO TEST CALLS THE REAL STRIPE API.

const CREATED = 1_760_486_400; // 2025-10-15T00:00:00Z
const NEXT = CREATED + 31 * 86_400;
const at = (s: number): number => s * 1000;

describe("billing:invoices-resync", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  let pool: Pool;
  const gateway = new FakeStripeGateway();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    admin = new Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await migrateUp(admin, MIGRATIONS_DIR);
    await admin.query(`ALTER ROLE nominara_app PASSWORD '${resolvePassword("nominara_app", {})}'`);
    const url = new URL(container.getConnectionUri());
    url.username = "nominara_app";
    url.password = resolvePassword("nominara_app", {});
    pool = new Pool({ connectionString: url.toString() });
  }, 300_000);
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
    await container?.stop();
  });

  async function workspace(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'W',$2,'free')`, [id, `w-${id.slice(0, 8)}`]);
    return id;
  }
  /** A row as the OLD code recorded a first invoice: invoice-level start == end == creation, no due_at. */
  async function oldRow(workspaceId: string, stripeId: string, status = "paid"): Promise<void> {
    await admin.query(
      `INSERT INTO invoices (workspace_id, stripe_invoice_id, status, subtotal, total, period_start, period_end)
       VALUES ($1,$2,$3,129,129,to_timestamp($4),to_timestamp($4))`,
      [workspaceId, stripeId, status, CREATED],
    );
  }
  function stripeHas(id: string, over: Record<string, unknown> = {}): void {
    gateway.putObject("invoice", id, {}, {
      number: `N-${id}`,
      status: "paid",
      subtotal: 12_900,
      total: 12_900,
      currency: "usd",
      period_start: CREATED,
      period_end: CREATED,
      status_transitions: { paid_at: CREATED + 60 },
      lines: {
        data: [{ amount: 12_900, period: { start: CREATED, end: NEXT }, parent: { type: "subscription_item_details", subscription_item_details: { proration: false } }, pricing: { price_details: { product: "prod_growth" } } }],
      },
      ...over,
    });
  }
  const rows = async (workspaceId: string) =>
    (await admin.query("SELECT stripe_invoice_id, period_start, period_end, due_at FROM invoices WHERE workspace_id = $1 ORDER BY stripe_invoice_id", [workspaceId])).rows;
  const audits = async (workspaceId: string) =>
    (await admin.query("SELECT request_id, before_state, after_state FROM audit_log WHERE workspace_id = $1 AND action = 'billing.invoice_recorded' ORDER BY seq", [workspaceId])).rows;
  const run = () => resyncInvoices({ discovery: admin, pool, gateway });

  it("corrects a terminal paid first invoice to the service period, records due_at, and writes an audit row with the period before and after", async () => {
    const w = await workspace();
    await oldRow(w, "in_paid_first");
    stripeHas("in_paid_first");
    const counts = await run();
    expect(counts).toMatchObject({ scanned: 1, updated: 1, failed: 0 });
    const [row] = await rows(w);
    expect(row.period_start.getTime()).toBe(at(CREATED));
    expect(row.period_end.getTime()).toBe(at(NEXT));
    expect(row.due_at.getTime()).toBe(at(CREATED));
    const [audit] = await audits(w);
    expect(audit.request_id).toBe("resync:in_paid_first");
    expect(audit.before_state).toMatchObject({ period_start: new Date(at(CREATED)).toISOString(), period_end: new Date(at(CREATED)).toISOString() });
    expect(audit.after_state).toMatchObject({ period_end: new Date(at(NEXT)).toISOString(), due_at: new Date(at(CREATED)).toISOString() });  // (event_type is redacted by the audit writer; request_id carries the provenance)
  });

  it("is idempotent: a second run changes nothing and writes no further audit row", async () => {
    const w = await workspace();
    await oldRow(w, "in_idem");
    stripeHas("in_idem");
    await run();
    const before = await audits(w);
    const again = await run();
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBeGreaterThanOrEqual(1);
    expect(await audits(w)).toHaveLength(before.length);
  });

  it("writes only for invoices that exist: a workspace with none gets nothing, and Stripe invoices we never recorded are not created", async () => {
    const empty = await workspace();
    stripeHas("in_never_recorded");
    await run();
    expect((await admin.query("SELECT 1 FROM invoices WHERE workspace_id = $1 OR stripe_invoice_id = 'in_never_recorded'", [empty])).rowCount).toBe(0);
    expect(await audits(empty)).toHaveLength(0);
  });

  it("an invoice Stripe no longer has, or one that cannot be recorded, is skipped and left as it was; a Stripe outage is counted failed, not thrown", async () => {
    const w = await workspace();
    await oldRow(w, "in_gone");
    await oldRow(w, "in_bad");
    stripeHas("in_bad", { total: "not cents" });
    const counts = await run();
    expect(counts.skipped).toBeGreaterThanOrEqual(2);
    expect((await rows(w)).map((r) => r.period_end.getTime())).toEqual([at(CREATED), at(CREATED)]);
    gateway.failFetchWith = new Error("stripe down");
    try {
      expect((await run()).failed).toBeGreaterThanOrEqual(1);
    } finally {
      gateway.failFetchWith = undefined;
    }
  });

  it("a stale Stripe state (still open) never walks a paid row backwards", async () => {
    const w = await workspace();
    await oldRow(w, "in_stale", "paid");
    stripeHas("in_stale", { status: "open", status_transitions: { paid_at: null } });
    const counts = await run();
    expect(counts.stale).toBeGreaterThanOrEqual(1);
    expect((await rows(w))[0].period_end.getTime()).toBe(at(CREATED));
  });

  it("the output carries counts only", async () => {
    const counts = await run();
    expect(Object.values(counts).every((v) => typeof v === "number")).toBe(true);
  });
});

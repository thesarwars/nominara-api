import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { redactState } from "../../src/lib/crypto/redact.js";
import { StripeUpstreamError } from "../../src/lib/billing/stripe/stripe-gateway.js";
import { BillingInvoicesService } from "../../src/modules/billing/billing-invoices.service.js";
import { CrossTenantVisibilityError, formatCounts, resyncInvoices } from "../../src/workers/billing/invoices-resync.js";
import { FakeStripeGateway } from "../support/fake-stripe-gateway.js";

// The one-off operator re-sync (`pnpm billing:invoices-resync`): a recorded invoice that Stripe will never redeliver (a
// paid first invoice is terminal) is fetched again and written through BillingInvoicesService.record. The real Postgres,
// RLS in force on the write side (nominara_app); Stripe is the fake gateway, so NO TEST CALLS THE REAL STRIPE API.

// 2026-09-28T17:34:56Z: its ISO string is one of the ~1.7% that redactState masks as a "high-entropy secret".
const CREATED = Date.UTC(2026, 8, 28, 17, 34, 56) / 1000;
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
  function stripeHas(id: string, workspaceId: string | null, over: Record<string, unknown> = {}): void {
    gateway.putObject("invoice", id, workspaceId === null ? {} : { workspace_id: workspaceId }, {
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
    (await admin.query("SELECT request_id, actor_ua, before_state, after_state FROM audit_log WHERE workspace_id = $1 AND action = 'billing.invoice_recorded' ORDER BY seq", [workspaceId])).rows;
  const run = () => resyncInvoices({ discovery: admin, pool, gateway, operator: "alice", ticket: "TCK-1" });

  it("corrects a terminal paid first invoice to the service period, records due_at, and writes an audit row with the period before and after", async () => {
    const w = await workspace();
    await oldRow(w, "in_paid_first");
    stripeHas("in_paid_first", w);
    const counts = await run();
    expect(counts).toMatchObject({ scanned: 1, updated: 1, failed: 0, mismatched: 0 });
    const [row] = await rows(w);
    expect(row.period_start.getTime()).toBe(at(CREATED));
    expect(row.period_end.getTime()).toBe(at(NEXT));
    expect(row.due_at.getTime()).toBe(at(CREATED));
    const [audit] = await audits(w);
    expect(audit.request_id).toBe("TCK-1");
    expect(audit.actor_ua).toBe("operator:invoices-resync:alice");
    // Integer epoch seconds: a high-entropy ISO string would have been stored as "[redacted]".
    expect(redactState({ t: new Date(at(CREATED)).toISOString() })).toEqual({ t: "[redacted]" });
    expect(audit.before_state).toMatchObject({ period_start: CREATED, period_end: CREATED, due_at: null });
    expect(audit.after_state).toMatchObject({ period_start: CREATED, period_end: NEXT, due_at: CREATED, event_type: "resync" });
  });

  it("is idempotent: a second run changes nothing and writes no further audit row", async () => {
    const w = await workspace();
    await oldRow(w, "in_idem");
    stripeHas("in_idem", w);
    await run();
    const before = await audits(w);
    const again = await run();
    expect(again.updated).toBe(0);
    expect(again.unchanged).toBeGreaterThanOrEqual(1);
    expect(await audits(w)).toHaveLength(before.length);
  });

  it("writes only for invoices that exist: a workspace with none gets nothing, and Stripe invoices we never recorded are not created", async () => {
    const empty = await workspace();
    stripeHas("in_never_recorded", empty);
    await run();
    expect((await admin.query("SELECT 1 FROM invoices WHERE workspace_id = $1 OR stripe_invoice_id = 'in_never_recorded'", [empty])).rowCount).toBe(0);
    expect(await audits(empty)).toHaveLength(0);
  });

  it("an invoice Stripe no longer has, or one that cannot be recorded, is skipped and left as it was", async () => {
    const w = await workspace();
    await oldRow(w, "in_gone");
    await oldRow(w, "in_bad");
    stripeHas("in_bad", w, { total: "not cents" });
    const counts = await run();
    expect(counts.skipped).toBeGreaterThanOrEqual(2);
    expect((await rows(w)).map((r) => r.period_end.getTime())).toEqual([at(CREATED), at(CREATED)]);
  });

  it("a stale Stripe state (still open) never walks a paid row backwards", async () => {
    const w = await workspace();
    await oldRow(w, "in_stale", "paid");
    stripeHas("in_stale", w, { status: "open", status_transitions: { paid_at: null } });
    const counts = await run();
    expect(counts.stale).toBeGreaterThanOrEqual(1);
    expect((await rows(w))[0].period_end.getTime()).toBe(at(CREATED));
  });

  it("a Stripe outage is bucketed stripe_upstream, any other error other; neither throws and neither writes", async () => {
    const w = await workspace();
    await oldRow(w, "in_outage");
    stripeHas("in_outage", w);
    try {
      gateway.failFetchWith = new StripeUpstreamError(503);
      expect(await run()).toMatchObject({ failed: expect.any(Number), failed_stripe_upstream: expect.any(Number) });
      const up = await run();
      expect(up.failed_stripe_upstream).toBeGreaterThanOrEqual(1);
      expect(up.failed).toBe(up.failed_stripe_upstream);
      gateway.failFetchWith = new Error("boom");
      const other = await run();
      expect(other.failed_other).toBeGreaterThanOrEqual(1);
      expect(other.failed).toBe(other.failed_other);
    } finally {
      gateway.failFetchWith = undefined;
    }
    expect((await rows(w))[0].period_end.getTime()).toBe(at(CREATED));
  });

  it("REFUSES to scan as the NOBYPASSRLS owner (FORCE RLS would show it zero rows and 'succeed'): nothing is fetched, nothing written", async () => {
    const w = await workspace();
    await oldRow(w, "in_refuse");
    stripeHas("in_refuse", w);
    const attrs = (await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nominara_owner'")).rows[0];
    expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false });
    const owner = new Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
    try {
      await owner.query("SET ROLE nominara_owner");
      gateway.fetches.length = 0;
      await expect(resyncInvoices({ discovery: owner, pool, gateway, operator: "alice", ticket: "TCK-1" })).rejects.toBeInstanceOf(CrossTenantVisibilityError);
      expect(gateway.fetches).toEqual([]);
    } finally {
      await owner.end();
    }
    expect((await rows(w))[0].period_end.getTime()).toBe(at(CREATED));
  });

  it("an invoice whose Stripe metadata names ANOTHER workspace (or none) is counted mismatched and writes nothing to either workspace", async () => {
    const a = await workspace();
    const b = await workspace();
    await oldRow(a, "in_cross_a");
    await oldRow(b, "in_cross_b");
    await oldRow(a, "in_nometa");
    stripeHas("in_cross_a", b); // A's row, but Stripe says it belongs to B
    stripeHas("in_cross_b", b); // B's row, consistent
    stripeHas("in_nometa", null);
    const counts = await run();
    expect(counts.mismatched).toBeGreaterThanOrEqual(2);
    expect((await rows(a)).map((r) => r.period_end.getTime())).toEqual([at(CREATED), at(CREATED)]);
    expect(await audits(a)).toHaveLength(0);
    expect((await rows(b))[0].period_end.getTime()).toBe(at(NEXT)); // the consistent one was corrected
  });

  it("a soft-deleted workspace's invoices are not touched", async () => {
    const w = await workspace();
    await oldRow(w, "in_deleted_ws");
    stripeHas("in_deleted_ws", w);
    await admin.query("UPDATE workspaces SET deleted_at = now() WHERE id = $1", [w]);
    gateway.fetches.length = 0;
    await run();
    expect(gateway.fetches).not.toContain("invoice:in_deleted_ws");
    expect((await rows(w))[0].period_end.getTime()).toBe(at(CREATED));
  });

  it("a row that vanished after the scan is NOT recreated: unexpected_insert, rolled back, no audit row", async () => {
    const w = await workspace();
    await oldRow(w, "in_vanish");
    stripeHas("in_vanish", w);
    class Vanishing extends BillingInvoicesService {
      override async record(...args: Parameters<BillingInvoicesService["record"]>): ReturnType<BillingInvoicesService["record"]> {
        await admin.query("DELETE FROM invoices WHERE stripe_invoice_id = 'in_vanish'");
        return super.record(...args);
      }
    }
    const counts = await resyncInvoices({ discovery: admin, pool, gateway, operator: "alice", ticket: "TCK-1", invoices: new Vanishing() });
    expect(counts.unexpected_insert).toBeGreaterThanOrEqual(1);
    expect(await rows(w)).toHaveLength(0);
    expect(await audits(w)).toHaveLength(0);
  });

  it("what the command prints is the counts and nothing else: no workspace uuid, no Stripe invoice id", async () => {
    const w = await workspace();
    await oldRow(w, "in_print_check");
    stripeHas("in_print_check", w);
    const printed = formatCounts(await run());
    expect(printed).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    expect(printed).not.toMatch(/\bin_/u);
    expect(Object.values(JSON.parse(printed) as Record<string, unknown>).every((v) => typeof v === "number")).toBe(true);
  });
});

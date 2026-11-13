import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import type { Job } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createBillingStripeDriftHandler } from "../../src/lib/queue/handlers/billing-stripe-drift.handler.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { FakeStripeGateway } from "../support/fake-stripe-gateway.js";

// STORY-075 AC11 / owner decision 2026-10-28 section 100(e): the nightly drift check reads cross-tenant (owner connection) and ALERTS ONLY.
// Fake gateway; never Stripe.

const metrics: { name: string; labels: Record<string, unknown> }[] = [];
vi.mock("../../src/lib/telemetry/metrics.js", () => ({
  incrementCounter: (name: string, labels: Record<string, unknown> = {}) => void metrics.push({ name, labels }),
  observeValue: () => undefined,
}));

describe("STORY-075 AC11 · billing.stripe_drift handler against Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  const T0 = Date.UTC(2026, 10, 1) / 1000;
  const T1 = Date.UTC(2026, 11, 1) / 1000;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);
  afterAll(async () => {
    await db.end();
    await container.stop();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE subscriptions, workspaces CASCADE");
    metrics.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  async function seed(subId: string, provider: string, over: { status?: string } = {}): Promise<string> {
    const ws = await db.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'free') RETURNING id", [`w-${Math.random().toString(36).slice(2, 10)}`]);
    const id = ws.rows[0]!.id;
    await db.query(
      `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id, status, provider,
                                  current_period_start, current_period_end, seats_purchased, projects_purchased)
       VALUES ($1,'growth','monthly','cus_1',$2,$3,$4, to_timestamp($5), to_timestamp($6), 3, 2)`,
      [id, subId, over.status ?? "active", provider, T0, T1],
    );
    return id;
  }

  const snapshot = async (): Promise<string> => {
    const out: unknown[] = [];
    for (const table of ["subscriptions", "workspaces", "credit_wallets", "credit_ledger", "entitlements"]) {
      const exists = await db.query("SELECT to_regclass($1) AS t", [table]);
      if (exists.rows[0].t === null) continue;
      out.push((await db.query(`SELECT row_to_json(t)::text AS r FROM ${table} t ORDER BY 1`)).rows);
    }
    return JSON.stringify(out);
  };

  const run = async (gateway: FakeStripeGateway): Promise<unknown> =>
    createBillingStripeDriftHandler({ pool: undefined as never, env: { DATABASE_URL: container.getConnectionUri() } } as unknown as QueueHandlerContext, { gateway })(
      db as never,
      { data: {} } as unknown as Job,
    );

  const item = (kind: string, quantity: number): Record<string, unknown> => ({ quantity, price: { product: { metadata: { nominara_kind: kind } } } });

  it("[STORY-075 AC11] reads only provider='stripe' rows, reports drift, and writes nothing", async () => {
    await seed("sub_drift", "stripe");
    await seed("sub_clean", "stripe");
    await seed("sub_operator", "operator");
    await seed("local_sub_x", "stripe");
    const gateway = new FakeStripeGateway();
    const base = { current_period_start: T0, current_period_end: T1, cancel_at_period_end: false, items: { data: [item("plan", 1), item("extra_seat", 2), item("extra_project", 2)] } };
    gateway.putObject("subscription", "sub_drift", { plan_key: "growth" }, { ...base, status: "past_due" });
    gateway.putObject("subscription", "sub_clean", { plan_key: "growth" }, { ...base, status: "active" });

    const before = await snapshot();
    const result = await run(gateway);
    expect(result).toMatchObject({ checked: 2, drifted: 1, errors: 0 });
    expect([...gateway.fetches].sort()).toEqual(["subscription:sub_clean", "subscription:sub_drift"]);
    expect(metrics.filter((m) => m.name === "nominara_billing_stripe_drift_total").map((m) => m.labels.field)).toEqual(["status"]);
    expect(await snapshot()).toBe(before);
  });

  it("[STORY-075 AC11] a deleted remote subscription is reported and the table is unchanged", async () => {
    await seed("sub_gone", "stripe");
    const before = await snapshot();
    await run(new FakeStripeGateway());
    expect(metrics.filter((m) => m.name === "nominara_billing_stripe_drift_total").map((m) => m.labels.field)).toEqual(["remote_missing"]);
    expect(await snapshot()).toBe(before);
  });

  it("[STORY-075 AC11] an unconfigured Stripe skips the run visibly, fetching nothing", async () => {
    await seed("sub_a", "stripe");
    const gateway = new FakeStripeGateway();
    gateway.configured = false;
    expect(await run(gateway)).toBeNull();
    expect(gateway.fetches).toEqual([]);
    expect(metrics.some((m) => m.name === "nominara_billing_stripe_drift_skipped_total")).toBe(true);
  });
});

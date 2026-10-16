import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { assertNotStripeTracked, PlanSetStripeTrackedError } from "../../src/workers/billing/plan-set.js";

// STORY-184 (owner decision 2026-10-16) - `plan:set` is BLOCKED on a workspace whose subscription is Stripe-tracked and not ended.
// A comp written over a tracked subscription is invisible to Stripe, and the webhook gate would then refuse every later event for
// it as a relabel. The guard runs inside the same transaction as the plan write.
describe("STORY-184 · plan:set refuses a Stripe-tracked workspace", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 180_000);
  afterAll(async () => {
    await container.stop();
  });
  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT USAGE ON SCHEMA public TO PUBLIC");
    await migrateUp(client);
  });
  afterEach(async () => {
    await client.end();
  });

  async function workspace(sub: { plan: string; provider: string; status: string } | null): Promise<string> {
    const ws = await client.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W', $1, 'free') RETURNING id", [`w-${Math.random().toString(36).slice(2, 10)}`]);
    const id = ws.rows[0]!.id;
    if (sub !== null) {
      await client.query(
        `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id, status, provider, current_period_start, current_period_end)
         VALUES ($1,$2,'monthly','cus_1',$3,$4,$5, now(), now() + interval '30 days')`,
        [id, sub.plan, sub.provider === "stripe" ? `sub_${id}` : "", sub.status, sub.provider],
      );
    }
    return id;
  }

  it.each(["active", "trialing", "past_due"])("refuses a %s Stripe subscription on a paid plan, naming why and what to do instead", async (status) => {
    const id = await workspace({ plan: "growth", provider: "stripe", status });
    const error = await assertNotStripeTracked(client, id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanSetStripeTrackedError);
    expect((error as Error).message).toMatch(/billed through Stripe/u);
    expect((error as Error).message).toMatch(/relabel/u);
  });

  it("allows an ENDED Stripe subscription (the webhook reconciled it to free; the row keeps provider stripe): a comp there is legitimate", async () => {
    await expect(assertNotStripeTracked(client, await workspace({ plan: "free", provider: "stripe", status: "active" }))).resolves.toBeUndefined();
  });

  it("allows an operator-comped or provider-less workspace, and one with no subscription row", async () => {
    await expect(assertNotStripeTracked(client, await workspace({ plan: "growth", provider: "operator", status: "active" }))).resolves.toBeUndefined();
    await expect(assertNotStripeTracked(client, await workspace({ plan: "free", provider: "none", status: "active" }))).resolves.toBeUndefined();
    await expect(assertNotStripeTracked(client, await workspace(null))).resolves.toBeUndefined();
  });

  it("a cancelled subscription row (not live) does not block", async () => {
    await expect(assertNotStripeTracked(client, await workspace({ plan: "growth", provider: "stripe", status: "canceled" }))).resolves.toBeUndefined();
  });

  it("is per workspace: another workspace's Stripe subscription does not block this one", async () => {
    await workspace({ plan: "growth", provider: "stripe", status: "active" });
    await expect(assertNotStripeTracked(client, await workspace({ plan: "free", provider: "none", status: "active" }))).resolves.toBeUndefined();
  });
});

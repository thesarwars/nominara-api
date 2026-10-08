import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { applyPlanChange, type ProviderSubscriptionState } from "../../src/lib/billing/apply-plan.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-D-7 checkpoint-3 finding 3 — `auto_topup_count_cycle` was reset by nothing, so `max_per_cycle` was a
// LIFETIME cap. EC-48: "the counter resets only at cycle roll". The cycle that really rolls today is the
// BILLING cycle: `applyPlanChange` is the single writer of `subscriptions.current_period_start`, and Stripe's
// renewal reaches it as a reconciled period that starts later than the one on file. (`credit_wallets.cycle_*`
// is never rolled by anything in src/ — see wallet.ts `cycleHasLapsed` — so it cannot be the trigger.)
describe("NEW-D-7 checkpoint-3 · the auto-top-up counter resets when the billing period rolls", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    const appUri = new URL(container.getConnectionUri());
    appUri.username = "nominara_app";
    appUri.password = resolvePassword("nominara_app", {});
    pool = new Pool({ connectionString: appUri.toString(), max: 4 });
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await pool.end();
    await container.stop();
  });

  const PERIOD_1 = new Date("2026-10-01T00:00:00Z");
  const PERIOD_2 = new Date("2026-11-01T00:00:00Z");
  const PERIOD_3 = new Date("2026-12-01T00:00:00Z");

  let workspaceId: string;

  async function workspaceOnGrowth(): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key)
       VALUES ($1,$2,$3,'in_house','us-east-1','UTC','growth')`,
      [id, `ws-${id}`, `ws-${id}`],
    );
    await db.query(
      `INSERT INTO subscriptions
         (id, workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
          status, current_period_start, current_period_end, trial_ends_at)
       VALUES ($1,$2,'growth','monthly',$3,$4,'active', $5, $6, NULL)`,
      [uuidV7(), id, `cus_${id}`, `sub_${id}`, PERIOD_1, PERIOD_2],
    );
    await db.query(
      `INSERT INTO credit_wallets
         (workspace_id, included_balance, cycle_start, cycle_end,
          auto_topup_enabled, auto_topup_pack_key, auto_topup_threshold, auto_topup_max_per_cycle, auto_topup_count_cycle)
       VALUES ($1, 100, '2026-10-01', '2026-11-01', true, 'starter_vault', 50, 3, 3)`,
      [id],
    );
    return id;
  }

  const counter = async (ws: string) =>
    (await db.query<{ n: number }>("SELECT auto_topup_count_cycle AS n FROM credit_wallets WHERE workspace_id = $1", [ws])).rows[0]?.n;

  /** Reconciles the subscription exactly as a fresh-fetch webhook does: a complete record, period and all. */
  async function reconcileTo(ws: string, patch: Partial<ProviderSubscriptionState>): Promise<void> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, ws, (current) => ({ ...current, ...patch }), { requestId: "evt_1", operator: "stripe-webhook", reason: "test" }, { allowDowngrade: true }),
      );
    } finally {
      client.release();
    }
  }

  beforeEach(async () => {
    workspaceId = await workspaceOnGrowth();
  });

  it("NEW-D-7-CYC-1 · a renewal into a LATER billing period zeroes the counter", async () => {
    expect(await counter(workspaceId)).toBe(3);
    await reconcileTo(workspaceId, { currentPeriodStart: PERIOD_2, currentPeriodEnd: PERIOD_3 });
    expect(await counter(workspaceId)).toBe(0);
  });

  it("NEW-D-7-CYC-2 · the reset keeps the configuration: enabled, pack, threshold and cap are untouched", async () => {
    await reconcileTo(workspaceId, { currentPeriodStart: PERIOD_2, currentPeriodEnd: PERIOD_3 });
    const row = (
      await db.query("SELECT auto_topup_enabled, auto_topup_pack_key, auto_topup_threshold, auto_topup_max_per_cycle FROM credit_wallets WHERE workspace_id = $1", [workspaceId])
    ).rows[0];
    expect(row).toEqual({ auto_topup_enabled: true, auto_topup_pack_key: "starter_vault", auto_topup_threshold: 50, auto_topup_max_per_cycle: 3 });
  });

  it("NEW-D-7-CYC-3 · a reconcile INSIDE the same period (a seat change, an add-on, a redelivery) does not reset it", async () => {
    await reconcileTo(workspaceId, { seatsPurchased: 4 });
    expect(await counter(workspaceId)).toBe(3);
    await reconcileTo(workspaceId, { seatsPurchased: 4, cancelAtPeriodEnd: true });
    expect(await counter(workspaceId)).toBe(3);
  });

  it("NEW-D-7-CYC-4 · replaying the renewal does not zero the NEW period's count (idempotent under redelivery)", async () => {
    await reconcileTo(workspaceId, { currentPeriodStart: PERIOD_2, currentPeriodEnd: PERIOD_3 });
    await db.query("UPDATE credit_wallets SET auto_topup_count_cycle = 2 WHERE workspace_id = $1", [workspaceId]);
    await reconcileTo(workspaceId, { currentPeriodStart: PERIOD_2, currentPeriodEnd: PERIOD_3 });
    expect(await counter(workspaceId)).toBe(2);
  });

  it("NEW-D-7-CYC-5 · a STALE event describing an earlier period never resets (out-of-order delivery)", async () => {
    await reconcileTo(workspaceId, { currentPeriodStart: PERIOD_2, currentPeriodEnd: PERIOD_3 });
    await db.query("UPDATE credit_wallets SET auto_topup_count_cycle = 2 WHERE workspace_id = $1", [workspaceId]);
    await reconcileTo(workspaceId, { currentPeriodStart: PERIOD_1, currentPeriodEnd: PERIOD_2 });
    expect(await counter(workspaceId)).toBe(2);
  });

  it("NEW-D-7-CYC-6 · a renewal combined with a plan change still resets", async () => {
    await reconcileTo(workspaceId, { planKey: "business", currentPeriodStart: PERIOD_2, currentPeriodEnd: PERIOD_3 });
    expect(await counter(workspaceId)).toBe(0);
  });

  it("NEW-D-7-CYC-7 · another workspace's counter is not touched", async () => {
    const other = await workspaceOnGrowth();
    await reconcileTo(workspaceId, { currentPeriodStart: PERIOD_2, currentPeriodEnd: PERIOD_3 });
    expect(await counter(other)).toBe(3);
  });

  it("NEW-D-7-CYC-8 · a workspace with no wallet yet renews without error", async () => {
    await db.query("DELETE FROM credit_wallets WHERE workspace_id = $1", [workspaceId]);
    await expect(reconcileTo(workspaceId, { currentPeriodStart: PERIOD_2, currentPeriodEnd: PERIOD_3 })).resolves.toBeUndefined();
  });
});

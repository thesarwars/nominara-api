import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { applyPlanChange, planKeyOnly, type ProviderSubscriptionState } from "../../src/lib/billing/apply-plan.js";
import { provisionWalletWithGrant, recordPurchase } from "../../src/lib/credits/balance.js";
import { CycleRollBlockedError, rollIncludedCycle, type CycleRollOutcome } from "../../src/lib/credits/cycle-roll.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { commitCredits, reserveCredits } from "../../src/lib/credits/wallet.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-072 AC13 — "Grant refresh RESETS the included bucket rather than adding to it, and unused included credits
// EXPIRE with the expiry date visible" (plans-and-entitlements.md §5; owner decision 2026-10-14).
//
// Dangerous area: the credit ledger. Real Postgres, as nominara_app, so FORCE RLS is in play.
describe("STORY-072 AC13 · the billing-cycle roll", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let ws: string;

  const CYCLE_1 = { start: "2026-09-01", end: "2026-10-01" };
  const CYCLE_2 = { start: "2026-10-01", end: "2026-11-01" };
  const CYCLE_3 = { start: "2026-11-01", end: "2026-12-01" };

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
    pool = new Pool({ connectionString: appUri.toString(), max: 12 });
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await pool.end();
    await container.stop();
  });

  async function inCtx<T>(workspaceId: string, fn: (tx: Client) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => fn(tx as unknown as Client));
    } finally {
      client.release();
    }
  }

  async function newWorkspace(plan: string): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key)
       VALUES ($1,$2,$3,'in_house','us-east-1','UTC',$4)`,
      [id, `ws-${id}`, `ws-${id}`, plan],
    );
    await db.query(
      `INSERT INTO subscriptions
         (id, workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
          status, current_period_start, current_period_end, trial_ends_at)
       VALUES ($1,$2,$3,'monthly',$4,$5,'active', $6, $7, NULL)`,
      [uuidV7(), id, plan, `local_cus_${id}`, `local_sub_${id}`, CYCLE_1.start, CYCLE_1.end],
    );
    return id;
  }

  /** A provisioned wallet WITH its grant entry, so the ledger replay has something to agree with. */
  async function wallet(workspaceId: string, grant: number): Promise<void> {
    await inCtx(workspaceId, (tx) => provisionWalletWithGrant(tx, workspaceId, grant, CYCLE_1));
  }

  /** A spend exactly as the guard and interceptor leave it: reserve entry, then commit entry. */
  async function spend(workspaceId: string, credits: number, key: string): Promise<void> {
    await inCtx(workspaceId, async (tx) => {
      const reserved = await reserveCredits(tx, workspaceId, credits);
      await appendLedgerEntry(tx, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits, idempotencyKey: key, attempt: 1,
        after: reserved.wallet!, actorId: null, actorType: "system",
      });
      const committed = await commitCredits(tx, workspaceId, credits, credits);
      await appendLedgerEntry(tx, {
        workspaceId, entryType: "commit", actionCode: "manual_scan", credits, idempotencyKey: key, attempt: 1,
        after: committed!, actorId: null, actorType: "system",
      });
    });
  }

  async function roll(workspaceId: string, grant: number, cycle = CYCLE_2): Promise<CycleRollOutcome> {
    return inCtx(workspaceId, (tx) =>
      rollIncludedCycle(tx, { workspaceId, grant, cycleStart: cycle.start, cycleEnd: cycle.end }),
    );
  }

  async function balances(workspaceId: string) {
    const r = await db.query<{
      included_balance: number; purchased_balance: number; reserved: number;
      lifetime_granted: string; cycle_start: string; cycle_end: string; auto_topup_count_cycle: number;
    }>(
      `SELECT included_balance, purchased_balance, reserved, lifetime_granted::text,
              to_char(cycle_start,'YYYY-MM-DD') AS cycle_start, to_char(cycle_end,'YYYY-MM-DD') AS cycle_end,
              auto_topup_count_cycle
         FROM credit_wallets WHERE workspace_id = $1`,
      [workspaceId],
    );
    return r.rows[0]!;
  }

  async function entries(workspaceId: string, types: string[]) {
    const r = await db.query<{ entry_type: string; bucket: string; credits: number; idempotency_key: string }>(
      `SELECT entry_type, bucket, credits, idempotency_key FROM credit_ledger
        WHERE workspace_id = $1 AND entry_type = ANY($2::text[]) ORDER BY seq`,
      [workspaceId, types],
    );
    return r.rows;
  }

  beforeEach(async () => {
    ws = await newWorkspace("growth");
  });

  it("STORY-072 AC13 · unused included credits EXPIRE and the bucket is RESET to the grant, not added to", async () => {
    await wallet(ws, 1000);
    await spend(ws, 600, "job-1");

    const outcome = await roll(ws, 1200);

    expect(outcome).toMatchObject({ rolled: true, expired: 400, granted: 1200 });
    const b = await balances(ws);
    // 400 left + 1200 added would be 1600. Reset is exactly the grant.
    expect(b.included_balance).toBe(1200);
    expect(b).toMatchObject({ cycle_start: CYCLE_2.start, cycle_end: CYCLE_2.end });
    expect(await entries(ws, ["expire"])).toEqual([
      expect.objectContaining({ bucket: "included", credits: 400 }),
    ]);
    const grants = await entries(ws, ["grant"]);
    expect(grants.at(-1)).toMatchObject({ bucket: "included", credits: 1200 });
    expect(b.lifetime_granted).toBe("2200");
    expect(await inCtx(ws, (tx) => verifyWorkspaceWallet(tx, ws)), "the ledger must explain the new balance").toBeNull();
  });

  it("STORY-072 AC13 · a fully used bucket writes NO expire entry (a zero-magnitude entry is unrepresentable) and still resets", async () => {
    await wallet(ws, 1000);
    await spend(ws, 1000, "job-all");

    const outcome = await roll(ws, 1200);

    expect(outcome).toMatchObject({ rolled: true, expired: 0, granted: 1200 });
    expect(await entries(ws, ["expire"])).toEqual([]);
    expect((await balances(ws)).included_balance).toBe(1200);
    expect(await inCtx(ws, (tx) => verifyWorkspaceWallet(tx, ws))).toBeNull();
  });

  it("STORY-072 AC13 · a plan with no included grant expires the remainder and grants nothing", async () => {
    await wallet(ws, 300);
    const outcome = await roll(ws, 0);
    expect(outcome).toMatchObject({ rolled: true, expired: 300, granted: 0 });
    expect((await balances(ws)).included_balance).toBe(0);
    expect(await entries(ws, ["grant"])).toHaveLength(1); // the provisioning grant only
    expect(await inCtx(ws, (tx) => verifyWorkspaceWallet(tx, ws))).toBeNull();
  });

  it("STORY-072 AC13 · PURCHASED credits are untouched by the roll, and never expired by it", async () => {
    await wallet(ws, 1000);
    await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 500));

    await roll(ws, 1200);

    expect((await balances(ws)).purchased_balance).toBe(500);
    const expires = await entries(ws, ["expire"]);
    expect(expires.every((e) => e.bucket === "included")).toBe(true);
    expect(await inCtx(ws, (tx) => verifyWorkspaceWallet(tx, ws))).toBeNull();
  });

  it("STORY-072 AC13 · the per-cycle auto-top-up counter restarts with the cycle", async () => {
    await wallet(ws, 1000);
    await db.query("UPDATE credit_wallets SET auto_topup_count_cycle = 3 WHERE workspace_id = $1", [ws]);
    await roll(ws, 1000);
    expect((await balances(ws)).auto_topup_count_cycle).toBe(0);
  });

  it("STORY-072 AC13 · a replay of the same cycle does nothing the second time", async () => {
    await wallet(ws, 1000);
    await spend(ws, 100, "job-1");
    const first = await roll(ws, 1200);
    const second = await roll(ws, 1200);

    expect(first.rolled).toBe(true);
    expect(second).toEqual({ rolled: false, reason: "not_newer" });
    expect((await balances(ws)).included_balance).toBe(1200);
    expect(await entries(ws, ["expire"])).toHaveLength(1);
    expect(await entries(ws, ["grant"])).toHaveLength(2);
  });

  it("STORY-072 AC13 · a STALE cycle (earlier than the one on file) is not a roll", async () => {
    await wallet(ws, 1000);
    await roll(ws, 1200, CYCLE_3);
    const stale = await roll(ws, 1200, CYCLE_2);
    expect(stale).toEqual({ rolled: false, reason: "not_newer" });
    expect(await balances(ws)).toMatchObject({ cycle_start: CYCLE_3.start });
  });

  it("STORY-072 AC13 · a workspace with no wallet yet is skipped, not minted one (the first provisioning grants in full)", async () => {
    expect(await roll(ws, 1200)).toEqual({ rolled: false, reason: "no_wallet" });
    const r = await db.query("SELECT 1 FROM credit_wallets WHERE workspace_id = $1", [ws]);
    expect(r.rowCount).toBe(0);
  });

  it("STORY-072 AC13 · CONCURRENT rolls of one cycle produce exactly one reset, one expire, one grant", async () => {
    await wallet(ws, 1000);
    await spend(ws, 250, "job-1");

    const results = await Promise.all(Array.from({ length: 8 }, () => roll(ws, 1200)));

    expect(results.filter((r) => r.rolled)).toHaveLength(1);
    expect((await balances(ws)).included_balance).toBe(1200);
    expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: 750 })]);
    expect((await entries(ws, ["grant"])).filter((g) => g.idempotency_key.includes(CYCLE_2.start))).toHaveLength(1);
    expect(await inCtx(ws, (tx) => verifyWorkspaceWallet(tx, ws))).toBeNull();
  });

  it("STORY-072 AC13 · the roll is ATOMIC: a refused expire entry takes the reset and the grant down with it", async () => {
    await wallet(ws, 1000);
    // The ledger already holds an expire entry under the roll's key while the wallet has not rolled: the two
    // disagree about whether this cycle was processed, which must refuse rather than half-apply.
    const key = `cycle_roll:${CYCLE_2.start}`;
    await db.query(
      `INSERT INTO credit_ledger (workspace_id, actor_type, entry_type, credits, bucket, included_after,
                                  purchased_after, reserved_after, idempotency_key, attempt)
       VALUES ($1,'system','expire',1,'included',0,0,0,$2,1)`,
      [ws, key],
    );
    await expect(roll(ws, 1200)).rejects.toThrow();
    const b = await balances(ws);
    expect(b.included_balance).toBe(1000);
    expect(b.cycle_start).toBe(CYCLE_1.start);
    expect((await entries(ws, ["grant"])).filter((g) => g.idempotency_key.includes(CYCLE_2.start))).toEqual([]);
  });

  // The spec does not say what a reservation straddling the roll does. These pin only what the schema and §6
  // already force; the policy question is recorded in docs-pending/STORY-072.
  it("STORY-072 AC13 · an in-flight reservation survives the roll untouched and can still commit", async () => {
    await wallet(ws, 1000);
    await spend(ws, 300, "job-1");
    const held = await inCtx(ws, (tx) => reserveCredits(tx, ws, 200));
    expect(held.ok).toBe(true);

    await roll(ws, 1200);

    expect((await balances(ws)).reserved, "the roll must never release a live hold").toBe(200);
    const committed = await inCtx(ws, (tx) => commitCredits(tx, ws, 200, 200));
    expect(committed).not.toBeNull();
    const b = await balances(ws);
    expect(b.reserved).toBe(0);
    expect(b.included_balance).toBe(1000);
  });

  it("STORY-072 AC13 · a roll that would leave a live hold larger than the wallet is REFUSED, whole, rather than violating ck_wallet_reserved", async () => {
    await wallet(ws, 100);
    await inCtx(ws, (tx) => reserveCredits(tx, ws, 80));

    await expect(roll(ws, 10)).rejects.toThrow(CycleRollBlockedError);

    const b = await balances(ws);
    expect(b).toMatchObject({ included_balance: 100, reserved: 80, cycle_start: CYCLE_1.start });
    expect(await entries(ws, ["expire"])).toEqual([]);
  });

  // ---- the subscription renewal is what rolls it ------------------------------------------------------------

  describe("the renewal webhook path (applyPlanChange)", () => {
    const provenance = { requestId: "evt_renew", operator: "stripe-webhook", reason: "test" };

    function advance(period: { start: string; end: string }, planKey?: string) {
      return (current: ProviderSubscriptionState): ProviderSubscriptionState => ({
        ...current,
        ...(planKey === undefined ? {} : { planKey }),
        currentPeriodStart: new Date(`${period.start}T00:00:00.000Z`),
        currentPeriodEnd: new Date(`${period.end}T00:00:00.000Z`),
      });
    }

    async function apply(workspaceId: string, reconcile: (c: ProviderSubscriptionState) => ProviderSubscriptionState) {
      return inCtx(workspaceId, (tx) => applyPlanChange(tx, workspaceId, reconcile, provenance, { allowDowngrade: true }));
    }

    async function planGrant(key: string): Promise<number> {
      const r = await db.query<{ credits_per_cycle: number }>("SELECT credits_per_cycle FROM plans WHERE key = $1", [key]);
      return r.rows[0]!.credits_per_cycle;
    }

    it("STORY-072 AC13 · a renewal (same plan, later period) resets the bucket to the plan grant and expires the rest", async () => {
      const grant = await planGrant("growth");
      await wallet(ws, grant);
      await spend(ws, 100, "job-1");

      await apply(ws, advance(CYCLE_2));

      const b = await balances(ws);
      expect(b.included_balance).toBe(grant);
      expect(b).toMatchObject({ cycle_start: CYCLE_2.start, cycle_end: CYCLE_2.end });
      expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: grant - 100 })]);
      expect(await inCtx(ws, (tx) => verifyWorkspaceWallet(tx, ws))).toBeNull();
    });

    it("STORY-072 AC13 · a redelivered renewal does nothing the second time", async () => {
      const grant = await planGrant("growth");
      await wallet(ws, grant);
      await apply(ws, advance(CYCLE_2));
      await apply(ws, advance(CYCLE_2));
      expect(await entries(ws, ["expire"])).toHaveLength(1);
      expect((await balances(ws)).included_balance).toBe(grant);
    });

    it("STORY-072 AC13 · an event for the SAME period (a seat change, a cancel flag) is not a roll", async () => {
      const grant = await planGrant("growth");
      await wallet(ws, grant);
      await spend(ws, 100, "job-1");
      await apply(ws, (c) => ({ ...c, seatsPurchased: c.seatsPurchased + 1 }));
      expect((await balances(ws)).included_balance).toBe(grant - 100);
      expect(await entries(ws, ["expire"])).toEqual([]);
    });

    it("STORY-072 AC13 · a downgrade landing at the period end resets to the NEW plan's grant", async () => {
      const grantGrowth = await planGrant("growth");
      const grantStarter = await planGrant("starter");
      await wallet(ws, grantGrowth);

      await apply(ws, advance(CYCLE_2, "starter"));

      expect((await balances(ws)).included_balance).toBe(grantStarter);
      expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: grantGrowth })]);
    });

    it("STORY-072 AC13 / AC14 · an UPGRADE keeps its pro-rata top-up: a period change alongside it is not a reset", async () => {
      const grantStarter = await planGrant("starter");
      await db.query("UPDATE workspaces SET plan_key = 'starter' WHERE id = $1", [ws]);
      await db.query("UPDATE subscriptions SET plan_key = 'starter' WHERE workspace_id = $1", [ws]);
      await wallet(ws, grantStarter);
      await spend(ws, 10, "job-1");

      await apply(ws, advance(CYCLE_2, "growth"));

      expect(await entries(ws, ["expire"]), "an upgrade expires nothing").toEqual([]);
      expect((await balances(ws)).included_balance).toBeGreaterThanOrEqual(grantStarter - 10);
    });
  });
});

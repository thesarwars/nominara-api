import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { Logger } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { StripeSubscriptionHandler } from "../../src/modules/billing/stripe-subscription.handler.js";
import type { BillingAddonsService } from "../../src/modules/billing/billing-addons.service.js";
import { applyPlanChange, type ProviderSubscriptionState } from "../../src/lib/billing/apply-plan.js";
import { provisionWalletWithGrant, recordPurchase } from "../../src/lib/credits/balance.js";
import { debitInTransaction } from "../../src/lib/credits/debit.js";
import { rollIncludedCycle, type CycleRollOutcome } from "../../src/lib/credits/cycle-roll.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { writeCarries } from "../../src/lib/credits/hold-carry.js";
import { reconcileOrphanedReservations } from "../../src/lib/credits/reconcile.js";
import { settleFinishedRunCredits } from "../../src/lib/credits/run-settlement.js";
import { commitReservation, releaseReservation, type SettleableReservation } from "../../src/lib/credits/settle.js";
import { reserveCredits } from "../../src/lib/credits/wallet.js";
import { resolveBillingPeriod } from "../../src/lib/usage/billing-period.js";
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

  function holdOf(key: string, credits: number): SettleableReservation {
    return { workspaceId: ws, idempotencyKey: key, attempt: 1, credits, actionCode: "manual_scan" };
  }

  /** A hold exactly as the guard leaves it: the reserve statement, then the reserve entry. It stays OPEN. */
  async function openHold(workspaceId: string, credits: number, key: string): Promise<void> {
    await inCtx(workspaceId, async (tx) => {
      const reserved = await reserveCredits(tx, workspaceId, credits);
      expect(reserved.ok, `reserving ${String(credits)} for ${key}`).toBe(true);
      await appendLedgerEntry(tx, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits, idempotencyKey: key, attempt: 1,
        after: reserved.wallet!, actorId: null, actorType: "system",
      });
    });
  }

  /** The settle path the interceptor takes for a successful request. */
  async function commitHold(workspaceId: string, key: string, credits: number, consumed = credits, entry = {}): Promise<void> {
    const outcome = await inCtx(workspaceId, (tx) =>
      commitReservation(tx, { ...holdOf(key, credits), workspaceId }, consumed, entry),
    );
    expect(outcome, `committing ${key}`).not.toBeNull();
  }

  /** The settle path the interceptor (failed request) and the reconciler take. */
  async function releaseHold(workspaceId: string, key: string, credits: number): Promise<string> {
    return inCtx(workspaceId, (tx) => releaseReservation(tx, { ...holdOf(key, credits), workspaceId }));
  }

  /** A spend exactly as the guard and interceptor leave it: reserve entry, then commit entry. */
  async function spend(workspaceId: string, credits: number, key: string): Promise<void> {
    await openHold(workspaceId, credits, key);
    await commitHold(workspaceId, key, credits);
  }

  async function replayClean(workspaceId: string): Promise<void> {
    expect(await inCtx(workspaceId, (tx) => verifyWorkspaceWallet(tx, workspaceId))).toBeNull();
  }

  async function roll(workspaceId: string, grant: number, cycle = CYCLE_2, carryUnused = false): Promise<CycleRollOutcome> {
    return inCtx(workspaceId, (tx) =>
      rollIncludedCycle(tx, { workspaceId, grant, cycleStart: cycle.start, cycleEnd: cycle.end, carryUnused }),
    );
  }

  async function carryRows(workspaceId: string) {
    const r = await db.query<{ idempotency_key: string; credits: number; settled: boolean; rolled: string }>(
      `SELECT idempotency_key, credits, settled_at IS NOT NULL AS settled, to_char(rolled_cycle_start,'YYYY-MM-DD') AS rolled
         FROM credit_hold_carries WHERE workspace_id = $1 ORDER BY idempotency_key`,
      [workspaceId],
    );
    return r.rows;
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

    // The roll must have HAPPENED, or "purchased untouched" is vacuously true.
    expect((await roll(ws, 1200)).rolled).toBe(true);

    expect((await balances(ws)).purchased_balance).toBe(500);
    const expires = await entries(ws, ["expire"]);
    expect(expires, "the unused included credits did expire").toHaveLength(1);
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

  // ---- a reservation in flight at the roll: OPTION B, "keep the hold" (owner decision 2026-10-15) --------------
  //
  // The held part of the included bucket is NOT expired at the roll. It stays with its hold; a commit pays from it,
  // and whatever part of it a release leaves unspent expires at that moment. The customer pays ONCE, from the cycle
  // the action started in. Each case runs in BOTH orderings, because "the same final balance whichever came first" is
  // the whole point, and each one ends in the ledger replay.
  describe("a hold in flight at the roll (option B: keep the hold)", () => {
    /** grant 1000, spend 300 (700 left), a 200 hold open: the owner's own example. */
    async function exampleWallet(): Promise<void> {
      await wallet(ws, 1000);
      await spend(ws, 300, "job-0");
      await openHold(ws, 200, "job-1");
    }

    it("STORY-072 AC13 · a hold that COMMITS in full after the roll is paid from the old cycle: 1200, not 1000 (roll then commit)", async () => {
      await exampleWallet();

      await roll(ws, 1200);
      const mid = await balances(ws);
      // 500 unheld credits expired; the 200 held ones stay with their hold on top of the new grant.
      expect(mid).toMatchObject({ included_balance: 1400, reserved: 200 });
      expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: 500 })]);

      await commitHold(ws, "job-1", 200);

      expect(await balances(ws)).toMatchObject({ included_balance: 1200, purchased_balance: 0, reserved: 0 });
      expect(await entries(ws, ["expire"]), "a fully spent carry expires nothing more").toHaveLength(1);
      await replayClean(ws);
    });

    it("STORY-072 AC13 · the same wallet, commit THEN roll, ends on the same 1200 (the two orderings agree)", async () => {
      await exampleWallet();

      await commitHold(ws, "job-1", 200);
      await roll(ws, 1200);

      expect(await balances(ws)).toMatchObject({ included_balance: 1200, purchased_balance: 0, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a PARTIAL commit after the roll spends from the carry and expires the carry's unused remainder (roll then commit)", async () => {
      await exampleWallet();
      await roll(ws, 1200);

      await commitHold(ws, "job-1", 200, 150);

      expect(await balances(ws)).toMatchObject({ included_balance: 1200, reserved: 0 });
      // 500 at the roll, 50 when the hold settled for less than it held.
      expect((await entries(ws, ["expire"])).map((e) => e.credits)).toEqual([500, 50]);
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a PARTIAL commit BEFORE the roll ends on the same 1200 (commit then roll)", async () => {
      await exampleWallet();

      await commitHold(ws, "job-1", 200, 150);
      await roll(ws, 1200);

      expect(await balances(ws)).toMatchObject({ included_balance: 1200, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a hold RELEASED after the roll expires its carry at that moment (roll then release)", async () => {
      await exampleWallet();
      await roll(ws, 1200);
      expect((await balances(ws)).included_balance).toBe(1400);

      expect(await releaseHold(ws, "job-1", 200)).toBe("released");

      expect(await balances(ws)).toMatchObject({ included_balance: 1200, reserved: 0 });
      expect((await entries(ws, ["expire"])).map((e) => e.credits)).toEqual([500, 200]);
      await replayClean(ws);
    });

    it("STORY-072 AC13 · the same wallet, release THEN roll, ends on the same 1200", async () => {
      await exampleWallet();

      await releaseHold(ws, "job-1", 200);
      await roll(ws, 1200);

      expect(await balances(ws)).toMatchObject({ included_balance: 1200, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · the carry's expiry is keyed deterministically: settling twice expires once", async () => {
      await exampleWallet();
      await roll(ws, 1200);

      await releaseHold(ws, "job-1", 200);
      expect(await releaseHold(ws, "job-1", 200)).toBe("already_settled");

      const expired = await entries(ws, ["expire"]);
      expect(expired).toHaveLength(2);
      expect(expired[1]!.idempotency_key).toBe("hold_carry:1:job-1");
      expect((await balances(ws)).included_balance).toBe(1200);
    });

    it("STORY-072 AC13 · the RECONCILER's orphan release honours the carry, too", async () => {
      await exampleWallet();
      await roll(ws, 1200);

      const outcome = await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });

      expect(outcome.failures).toEqual([]);
      expect(outcome.released).toBeGreaterThanOrEqual(1);
      expect(await balances(ws)).toMatchObject({ included_balance: 1200, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a run refund of a debit paid from a carry goes back to the included bucket it came from", async () => {
      await exampleWallet();
      await roll(ws, 1200);
      const runId = uuidV7();

      await commitHold(ws, "job-1", 200, 200, { referenceType: "run", referenceId: runId });
      expect((await balances(ws)).included_balance).toBe(1200);
      const refund = await inCtx(ws, (tx) => settleFinishedRunCredits(tx, { workspaceId: ws, runId, deliveredCells: 0 }));

      expect(refund.refunded).toBe(200);
      expect(await balances(ws)).toMatchObject({ included_balance: 1400, purchased_balance: 0, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a hold taken AFTER the roll never consumes or expires an old hold's carry", async () => {
      // 100 left in included, all of it held by job-1; purchased credits behind the new hold.
      await wallet(ws, 1000);
      await spend(ws, 900, "job-0");
      await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 500));
      await openHold(ws, 100, "old");
      await roll(ws, 50);
      expect(await balances(ws)).toMatchObject({ included_balance: 150, purchased_balance: 500, reserved: 100 });

      await openHold(ws, 200, "new");
      await commitHold(ws, "new", 200);
      // 50 from the new grant, 150 from purchased. The old hold's 100 are untouched.
      expect(await balances(ws)).toMatchObject({ included_balance: 100, purchased_balance: 350, reserved: 100 });

      await releaseHold(ws, "old", 100);
      expect(await balances(ws)).toMatchObject({ included_balance: 0, purchased_balance: 350, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · releasing the old hold while a NEW hold is still open expires only the old carry", async () => {
      await wallet(ws, 1000);
      await spend(ws, 900, "job-0");
      await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 500));
      await openHold(ws, 100, "old");
      await roll(ws, 50);
      await openHold(ws, 200, "new");

      await releaseHold(ws, "old", 100);
      expect(await balances(ws)).toMatchObject({ included_balance: 50, purchased_balance: 500, reserved: 200 });

      await commitHold(ws, "new", 200);
      expect(await balances(ws)).toMatchObject({ included_balance: 0, purchased_balance: 350, reserved: 0 });
      await replayClean(ws);
    });

    for (const order of [["a", "b"], ["b", "a"]] as const) {
      it(`STORY-072 AC13 · two carried holds settle independently, ${order.join(" then ")}`, async () => {
        await wallet(ws, 1000);
        await spend(ws, 700, "job-0"); // 300 left
        await openHold(ws, 120, "a");
        await openHold(ws, 80, "b");
        await roll(ws, 1000);
        // 100 unheld expired; 200 held stay on top of the grant.
        expect(await balances(ws)).toMatchObject({ included_balance: 1200, reserved: 200 });

        for (const which of order) {
          if (which === "a") await commitHold(ws, "a", 120, 100); // 20 of a's carry expire
          else await releaseHold(ws, "b", 80); // all 80 of b's carry expire
        }

        expect(await balances(ws), "the new grant is untouched: the carries were spent or expired").toMatchObject({ included_balance: 1000, purchased_balance: 0, reserved: 0 });
        await replayClean(ws);
      });
    }

    it("STORY-072 AC13 · a hold backed by PURCHASED credits larger than the grant rolls instead of being refused", async () => {
      await wallet(ws, 100);
      await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 500));
      await openHold(ws, 505, "big");

      // The grant (10) is far smaller than the hold (505); 10 + 500 purchased would still cover 505.
      await roll(ws, 10);

      expect(await balances(ws)).toMatchObject({ included_balance: 110, purchased_balance: 500, reserved: 505 });
      await commitHold(ws, "big", 505);
      // 100 from the carry; the other 405 were backed by PURCHASED credits before the roll, so they come from purchased and
      // the new grant (10) is untouched: the same split as committing before the roll (below).
      expect(await balances(ws)).toMatchObject({ included_balance: 10, purchased_balance: 95, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · the same wallet, commit THEN roll, ends on the same buckets: included 10, purchased 95 (the two orderings agree)", async () => {
      await wallet(ws, 100);
      await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 500));
      await openHold(ws, 505, "big");

      await commitHold(ws, "big", 505);
      expect(await balances(ws)).toMatchObject({ included_balance: 0, purchased_balance: 95, reserved: 0 });
      await roll(ws, 10);

      expect(await balances(ws)).toMatchObject({ included_balance: 10, purchased_balance: 95, reserved: 0 });
      await replayClean(ws);
    });

    for (const [consumed, included, purchased] of [[300, 10, 300], [100, 10, 500], [60, 10, 500]] as const) {
      it(`STORY-072 AC13 · a partly carried hold committed for ${String(consumed)} of 505 splits the buckets the same in both orderings (${String(included)} / ${String(purchased)})`, async () => {
        const arrange = async (): Promise<void> => {
          await wallet(ws, 100);
          await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 500));
          await openHold(ws, 505, "big");
        };

        await arrange();
        await roll(ws, 10);
        await commitHold(ws, "big", 505, consumed);
        const rollThenCommit = await balances(ws);
        await replayClean(ws);

        ws = await newWorkspace("growth");
        await arrange();
        await commitHold(ws, "big", 505, consumed);
        await roll(ws, 10);
        const commitThenRoll = await balances(ws);
        await replayClean(ws);

        expect(rollThenCommit).toMatchObject({ included_balance: commitThenRoll.included_balance, purchased_balance: commitThenRoll.purchased_balance, reserved: 0 });
        expect(commitThenRoll).toMatchObject({ included_balance: included, purchased_balance: purchased });
      });
    }

    // ---- STORY-046's inline activation debit (reserve + commit in ONE request transaction) -----------------------

    /** An activation debit exactly as `PromptsService` makes one: `prompt_activate:` key, reserve + commit, one tx. */
    async function activate(workspaceId: string, credits: number, key: string): Promise<void> {
      await inCtx(workspaceId, (tx) =>
        debitInTransaction(tx, {
          workspaceId, actorId: null, actorType: "system", actionCode: "prompt_activate", credits,
          idempotencyKey: `prompt_activate:${key}`, includedGrant: 0,
        }),
      );
    }

    it("STORY-072 AC13 / STORY-046 · an activation debit AFTER a roll draws the pool, then purchased, and never another hold's carry", async () => {
      await wallet(ws, 1000);
      await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 500));
      await spend(ws, 300, "job-0");
      await openHold(ws, 200, "job-1");
      await roll(ws, 100);
      // 700 included: 200 carried with job-1, 500 expired; the new grant is 100. included 300 = 200 carry + 100 pool.
      expect(await balances(ws)).toMatchObject({ included_balance: 300, purchased_balance: 500, reserved: 200 });

      await activate(ws, 150, "p1");

      // 100 from the pool, 50 from purchased. The carry (200) is still whole.
      expect(await balances(ws)).toMatchObject({ included_balance: 200, purchased_balance: 450, reserved: 200 });
      await replayClean(ws);

      await commitHold(ws, "job-1", 200);
      expect(await balances(ws)).toMatchObject({ included_balance: 0, purchased_balance: 450, reserved: 0 });
      expect((await carryRows(ws)).filter((r) => r.idempotency_key.startsWith("prompt_activate:")), "an activation never carries").toEqual([]);
      await replayClean(ws);
    });

    it("STORY-072 AC13 / STORY-046 · an activation debit BEFORE a roll replays cleanly and the roll carries only the real hold", async () => {
      await wallet(ws, 1000);
      await openHold(ws, 200, "job-1");
      await activate(ws, 150, "p1");
      await replayClean(ws);

      const outcome = await roll(ws, 100);

      expect(outcome).toMatchObject({ rolled: true, carried: 200 });
      expect(await balances(ws)).toMatchObject({ included_balance: 300, reserved: 200 });
      expect((await carryRows(ws)).map((r) => r.idempotency_key)).toEqual(["job-1"]);
      await commitHold(ws, "job-1", 200);
      await replayClean(ws);
    });

    it("STORY-072 AC13 / STORY-046 · a roll can never see an activation hold open: it waits for the request's transaction", async () => {
      await wallet(ws, 1000);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let inside!: () => void;
      const entered = new Promise<void>((resolve) => { inside = resolve; });

      const request = inCtx(ws, async (tx) => {
        await debitInTransaction(tx, {
          workspaceId: ws, actorId: null, actorType: "system", actionCode: "prompt_activate", credits: 250,
          idempotencyKey: "prompt_activate:gate", includedGrant: 0,
        });
        inside();
        await gate; // the request is still open: its reserve and commit are written, uncommitted
      });
      await entered;

      let rolledAt: CycleRollOutcome | null = null;
      const rolling = roll(ws, 1000).then((o) => { rolledAt = o; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(rolledAt, "the roll is queued behind the request's wallet row lock").toBeNull();

      release();
      await request;
      await rolling;

      expect(rolledAt).toMatchObject({ rolled: true, carried: 0, expired: 750, granted: 1000 });
      expect(await carryRows(ws)).toEqual([]);
      expect(await balances(ws)).toMatchObject({ included_balance: 1000, reserved: 0 });
      const order = await db.query<{ entry_type: string; idempotency_key: string }>(
        "SELECT entry_type, idempotency_key FROM credit_ledger WHERE workspace_id = $1 AND entry_type IN ('reserve','commit','grant','expire') ORDER BY seq", [ws]);
      const gateEntries = order.rows.filter((r) => r.idempotency_key === "prompt_activate:gate").map((r) => r.entry_type);
      expect(gateEntries).toEqual(["reserve", "commit"]);
      const firstRoll = order.rows.findIndex((r) => r.idempotency_key.startsWith("cycle_roll:"));
      const lastGate = order.rows.map((r) => r.idempotency_key).lastIndexOf("prompt_activate:gate");
      expect(lastGate, "both halves of the activation precede the roll's entries").toBeLessThan(firstRoll);
      await replayClean(ws);
    });

    it("STORY-072 AC13 / STORY-046 · activations racing the roll all replay cleanly, in whatever order they land", async () => {
      await wallet(ws, 2000);
      await openHold(ws, 300, "job-1");
      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 8; i++) ops.push(activate(ws, 25, `race-${String(i)}`));
      ops.push(roll(ws, 500));
      for (let i = 8; i < 12; i++) ops.push(activate(ws, 25, `race-${String(i)}`));
      await Promise.all(ops);
      await commitHold(ws, "job-1", 300);

      const b = await balances(ws);
      expect(b.reserved).toBe(0);
      const rollSeq = await db.query<{ last: string }>("SELECT max(seq)::text AS last FROM credit_ledger WHERE workspace_id = $1 AND idempotency_key LIKE 'cycle_roll:%'", [ws]);
      const after = await db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'reserve' AND idempotency_key LIKE 'prompt_activate:%' AND seq > $2::bigint", [ws, rollSeq.rows[0]!.last]);
      expect(b.included_balance, "only the activations after the roll draw the new grant").toBe(500 - 25 * Number(after.rows[0]!.n));
      expect(await carryRows(ws)).toEqual([expect.objectContaining({ idempotency_key: "job-1", settled: true })]);
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a hold equal to the whole bucket carries all of it and expires nothing (the min boundary)", async () => {
      await wallet(ws, 100);
      await openHold(ws, 100, "all");

      await roll(ws, 50);

      expect(await entries(ws, ["expire"]), "nothing is unheld, so nothing expires").toEqual([]);
      expect(await balances(ws)).toMatchObject({ included_balance: 150, reserved: 100 });
      await commitHold(ws, "all", 100);
      expect(await balances(ws)).toMatchObject({ included_balance: 50, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a hold one credit under the bucket expires exactly the one unheld credit", async () => {
      await wallet(ws, 100);
      await openHold(ws, 99, "almost");

      await roll(ws, 50);

      expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: 1 })]);
      expect(await balances(ws)).toMatchObject({ included_balance: 149, reserved: 99 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a live hold larger than the grant used to REFUSE the roll; under option B it cannot (CycleRollBlockedError is gone)", async () => {
      await wallet(ws, 100);
      await openHold(ws, 80, "held");

      const outcome = await roll(ws, 10);

      expect(outcome).toMatchObject({ rolled: true, expired: 20, granted: 10 });
      expect(await balances(ws)).toMatchObject({ included_balance: 90, reserved: 80, cycle_start: CYCLE_2.start });
      await commitHold(ws, "held", 80);
      expect(await balances(ws)).toMatchObject({ included_balance: 10, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a hold that outlives TWO rolls is still paid once, from the cycle it started in", async () => {
      await exampleWallet();
      await roll(ws, 1200, CYCLE_2);
      await roll(ws, 1200, CYCLE_3);
      expect(await balances(ws)).toMatchObject({ included_balance: 1400, reserved: 200 });

      await commitHold(ws, "job-1", 200);

      expect(await balances(ws)).toMatchObject({ included_balance: 1200, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · the verifier reports a carry row that disagrees with what the ledger implies (too small, and missing)", async () => {
      await exampleWallet();
      await roll(ws, 1200);
      await replayClean(ws);

      await db.query("UPDATE credit_hold_carries SET credits = credits - 1 WHERE workspace_id = $1", [ws]);
      const small = await inCtx(ws, (tx) => verifyWorkspaceWallet(tx, ws));
      expect(small?.reason).toMatch(/carr/);

      await db.query("DELETE FROM credit_hold_carries WHERE workspace_id = $1", [ws]);
      const missing = await inCtx(ws, (tx) => verifyWorkspaceWallet(tx, ws));
      expect(missing?.reason).toMatch(/carr/);
    });

    it("STORY-072 AC13 · settling a carried hold logs a metric and a redacted line (workspace ID, credit counts, no names)", async () => {
      const lines: unknown[] = [];
      const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
        lines.push(message);
      });
      try {
        await exampleWallet();
        await roll(ws, 1200);
        await commitHold(ws, "job-1", 200, 150);
      } finally {
        spy.mockRestore();
      }

      expect(lines).toContainEqual(expect.objectContaining({ metric: "nominara_credits_hold_carry_settled_total", outcome: "committed" }));
      const line = lines.find((l) => typeof l === "object" && l !== null && (l as { message?: string }).message === "carried hold settled") as
        | Record<string, unknown>
        | undefined;
      expect(line).toMatchObject({ workspace_id: ws, spent_credits: 150, expired_credits: 50 });
      expect(JSON.stringify(line)).not.toContain("ws-");
    });

    it("STORY-072 AC13 · the carry-into-the-grant of an upgrade is CAPPED at the grant: more unused than the grant still expires the rest", async () => {
      await wallet(ws, 1000);
      await spend(ws, 100, "job-0"); // 900 unused

      const outcome = await roll(ws, 450, CYCLE_2, true);

      expect(outcome).toMatchObject({ rolled: true, expired: 450, granted: 0, carried: 0 });
      expect((await balances(ws)).included_balance).toBe(450);
      expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: 450 })]);
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a plan with NO grant but unused credits still carries a hold across the roll (the expiry alone anchors it)", async () => {
      await wallet(ws, 100);
      await openHold(ws, 40, "held");

      await roll(ws, 0);

      expect((await entries(ws, ["expire"])).map((e) => e.credits)).toEqual([60]);
      expect(await carryRows(ws)).toEqual([expect.objectContaining({ idempotency_key: "held", credits: 40, settled: false })]);
      await commitHold(ws, "held", 40, 25);
      expect(await balances(ws)).toMatchObject({ included_balance: 0, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · the carry goes to the OLDEST hold first when the bucket cannot cover every hold", async () => {
      await wallet(ws, 150);
      await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 100));
      await openHold(ws, 120, "a");
      await openHold(ws, 80, "b");

      await roll(ws, 20);

      expect(await carryRows(ws)).toEqual([
        expect.objectContaining({ idempotency_key: "a", credits: 120 }),
        expect.objectContaining({ idempotency_key: "b", credits: 30 }),
      ]);
      await commitHold(ws, "a", 120);
      await commitHold(ws, "b", 80);
      // b: 30 from its carry, the other 50 from purchased (its pre-roll backing); the new grant (20) is untouched. Committing
      // both before the roll and then rolling ends on the same 20 / 50.
      expect(await balances(ws)).toMatchObject({ included_balance: 20, purchased_balance: 50, reserved: 0 });
      await replayClean(ws);
    });

    it("STORY-072 AC13 · a hold that carries nothing cannot draw the bucket BELOW the others' carries (the pool is floored at zero)", async () => {
      await wallet(ws, 100);
      await inCtx(ws, (tx) => recordPurchase(tx, { workspaceId: ws, idempotencyKey: "pack-1", actorId: null, actorType: "system" }, 500));
      await openHold(ws, 100, "old");
      await roll(ws, 10);
      // An out-of-band correction leaves the bucket (40) below the carry (100).
      await db.query("UPDATE credit_wallets SET included_balance = 40 WHERE workspace_id = $1", [ws]);
      await openHold(ws, 30, "new");

      await commitHold(ws, "new", 30);

      expect(await balances(ws)).toMatchObject({ included_balance: 40, purchased_balance: 470, reserved: 100 });
    });

    it("STORY-072 AC13 · a settled carry is never reopened by a later write", async () => {
      await exampleWallet();
      await roll(ws, 1200);
      await releaseHold(ws, "job-1", 200);

      await inCtx(ws, (tx) =>
        writeCarries(tx, ws, CYCLE_3.start,
          [{ idempotencyKey: "job-1", attempt: 1, credits: 200, carry: 0 }],
          [{ idempotencyKey: "job-1", attempt: 1, carry: 150 }]),
      );

      expect(await carryRows(ws)).toEqual([expect.objectContaining({ credits: 200, settled: true, rolled: CYCLE_2.start })]);
    });

    it("STORY-072 AC13 · a plan with NO grant and a fully held bucket behaves as before: the hold simply settles (documented corner)", async () => {
      await wallet(ws, 100);
      await openHold(ws, 100, "all");

      await roll(ws, 0);

      expect(await entries(ws, ["expire", "grant"]).then((e) => e.filter((x) => x.idempotency_key.startsWith("cycle_roll")))).toEqual([]);
      await commitHold(ws, "all", 100);
      expect(await balances(ws)).toMatchObject({ included_balance: 0, reserved: 0 });
      await replayClean(ws);
    });
  });

  it("STORY-072 AC13 · the roll is refused whole when the ledger already holds its GRANT entry for a wallet that has not rolled", async () => {
    await wallet(ws, 1000);
    const key = `cycle_roll:${CYCLE_2.start}`;
    await db.query(
      `INSERT INTO credit_ledger (workspace_id, actor_type, entry_type, credits, bucket, included_after,
                                  purchased_after, reserved_after, idempotency_key, attempt)
       VALUES ($1,'system','grant',1,'included',0,0,0,$2,1)`,
      [ws, key],
    );
    await expect(roll(ws, 1200)).rejects.toThrow(/disagree/);
    const b = await balances(ws);
    expect(b.included_balance).toBe(1000);
    expect(b.cycle_start).toBe(CYCLE_1.start);
    expect(await entries(ws, ["expire"])).toEqual([]);
  });

  it("STORY-072 AC13 · 20 operations racing the roll (reserves, commits, releases) leave a wallet the ledger replays and every hold settled once", async () => {
    await wallet(ws, 5000);
    // 10 holds open before the race; 10 more flows begin inside it; the roll is among them.
    for (let i = 0; i < 10; i++) await openHold(ws, 20 + i, `pre-${String(i)}`);
    const pre = Array.from({ length: 10 }, (_, i) => 20 + i);

    // The roll is started among the FIRST operations, so most pre-roll holds settle after it (the carried-commit path is
    // the one this exactness is for); the final balance is derived from the ledger either way.
    const thunks: (() => Promise<unknown>)[] = [];
    pre.forEach((credits, i) => {
      const key = `pre-${String(i)}`;
      thunks.push(() => (i % 2 === 0 ? commitHold(ws, key, credits, credits - 5) : releaseHold(ws, key, credits)));
    });
    for (let i = 0; i < 9; i++) thunks.push(() => spend(ws, 15, `new-${String(i)}`));
    thunks.splice(3, 0, () => roll(ws, 4000));
    expect(thunks).toHaveLength(20);
    const ops = thunks.map((start) => start());
    await Promise.all(ops);

    const b = await balances(ws);
    expect(b.reserved, "every hold settled").toBe(0);
    expect(b.cycle_start).toBe(CYCLE_2.start);
    const open = await db.query("SELECT 1 FROM credit_hold_carries WHERE workspace_id = $1 AND settled_at IS NULL", [ws]);
    expect(open.rowCount, "no carry outlives its hold").toBe(0);
    // EXACT, whatever the interleaving. Every pre-roll hold (committed or released, before or after the roll) is paid from
    // the cycle it started in, so only a spend that RESERVED AFTER the roll draws on the new grant. k of them did: read it
    // off the ledger's seq order, where the roll's entries are contiguous (it holds the wallet row lock throughout).
    const rollSeq = await db.query<{ last: string }>(
      "SELECT max(seq)::text AS last FROM credit_ledger WHERE workspace_id = $1 AND idempotency_key LIKE 'cycle_roll:%'",
      [ws],
    );
    const afterRoll = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM credit_ledger
        WHERE workspace_id = $1 AND entry_type = 'reserve' AND idempotency_key LIKE 'new-%' AND seq > $2::bigint`,
      [ws, rollSeq.rows[0]!.last],
    );
    const k = Number(afterRoll.rows[0]!.n);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThanOrEqual(9);
    expect(b.included_balance, `k = ${String(k)} spends reserved after the roll`).toBe(4000 - 15 * k);
    const spent = await db.query<{ spent: string }>("SELECT lifetime_spent::text AS spent FROM credit_wallets WHERE workspace_id = $1", [ws]);
    const committed = pre.reduce((n, credits, i) => (i % 2 === 0 ? n + credits - 5 : n), 0) + 9 * 15;
    expect(Number(spent.rows[0]!.spent)).toBe(committed);
    await replayClean(ws);
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

    async function apply(workspaceId: string, reconcile: (c: ProviderSubscriptionState) => ProviderSubscriptionState, now?: Date) {
      return inCtx(workspaceId, (tx) =>
        applyPlanChange(tx, workspaceId, reconcile, provenance, { allowDowngrade: true, ...(now === undefined ? {} : { now }) }),
      );
    }

    /** The workspace and its subscription on `plan`, with a wallet on that plan's grant. */
    async function onPlan(plan: string): Promise<number> {
      await db.query("UPDATE workspaces SET plan_key = $2 WHERE id = $1", [ws, plan]);
      await db.query("UPDATE subscriptions SET plan_key = $2 WHERE workspace_id = $1", [ws, plan]);
      const grant = await planGrant(plan);
      await wallet(ws, grant);
      return grant;
    }

    async function lifetimeGranted(workspaceId: string): Promise<number> {
      return Number((await balances(workspaceId)).lifetime_granted);
    }

    async function planChangeGrants(workspaceId: string) {
      return (await entries(workspaceId, ["grant"])).filter((g) => g.idempotency_key.startsWith("grant:plan_change"));
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

    it("STORY-072 AC13 · an event inside a period the subscription ALREADY holds is not a roll, even if the wallet's own cycle is behind", async () => {
      const grant = await planGrant("growth");
      await wallet(ws, grant); // wallet cycle = CYCLE_1
      await spend(ws, 100, "job-1");
      await db.query(
        "UPDATE subscriptions SET current_period_start = $2, current_period_end = $3 WHERE workspace_id = $1",
        [ws, CYCLE_2.start, CYCLE_2.end],
      );
      await apply(ws, (c) => ({ ...c, seatsPurchased: c.seatsPurchased + 1 }));
      expect((await balances(ws)).included_balance).toBe(grant - 100);
      expect(await entries(ws, ["expire"])).toEqual([]);
    });

    it("STORY-072 AC13 · an upgrade that carries a new period still restarts the auto-top-up counter (EC-48)", async () => {
      const grantStarter = await planGrant("starter");
      await db.query("UPDATE workspaces SET plan_key = 'starter' WHERE id = $1", [ws]);
      await db.query("UPDATE subscriptions SET plan_key = 'starter' WHERE workspace_id = $1", [ws]);
      await wallet(ws, grantStarter);
      await db.query("UPDATE credit_wallets SET auto_topup_count_cycle = 2 WHERE workspace_id = $1", [ws]);
      await apply(ws, advance(CYCLE_2, "growth"));
      expect((await balances(ws)).auto_topup_count_cycle).toBe(0);
    });

    it("STORY-072 AC13 · a downgrade landing at the period end resets to the NEW plan's grant", async () => {
      const grantGrowth = await planGrant("growth");
      const grantStarter = await planGrant("starter");
      await wallet(ws, grantGrowth);

      await apply(ws, advance(CYCLE_2, "starter"));

      expect((await balances(ws)).included_balance).toBe(grantStarter);
      expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: grantGrowth })]);
    });

    it("STORY-072 AC13 · FREE to PAID with a new period grants the new plan: the remaining credits carry in, up to the grant (exact)", async () => {
      const free = await onPlan("free");
      const starter = await planGrant("starter");
      await spend(ws, 20, "job-1"); // 40 left of 60

      await apply(ws, advance(CYCLE_2, "starter"));

      const b = await balances(ws);
      expect(b).toMatchObject({ included_balance: starter, reserved: 0, cycle_start: CYCLE_2.start, cycle_end: CYCLE_2.end });
      // The 40 remaining credits carry INTO the grant: granted = grant - carried, nothing expires, nothing is minted twice.
      expect(await entries(ws, ["expire"])).toEqual([]);
      const rollGrant = (await entries(ws, ["grant"])).filter((g) => g.idempotency_key === `cycle_roll:${CYCLE_2.start}`);
      expect(rollGrant).toEqual([expect.objectContaining({ credits: starter - 40 })]);
      expect(await lifetimeGranted(ws)).toBe(free + starter - 40);
      expect(await planChangeGrants(ws), "the pro-rata step is skipped whenever a roll happened").toEqual([]);
      await replayClean(ws);
    });

    describe("a conversion on the SAME UTC day the free wallet's cycle began (the common path)", () => {
      const FREE_START = new Date("2026-09-01T03:00:00.000Z");
      const PAID = (hour: string) => (c: ProviderSubscriptionState): ProviderSubscriptionState => ({
        ...c,
        planKey: "starter",
        currentPeriodStart: new Date(`2026-09-01T${hour}:00:00.000Z`),
        currentPeriodEnd: new Date(`2026-10-01T${hour}:00:00.000Z`),
      });

      beforeEach(async () => {
        await onPlan("free");
        await db.query("UPDATE subscriptions SET current_period_start = $2, current_period_end = $3 WHERE workspace_id = $1", [
          ws, FREE_START, new Date("2026-10-01T03:00:00.000Z"),
        ]);
      });

      it("STORY-072 AC13 · free to paid hours later the same UTC day lands on exactly the target grant, with no pro-rata (exact)", async () => {
        const free = 60;
        const starter = await planGrant("starter");
        await spend(ws, 20, "job-1"); // 40 left of 60

        const outcome = await apply(ws, PAID("11"), new Date("2026-09-01T11:00:00.000Z"));

        expect(outcome.creditsToppedUp).toBe(0);
        expect(await balances(ws)).toMatchObject({ included_balance: starter, reserved: 0 });
        expect(await planChangeGrants(ws), "no pro-rata on top of the roll").toEqual([]);
        expect(await entries(ws, ["expire"])).toEqual([]);
        expect(await lifetimeGranted(ws)).toBe(free + starter - 40);
        await replayClean(ws);
      });

      it("STORY-072 AC13 · the same with the whole free grant spent (exact)", async () => {
        const starter = await planGrant("starter");
        await spend(ws, 60, "job-1");

        await apply(ws, PAID("11"), new Date("2026-09-01T11:00:00.000Z"));

        expect((await balances(ws)).included_balance).toBe(starter);
        expect(await planChangeGrants(ws)).toEqual([]);
        await replayClean(ws);
      });

      it("STORY-072 AC13 · a redelivery of that same-day conversion does not roll or grant again", async () => {
        const starter = await planGrant("starter");
        await spend(ws, 20, "job-1");
        await apply(ws, PAID("11"), new Date("2026-09-01T11:00:00.000Z"));
        const before = await entries(ws, ["grant", "expire"]);

        await apply(ws, PAID("11"), new Date("2026-09-01T11:30:00.000Z"));

        expect((await balances(ws)).included_balance).toBe(starter);
        expect(await entries(ws, ["grant", "expire"])).toEqual(before);
      });

      it("STORY-072 AC13 · a second new period on that same day rolls again under its own ledger key (no disagreement)", async () => {
        const growth = await planGrant("growth");
        await apply(ws, PAID("11"), new Date("2026-09-01T11:00:00.000Z"));

        await apply(ws, (c) => ({ ...PAID("15")(c), planKey: "growth" }), new Date("2026-09-01T15:00:00.000Z"));

        expect((await balances(ws)).included_balance).toBe(growth);
        expect(await planChangeGrants(ws)).toEqual([]);
        await replayClean(ws);
      });

      it("STORY-072 AC13 · a wallet whose cycle is already LATER than the event's period day is never rolled backwards", async () => {
        await db.query("UPDATE credit_wallets SET cycle_start = '2026-10-01', cycle_end = '2026-11-01' WHERE workspace_id = $1", [ws]);

        await apply(ws, (c) => ({ ...c, currentPeriodStart: new Date("2026-09-01T11:00:00.000Z"), currentPeriodEnd: new Date("2026-10-01T11:00:00.000Z") }), new Date("2026-09-01T12:00:00.000Z"));

        expect(await balances(ws)).toMatchObject({ cycle_start: "2026-10-01", included_balance: 60 });
        expect(await entries(ws, ["grant", "expire"]).then((e) => e.filter((x) => x.idempotency_key.startsWith("cycle_roll")))).toEqual([]);
      });

      it("STORY-072 AC13 · an event whose period starts EARLIER the same day than the one on file is not a roll", async () => {
        const starter = await planGrant("starter");
        await spend(ws, 20, "job-1");
        await apply(ws, PAID("11"), new Date("2026-09-01T11:00:00.000Z"));
        await spend(ws, 5, "job-2");

        await apply(ws, PAID("05"), new Date("2026-09-01T12:00:00.000Z"));

        expect((await balances(ws)).included_balance).toBe(starter - 5);
      });
    });

    it("STORY-072 AC13 · PAID to PAID upgrade with a new period lands on exactly the target grant, with no pro-rata on top (exact)", async () => {
      const starter = await onPlan("starter");
      const growth = await planGrant("growth");
      await spend(ws, 10, "job-1"); // 440 left

      await apply(ws, advance(CYCLE_2, "growth"));

      expect(await balances(ws)).toMatchObject({ included_balance: growth, cycle_start: CYCLE_2.start });
      expect(await entries(ws, ["expire"])).toEqual([]);
      expect(await lifetimeGranted(ws)).toBe(starter + (growth - (starter - 10)));
      expect(await planChangeGrants(ws)).toEqual([]);
      await replayClean(ws);
    });

    it("STORY-072 AC13 / AC14 · an upgrade WITHIN the same period keeps its pro-rata top-up, on a controlled clock (exact)", async () => {
      const starter = await onPlan("starter");
      const growth = await planGrant("growth");
      await spend(ws, 10, "job-1");

      // CYCLE_1 is 2026-09-01 .. 2026-10-01: 30 days, 15 of them left at the 16th.
      const topUp = Math.floor(((growth - starter) * 15) / 30);
      const outcome = await apply(
        ws,
        (c) => ({ ...c, planKey: "growth" }),
        new Date("2026-09-16T00:00:00.000Z"),
      );

      expect(outcome.creditsToppedUp).toBe(topUp);
      expect(await balances(ws)).toMatchObject({ included_balance: starter - 10 + topUp, cycle_start: CYCLE_1.start });
      expect(await entries(ws, ["expire"])).toEqual([]);
      expect(await planChangeGrants(ws)).toHaveLength(1);
      await replayClean(ws);
    });

    it("STORY-072 AC13 · an upgrade with a new period for a wallet that carries a HELD credit keeps the hold and still lands on grant + carry", async () => {
      await onPlan("starter");
      const growth = await planGrant("growth");
      await openHold(ws, 100, "job-1");

      await apply(ws, advance(CYCLE_2, "growth"));
      await commitHold(ws, "job-1", 100);

      expect(await balances(ws)).toMatchObject({ included_balance: growth, reserved: 0 });
      await replayClean(ws);
    });

    // ---- past_due: wait for the payment (owner decision 2026-10-15) ----------------------------------------
    describe("a failed renewal (past_due)", () => {
      const pastDue = (period: { start: string; end: string }) => (c: ProviderSubscriptionState): ProviderSubscriptionState => ({
        ...advance(period)(c),
        status: "past_due",
      });
      const recovered = (c: ProviderSubscriptionState): ProviderSubscriptionState => ({ ...c, status: "active" });

      it("STORY-072 AC13 · a period change that arrives past_due does NOT roll the wallet", async () => {
        const grant = await onPlan("growth");
        await spend(ws, 100, "job-1");

        await apply(ws, pastDue(CYCLE_2));

        expect(await balances(ws)).toMatchObject({ included_balance: grant - 100, cycle_start: CYCLE_1.start });
        expect(await entries(ws, ["expire"])).toEqual([]);
        const sub = await db.query<{ status: string; start: string }>(
          "SELECT status, to_char(current_period_start,'YYYY-MM-DD') AS start FROM subscriptions WHERE workspace_id = $1", [ws]);
        expect(sub.rows[0]).toEqual({ status: "past_due", start: CYCLE_2.start });
      });

      it("STORY-072 AC13 · the payment succeeding (the subscription is active again, same period) rolls the wallet ONCE", async () => {
        const grant = await onPlan("growth");
        await spend(ws, 100, "job-1");
        await apply(ws, pastDue(CYCLE_2));
        expect(await entries(ws, ["expire"]), "nothing rolled while the payment was outstanding").toEqual([]);

        await apply(ws, recovered);

        expect(await balances(ws)).toMatchObject({ included_balance: grant, cycle_start: CYCLE_2.start, cycle_end: CYCLE_2.end });
        expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: grant - 100 })]);
        await replayClean(ws);
      });

      it("STORY-072 AC13 · an UPGRADE that arrives past_due with a new period mints no pro-rata, and the recovery lands on exactly the target grant", async () => {
        const starter = await onPlan("starter");
        const growth = await planGrant("growth");
        await spend(ws, 10, "job-1"); // starter - 10 left

        // Mid-cycle on the OLD cycle: the pro-rata arithmetic would mint a positive figure here.
        const outcome = await apply(
          ws,
          (c) => ({ ...pastDue(CYCLE_2)(c), planKey: "growth" }),
          new Date("2026-09-16T00:00:00.000Z"),
        );

        expect(outcome.creditsToppedUp, "an unpaid new period earns no plan_change grant").toBe(0);
        expect(await planChangeGrants(ws)).toEqual([]);
        expect(await balances(ws)).toMatchObject({ included_balance: starter - 10, cycle_start: CYCLE_1.start });

        await apply(ws, recovered);

        expect(await balances(ws)).toMatchObject({ included_balance: growth, cycle_start: CYCLE_2.start });
        expect(await planChangeGrants(ws)).toEqual([]);
        await replayClean(ws);
      });

      it("STORY-072 AC13 · a replay of the recovery (or of the past_due event) does not roll twice", async () => {
        const grant = await onPlan("growth");
        await spend(ws, 100, "job-1");
        await apply(ws, pastDue(CYCLE_2));
        expect(await entries(ws, ["expire"]), "nothing rolled while the payment was outstanding").toEqual([]);
        await apply(ws, recovered);
        await spend(ws, 50, "job-2");

        await apply(ws, recovered);
        await apply(ws, recovered);

        expect(await entries(ws, ["expire"])).toHaveLength(1);
        expect((await balances(ws)).included_balance, "the spend after the roll must survive the replays").toBe(grant - 50);
      });

      it("STORY-072 AC13 · several past_due period changes then one recovery roll once, into the LATEST period", async () => {
        const grant = await onPlan("growth");
        await spend(ws, 100, "job-1");
        await apply(ws, pastDue(CYCLE_2));
        await apply(ws, pastDue(CYCLE_3));

        await apply(ws, recovered);

        expect(await balances(ws)).toMatchObject({ included_balance: grant, cycle_start: CYCLE_3.start });
        expect(await entries(ws, ["expire"])).toHaveLength(1);
        await replayClean(ws);
      });

      it("STORY-072 AC13 · the auto-top-up counter waits for the roll, too: it restarts at recovery, not while past_due", async () => {
        await onPlan("growth");
        await db.query("UPDATE credit_wallets SET auto_topup_count_cycle = 2 WHERE workspace_id = $1", [ws]);

        await apply(ws, pastDue(CYCLE_2));
        expect((await balances(ws)).auto_topup_count_cycle).toBe(2);

        await apply(ws, recovered);
        expect((await balances(ws)).auto_topup_count_cycle).toBe(0);
      });

      it("STORY-072 AC13 · a past_due subscription that ENDS (back to free, never paid) is not a payment and does not roll", async () => {
        const grant = await onPlan("growth");
        await spend(ws, 100, "job-1");
        await apply(ws, pastDue(CYCLE_2));

        await apply(ws, (c) => ({ ...c, planKey: "free", status: "active" }));

        expect(await balances(ws)).toMatchObject({ included_balance: grant - 100, cycle_start: CYCLE_1.start });
        expect(await entries(ws, ["expire"])).toEqual([]);
      });

      it("STORY-072 AC13 · a past_due event inside the CURRENT period changes nothing, and neither does the active one that follows", async () => {
        const grant = await onPlan("growth");
        await spend(ws, 100, "job-1");

        await apply(ws, (c) => ({ ...c, status: "past_due" }));
        await apply(ws, recovered);

        expect(await balances(ws)).toMatchObject({ included_balance: grant - 100, cycle_start: CYCLE_1.start });
        expect(await entries(ws, ["expire"])).toEqual([]);
      });
    });

    it("STORY-072 AC13 · an ANNUAL subscription's period change still rolls (the monthly refresh is a follow-up story)", async () => {
      const grant = await onPlan("growth");
      await spend(ws, 100, "job-1");
      const year = { start: "2026-10-01", end: "2027-10-01" };

      await apply(ws, (c) => ({ ...advance(year)(c), billingInterval: "annual" }));

      expect(await balances(ws)).toMatchObject({ included_balance: grant, cycle_start: year.start, cycle_end: year.end });
      expect(await entries(ws, ["expire"])).toHaveLength(1);
    });
  });

  // ---- the WEBHOOK that marks the payment succeeded ------------------------------------------------------------
  //
  // `customer.subscription.updated` is the event that returns a subscription from past_due to active (and that lifts
  // the workspace out of past_due); it carries the SAME period start the failed-renewal one did. Driven through the real
  // handler, so "the roll happens when the payment succeeds" is proven at the event, not only at applyPlanChange.
  describe("the subscription webhook handler", () => {
    const SUB = "sub_hook";
    const sec = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

    function subscription(status: string, period: { start: string; end: string }): Record<string, unknown> {
      return {
        id: SUB, object: "subscription", status, customer: "cus_hook", cancel_at_period_end: false,
        current_period_start: sec(period.start), current_period_end: sec(period.end),
        items: { data: [{ quantity: 1, price: { unit_amount: 12900, currency: "usd", recurring: { interval: "month", interval_count: 1 }, product: { metadata: { nominara_kind: "plan" } } } }] },
      };
    }

    let fetchAt = Date.now();
    async function deliver(workspaceId: string, eventId: string, raw: Record<string, unknown>): Promise<void> {
      const handler = new StripeSubscriptionHandler({ reconcile: async () => undefined } as unknown as BillingAddonsService);
      fetchAt += 1000;
      await inCtx(workspaceId, (tx) =>
        handler.handle({
          tx, workspaceId,
          event: { id: eventId, type: "customer.subscription.updated", objectId: SUB },
          object: { kind: "subscription", id: SUB, metadata: { plan_key: "growth", workspace_id: workspaceId }, raw },
          fetchStartedAt: new Date(fetchAt),
          afterCommit: [],
        }),
      );
    }

    async function workspaceStatus(workspaceId: string): Promise<string> {
      return (await db.query<{ status: string }>("SELECT status FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.status;
    }

    it("STORY-072 AC13 · past_due waits; the active event that follows rolls the wallet once; a redelivery does not roll it again", async () => {
      await db.query("UPDATE subscriptions SET stripe_subscription_id = $2, provider = 'stripe' WHERE workspace_id = $1", [ws, SUB]);
      const grant = (await db.query<{ credits_per_cycle: number }>("SELECT credits_per_cycle FROM plans WHERE key = 'growth'")).rows[0]!.credits_per_cycle;
      await wallet(ws, grant);
      await spend(ws, 100, "job-1");

      await deliver(ws, "evt_1", subscription("past_due", CYCLE_2));
      expect(await workspaceStatus(ws)).toBe("past_due");
      expect(await balances(ws)).toMatchObject({ included_balance: grant - 100, cycle_start: CYCLE_1.start });
      expect(await entries(ws, ["expire"])).toEqual([]);

      await deliver(ws, "evt_2", subscription("active", CYCLE_2));
      expect(await workspaceStatus(ws)).not.toBe("past_due");
      expect(await balances(ws)).toMatchObject({ included_balance: grant, cycle_start: CYCLE_2.start });
      expect(await entries(ws, ["expire"])).toEqual([expect.objectContaining({ credits: grant - 100 })]);

      await spend(ws, 25, "job-2");
      await deliver(ws, "evt_3", subscription("active", CYCLE_2));
      expect((await balances(ws)).included_balance).toBe(grant - 25);
      expect(await entries(ws, ["expire"])).toHaveLength(1);
      await replayClean(ws);
    });
  });

  describe("the period the roll and the period derivation both name (UTC)", () => {
    it("STORY-072 AC13 · resolveBillingPeriod names the UTC day of a period boundary whatever the session time zone", async () => {
      const id = await newWorkspace("growth");
      await db.query(
        "UPDATE subscriptions SET current_period_start = $2, current_period_end = $3 WHERE workspace_id = $1",
        [id, "2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"],
      );

      const period = await inCtx(id, async (tx) => {
        await tx.query("SET LOCAL TIME ZONE 'America/Los_Angeles'");
        return resolveBillingPeriod(tx, id);
      });

      // In Los Angeles that instant is the evening of 30 September; the roll writes the UTC day.
      expect(period).toEqual({ start: "2026-10-01", end: "2026-11-01" });
    });
  });
});

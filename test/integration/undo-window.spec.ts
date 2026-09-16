import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { UNDO_WINDOW_MS, undoRunCharge } from "../../src/lib/credits/undo.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { commitCredits, readWallet, reserveCredits } from "../../src/lib/credits/wallet.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-074 AC8, scenarios 9 and 10 — "undo before the job starts releases
// the reservation", "undo after it starts is disabled with an explanation".
//
// ⚠ IT REFUNDS RATHER THAN RELEASING. `CreditInterceptor` commits the moment
// the handler returns, and the trigger's 202 arrives with cells already
// dispatched — so by the time a toast is on screen the credits are spent and
// there is no reservation. §7's wording predates STORY-072's settlement
// design; refunding delivers the same promise and leaves the ledger
// explaining the money in both directions.

describe("STORY-074 · the undo window", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let userId: string;
  let runId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, credit_wallets, workspaces, users CASCADE");
    workspaceId = randomUUID();
    runId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    userId = (
      await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
        `a-${randomUUID().slice(0, 8)}@nominara.test`,
      ])
    ).rows[0]!.id;
  });

  async function inTx<T>(fn: (tx: Client) => Promise<T>): Promise<T> {
    await db.query("BEGIN");
    try {
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  /** A run that was charged, exactly as the guard and interceptor would have left it. */
  async function chargeRun(credits: number, key = "job"): Promise<void> {
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 1_000, { start: "2026-09-01", end: "2026-10-01" }));

    const reserved = await reserveCredits(db, workspaceId, credits);
    await appendLedgerEntry(db, {
      workspaceId,
      entryType: "reserve",
      actionCode: "manual_scan",
      credits,
      idempotencyKey: key,
      attempt: 1,
      after: reserved.wallet!,
      actorId: userId,
      actorType: "user",
    });
    const committed = await commitCredits(db, workspaceId, credits, credits);
    await appendLedgerEntry(db, {
      workspaceId,
      entryType: "commit",
      actionCode: "manual_scan",
      credits,
      idempotencyKey: key,
      attempt: 1,
      after: committed!,
      actorId: userId,
      actorType: "user",
      referenceType: "run",
      referenceId: runId,
    });
  }

  const undo = (over: { settledCells?: number; windowMs?: number } = {}) =>
    withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
      undoRunCharge(tx, {
        workspaceId,
        runId,
        actorId: userId,
        actorType: "user",
        settledCells: over.settledCells ?? 0,
        ...(over.windowMs === undefined ? {} : { windowMs: over.windowMs }),
      }),
    );

  it("scenario 9 — gives the credits back when no cell has produced a result", async () => {
    await chargeRun(200);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 800 });

    expect(await undo()).toEqual({ refunded: 200, refusal: null });

    const wallet = await readWallet(db, workspaceId);
    // ⚠ BACK AS PURCHASED, NOT AS INCLUDED. `commit` entries carry no bucket —
    // the split is an outcome of "expiring first", not a choice — so a refund
    // has to decide. Included credits lapse at cycle end, so returning them
    // there could hand back something worth nothing by Friday. Purchased is
    // never worse for the customer.
    expect(wallet).toMatchObject({ includedBalance: 800, purchasedBalance: 200, available: 1_000 });
  });

  it("writes a refund entry that explains the money coming back", async () => {
    await chargeRun(200);
    await undo();

    const entry = await db.query<Record<string, unknown>>(
      `SELECT credits, bucket, reference_type, reference_id, actor_id, actor_type
         FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund'`,
      [workspaceId],
    );
    expect(entry.rows[0]).toMatchObject({
      credits: 200,
      bucket: "purchased",
      reference_type: "run",
      reference_id: runId,
      actor_id: userId,
      actor_type: "user",
    });
  });

  it("⚠ keys the refund on THE DEBIT'S key, which is what makes a double undo impossible", async () => {
    // Asserted directly rather than only through the two-click outcome: an
    // early `alreadyRefunded` read also stops the second click, so each
    // defence masks the other's test and a freshly generated key survived
    // the outcome assertion. `ux_credit_ledger_idem` is the guarantee; this
    // is what feeds it.
    await chargeRun(200, "the-debit-key");
    await undo();

    const key = await db.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund'",
      [workspaceId],
    );
    expect(key.rows[0]!.idempotency_key).toBe("the-debit-key");
  });

  it("⚠ scenario 10 — refuses once a cell has produced a result, and says why", async () => {
    await chargeRun(200);
    expect(await undo({ settledCells: 1 })).toEqual({ refunded: 0, refusal: "work_started" });
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 800, purchasedBalance: 0 });
  });

  it("counts a FAILED cell as work done", async () => {
    // An engine that was called and errored still cost us the call. "The job
    // has not started" is about work, not about success.
    await chargeRun(200);
    expect((await undo({ settledCells: 1 })).refusal).toBe("work_started");
  });

  it("refuses once the window is up, and distinguishes that from work having started", async () => {
    await chargeRun(200);
    // Age the debit past the window without waiting for it.
    await db.query("ALTER TABLE credit_ledger DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE credit_ledger SET occurred_at = now() - interval '1 hour' WHERE entry_type = 'commit'");
    await db.query("ALTER TABLE credit_ledger ENABLE TRIGGER reject_update_delete");

    expect(await undo()).toEqual({ refunded: 0, refusal: "window_closed" });
    expect(await readWallet(db, workspaceId)).toMatchObject({ purchasedBalance: 0 });
  });

  it("⚠ hands back ONE refund for two undo clicks", async () => {
    // Idempotent by the ledger, like everything else in this epic: the refund
    // carries the debit's own key, so `ux_credit_ledger_idem` refuses the
    // second and the wallet movement rolls back with it.
    await chargeRun(200);

    expect((await undo()).refunded).toBe(200);
    expect(await undo()).toEqual({ refunded: 0, refusal: null });

    expect(await readWallet(db, workspaceId)).toMatchObject({ purchasedBalance: 200, available: 1_000 });
    const refunds = await db.query("SELECT 1 FROM credit_ledger WHERE entry_type = 'refund'");
    expect(refunds.rowCount).toBe(1);
  });

  it("is a no-op, not an error, for a run that was never charged", async () => {
    // A scheduled run is inside the subscription envelope. There is nothing
    // to give back and nothing went wrong.
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 1_000, { start: "2026-09-01", end: "2026-10-01" }));
    expect(await undo()).toEqual({ refunded: 0, refusal: null });
  });

  it("holds §7's five seconds as the window", () => {
    expect(UNDO_WINDOW_MS).toBe(5_000);
  });

  it("⚠ checks work BEFORE the window, so a started job is never reported as merely expired", async () => {
    // The two refusals mean different things to a customer: "we already ran
    // it" is final, "you were too slow" invites a support conversation about
    // a scan that produced nothing. Reporting the wrong one is a worse answer
    // than reporting no reason at all.
    await chargeRun(200);
    await db.query("ALTER TABLE credit_ledger DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE credit_ledger SET occurred_at = now() - interval '1 hour' WHERE entry_type = 'commit'");
    await db.query("ALTER TABLE credit_ledger ENABLE TRIGGER reject_update_delete");

    expect((await undo({ settledCells: 3 })).refusal).toBe("work_started");
  });
});

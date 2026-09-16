import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import type { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { RunLifecycleService } from "../../src/modules/tracking/run-lifecycle.service.js";
import { appendLedgerEntry } from "../../src/lib/credits/ledger.js";
import { UNDO_WINDOW_MS, undoRunCharge } from "../../src/lib/credits/undo.js";
import { provisionWalletWithGrant, recordPurchase } from "../../src/lib/credits/balance.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
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

/**
 * ⚠ TWO PRICES, AND THE DIFFERENCE IS §7's WHOLE ROUTING RULE.
 *
 * `SUB_THRESHOLD` is small enough to clear every escalation rule against the
 * 1,000-credit wallet below, so it takes §7's toast-and-undo path. `CONFIRMED`
 * is over `creditsAbove` (25), so it takes the cost modal instead and has no
 * undo at all — which is where every seeded `deep_scan.credits` (100/200/500)
 * lands.
 */
const SUB_THRESHOLD = 20;
const CONFIRMED = 200;

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
    stopped = 0;
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
    await chargeRunOnly(credits, key);
  }

  /** The same, against a wallet that already exists. */
  async function chargeRunOnly(credits: number, key = "job"): Promise<void> {

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

  /** Records whether the ordering contract held: stop the work, then move credits. */
  let stopped = 0;

  const undo = (
    over: {
      deliveredCells?: number;
      windowMs?: number;
      maxProjects?: number | null | "unreadable";
      stopWork?: () => Promise<void>;
    } = {},
  ) =>
    withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
      undoRunCharge(tx, {
        stopWork:
          over.stopWork ??
          (async () => {
            stopped += 1;
            await Promise.resolve();
          }),
        workspaceId,
        runId,
        maxProjects: over.maxProjects ?? 5,
        actorId: userId,
        actorType: "user",
        deliveredCells: over.deliveredCells ?? 0,
        ...(over.windowMs === undefined ? {} : { windowMs: over.windowMs }),
      }),
    );

  it("scenario 9 — gives the credits back when nothing has been delivered", async () => {
    await chargeRun(SUB_THRESHOLD);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 - SUB_THRESHOLD });

    expect(await undo()).toEqual({ refunded: SUB_THRESHOLD, refusal: null });

    // ⚠ BACK WHERE THEY CAME FROM. The first version sent every refund to
    // `purchased`, reasoning that included credits expire so returning them
    // there could hand back something worthless. `commitCredits` always draws
    // included-first, so that turned trigger-and-undo into a laundry: five
    // cycles moved a wallet from 1,000 included / 0 purchased to 0 / 1,000 —
    // same available balance, expiry destroyed — and the nightly verifier
    // reported clean the whole way, because the ledger was consistent.
    expect(await readWallet(db, workspaceId)).toMatchObject({
      includedBalance: 1_000,
      purchasedBalance: 0,
      available: 1_000,
    });
  });

  it("⚠ cannot be used to launder expiring credits into durable ones", async () => {
    // The exploit, run as an exploit: trigger and undo repeatedly and check
    // the buckets are exactly where they started.
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 1_000, { start: "2026-09-01", end: "2026-10-01" }));

    for (let cycle = 0; cycle < 5; cycle += 1) {
      runId = randomUUID();
      await chargeRunOnly(SUB_THRESHOLD, `job-${String(cycle)}`);
      expect((await undo()).refunded).toBe(SUB_THRESHOLD);
    }

    expect(await readWallet(db, workspaceId)).toMatchObject({
      includedBalance: 1_000,
      purchasedBalance: 0,
    });
  });

  it("⚠ restores a commit that SPANNED both buckets, to both buckets", async () => {
    // `commitCredits` draws `LEAST(included, n)` first and spills the rest
    // onto purchased. A refund that guessed one bucket would move credits
    // between them even when it got the total right.
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 8, { start: "2026-09-01", end: "2026-10-01" }));
    await inTx((tx) =>
      recordPurchase(tx, { workspaceId, idempotencyKey: "pack", actorId: null, actorType: "system" }, 500),
    );
    await chargeRunOnly(SUB_THRESHOLD, "spanning");

    // 8 from included (all of it), 12 from purchased.
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 0, purchasedBalance: 488 });

    expect((await undo()).refunded).toBe(SUB_THRESHOLD);
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 8, purchasedBalance: 500 });
  });

  it("⚠ STOPS THE WORK BEFORE MOVING ANY CREDIT", async () => {
    // Refund-then-stop hands credits back for work that goes on to happen.
    // The ordering is inside `undoRunCharge` rather than at the call site,
    // and this is what holds it there.
    await chargeRun(SUB_THRESHOLD);
    const order: string[] = [];

    await undo({
      stopWork: async () => {
        const refunds = await db.query("SELECT 1 FROM credit_ledger WHERE entry_type = 'refund'");
        order.push(`stop:refunds=${String(refunds.rowCount)}`);
      },
    });
    order.push("done");

    // No refund existed at the moment the work was stopped.
    expect(order).toEqual(["stop:refunds=0", "done"]);
  });

  it("⚠ does NOT stop the work when the undo is refused", async () => {
    // Stop-then-check would leave a customer who asked to take it back, was
    // told no, and lost the scan anyway.
    await chargeRun(SUB_THRESHOLD);

    expect((await undo({ deliveredCells: 1 })).refusal).toBe("work_started");
    expect((await undo({ windowMs: 0 })).refusal).toBe("window_closed");
    expect(stopped).toBe(0);
  });

  it("⚠ moves nothing when the work cannot be stopped", async () => {
    // A run that finished between the read and the cancel. The refund must
    // not land for a scan that was delivered.
    await chargeRun(SUB_THRESHOLD);

    await expect(
      undo({
        stopWork: () => Promise.reject(new Error("a completed run cannot be cancelled")),
      }),
    ).rejects.toThrow(/cannot be cancelled/u);

    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 - SUB_THRESHOLD });
    expect((await db.query("SELECT 1 FROM credit_ledger WHERE entry_type = 'refund'")).rowCount).toBe(0);
  });

  it("⚠ leaves the wallet reconciling against its own ledger after a refund", async () => {
    // STORY-073's nightly replay is the thing that would page a human. A
    // refund that moved credits somewhere the ledger does not explain must
    // not pass it.
    await chargeRun(SUB_THRESHOLD);
    await undo();
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  it("⚠ refuses an action that went through the cost modal, before anything else", async () => {
    // §7 gives the undo to actions BELOW all thresholds. Something a customer
    // explicitly approved at a stated figure does not also need taking back —
    // and answering "you were too slow" for an undo they were never offered
    // would be worse than answering nothing.
    //
    // ⚠ NOT A FLAG. The verdict is re-derived from the debit's own amount and
    // the balance recorded on the entry before it, so this test changes the
    // PRICE rather than telling the code what to conclude.
    await chargeRun(CONFIRMED);
    expect(await undo()).toEqual({ refunded: 0, refusal: "action_was_confirmed" });
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 800, purchasedBalance: 0 });
  });

  it("⚠ judges the thresholds against the balance BEFORE the charge, not after it", async () => {
    // ⚠ A NARROW BAND, AND THE ONLY PLACE THE TWO READINGS DIFFER. §7's
    // thresholds were evaluated at QUOTE time, against the balance the
    // customer still had. Re-deriving them from the post-charge balance makes
    // the action look bigger than it was — the share-of-balance rule fires on
    // a debit the modal never demanded a confirmation for, and the undo the
    // customer was offered is then refused.
    //
    // 20 credits against 210: a tenth of 210 is 21, so nothing fires and the
    // undo stands. Against the post-charge 190 a tenth is 19, so it would.
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 210, { start: "2026-09-01", end: "2026-10-01" }));
    await chargeRunOnly(SUB_THRESHOLD, "narrow-band");

    expect(await undo()).toEqual({ refunded: SUB_THRESHOLD, refusal: null });
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 210 });
  });

  it("⚠ says CONFIRMED rather than expired when both would apply", async () => {
    await chargeRun(CONFIRMED);
    await db.query("ALTER TABLE credit_ledger DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE credit_ledger SET occurred_at = now() - interval '1 hour' WHERE entry_type = 'commit'");
    await db.query("ALTER TABLE credit_ledger ENABLE TRIGGER reject_update_delete");

    expect((await undo({ deliveredCells: 4 })).refusal).toBe("action_was_confirmed");
  });

  it("⚠ counts a CACHE-SERVED cell as delivered", async () => {
    // ⚠ THE FREE LOOP. `run-progress.ts` says it plainly — "A SUPPRESSED CELL
    // IS DONE" — and the first version counted only `captured + failed`. So a
    // re-triggered scan whose every cell was an L1 hit delivered every answer
    // at `pct: 100`, charged the flat price by design, and handed back every
    // credit. Deep scans carry no daily cap, so it was unbounded.
    await chargeRun(SUB_THRESHOLD);
    expect(await undo({ deliveredCells: 6 })).toEqual({ refunded: 0, refusal: "work_started" });
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 - SUB_THRESHOLD });
  });

  it("writes a refund entry that explains the money coming back", async () => {
    await chargeRun(SUB_THRESHOLD);
    await undo();

    const entry = await db.query<Record<string, unknown>>(
      `SELECT credits, bucket, reference_type, reference_id, actor_id, actor_type
         FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund'`,
      [workspaceId],
    );
    expect(entry.rows[0]).toMatchObject({
      credits: SUB_THRESHOLD,
      // The bucket the commit actually drew from — a 1,000-credit grant with
      // nothing purchased, so all of it came from `included`.
      bucket: "included",
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
    //
    // Suffixed by bucket because a commit spanning both produces TWO refund
    // entries, and the index is per (workspace, type, key, attempt) — two
    // entries under one key would collide with each other rather than with a
    // second undo.
    await chargeRun(SUB_THRESHOLD, "the-debit-key");
    await undo();

    const key = await db.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'refund'",
      [workspaceId],
    );
    expect(key.rows[0]!.idempotency_key).toBe("the-debit-key:included");
  });

  it("⚠ scenario 10 — refuses once a cell has produced a result, and says why", async () => {
    await chargeRun(SUB_THRESHOLD);
    expect(await undo({ deliveredCells: 1 })).toEqual({ refunded: 0, refusal: "work_started" });
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 - SUB_THRESHOLD, purchasedBalance: 0 });
  });

  it("counts a FAILED cell as work done", async () => {
    // An engine that was called and errored still cost us the call. "The job
    // has not started" is about work, not about success.
    await chargeRun(SUB_THRESHOLD);
    expect((await undo({ deliveredCells: 1 })).refusal).toBe("work_started");
  });

  it("refuses once the window is up, and distinguishes that from work having started", async () => {
    await chargeRun(SUB_THRESHOLD);
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
    await chargeRun(SUB_THRESHOLD);

    expect((await undo()).refunded).toBe(SUB_THRESHOLD);
    expect(await undo()).toEqual({ refunded: 0, refusal: null });

    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000, available: 1_000 });
    const refunds = await db.query("SELECT 1 FROM credit_ledger WHERE entry_type = 'refund'");
    expect(refunds.rowCount).toBe(1);
  });

  it("is a no-op, not an error, for a run that was never charged", async () => {
    // A scheduled run is inside the subscription envelope. There is nothing
    // to give back and nothing went wrong.
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 1_000, { start: "2026-09-01", end: "2026-10-01" }));
    expect(await undo()).toEqual({ refunded: 0, refusal: null });
  });

  describe("⚠ through the real service, where 'delivered' is COMPUTED", () => {
    // ⚠ EVERY TEST ABOVE PASSES `deliveredCells` IN, so none of them
    // exercises the definition — the suite stayed green with the service
    // hard-wiring it to `captured + failed`, which is the free-refund bug.
    // These build the run row and let `RunLifecycleService.undo` count.
    async function seedRun(counts: { planned: number; skipped: number; captured: number }): Promise<void> {
      const projectId = randomUUID();
      await db.query(
        `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, kind)
         VALUES ($1,$2,'P',$3,'https://e.test','e.test','brand')`,
        [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
      );
      await db.query(
        `INSERT INTO capture_runs
           (id, workspace_id, project_id, trigger, engine_keys, prompt_scope, planned_cells, skipped_cells,
            captured_cells, failed_cells, scoring_version, status, started_at)
         VALUES ($1,$2,$3,'manual',ARRAY['perplexity'],'all',$4,$5,$6,0,'v1','running',now())`,
        [runId, workspaceId, projectId, counts.planned, counts.skipped, counts.captured],
      );
    }

    const serviceUndo = (lifecycle: RunLifecycleService) =>
      withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => lifecycle.undo(runId, userId));

    function lifecycleService(): RunLifecycleService {
      // The queue producer is only reached by `cancel`'s afterCommit drain,
      // which never runs here because these transactions are rolled into the
      // test's own.
      return new RunLifecycleService(
        new InMemoryCacheAdapter(),
        { drainWaiting: () => Promise.resolve(0) } as unknown as QueueProducer,
      );
    }

    it("⚠ counts a CACHE-SERVED cell as delivered, so a fully cached re-run is not refunded", async () => {
      // ⚠ THE FREE, UNBOUNDED LOOP. Re-trigger a scan and every cell is an L1
      // hit: no engine is called, the flat price is charged by design, every
      // answer is readable at pct 100 — and the first version handed back
      // every credit, with no daily cap to bound it. `run-progress.ts` says
      // it plainly: "A SUPPRESSED CELL IS DONE."
      await chargeRun(SUB_THRESHOLD);
      await seedRun({ planned: 6, skipped: 6, captured: 0 });

      const result = await serviceUndo(lifecycleService());

      expect(result).toMatchObject({ credits_refunded: 0, refusal: "work_started" });
      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 - SUB_THRESHOLD });
    });

    it("refuses a partially cached run too — 97% delivered is delivered", async () => {
      await chargeRun(SUB_THRESHOLD);
      await seedRun({ planned: 100, skipped: 97, captured: 0 });

      expect((await serviceUndo(lifecycleService())).refusal).toBe("work_started");
    });

    it("⚠ refuses a deep scan even with nothing delivered, because it was confirmed", async () => {
      // §7 gives the undo to actions BELOW all thresholds. The cheapest
      // seeded `deep_scan.credits` is 100 against a threshold of 25, so every
      // deep scan takes the cost modal instead — and something approved at a
      // stated figure does not also need taking back. This route always
      // answers this today; it goes live when a cheap priced action exists.
      //
      // Charged at a real deep-scan price, so the verdict is DERIVED rather
      // than asserted into being.
      await chargeRun(CONFIRMED);
      await seedRun({ planned: 6, skipped: 0, captured: 0 });

      const result = await serviceUndo(lifecycleService());

      expect(result).toMatchObject({ credits_refunded: 0, refusal: "action_was_confirmed" });
      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 1_000 - CONFIRMED });
      // And the run it declined to refund is still running.
      const run = await db.query<{ status: string }>("SELECT status FROM capture_runs WHERE id = $1", [runId]);
      expect(run.rows[0]!.status).toBe("running");
    });
  });

  it("holds §7's five seconds as the window", () => {
    expect(UNDO_WINDOW_MS).toBe(5_000);
  });

  it("⚠ checks work BEFORE the window, so a started job is never reported as merely expired", async () => {
    // The two refusals mean different things to a customer: "we already ran
    // it" is final, "you were too slow" invites a support conversation about
    // a scan that produced nothing. Reporting the wrong one is a worse answer
    // than reporting no reason at all.
    await chargeRun(SUB_THRESHOLD);
    await db.query("ALTER TABLE credit_ledger DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE credit_ledger SET occurred_at = now() - interval '1 hour' WHERE entry_type = 'commit'");
    await db.query("ALTER TABLE credit_ledger ENABLE TRIGGER reject_update_delete");

    expect((await undo({ deliveredCells: 3 })).refusal).toBe("work_started");
  });
});

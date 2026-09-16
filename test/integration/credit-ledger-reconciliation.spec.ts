import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";
import {
  adjustCredits,
  expireCredits,
  grantCredits,
  provisionWalletWithGrant,
  recordPurchase,
  refundCredits,
} from "../../src/lib/credits/balance.js";
import { appendLedgerEntry, openReservations } from "../../src/lib/credits/ledger.js";
import {
  ORPHAN_GRACE_MS,
  reconcileOrphanedReservations,
  type ReconcileOutcome,
} from "../../src/lib/credits/reconcile.js";
import {
  readLedgerForReplay,
  readLifetimeCounters,
  replayLedger,
  verifyWorkspaceWallet,
} from "../../src/lib/credits/replay.js";
import { ReservationSettlementError, releaseReservation } from "../../src/lib/credits/settle.js";
import { commitCredits, readWallet, reserveCredits } from "../../src/lib/credits/wallet.js";

// STORY-073 — the append-only ledger, the reconciler, and replay.
//
// One of the four dangerous areas. Almost every scenario here is a
// constraint, a trigger, or a race between two transactions, and not one of
// them can be proven against a fake.

describe("STORY-073 · ledger, reconciliation and replay", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  /**
   * A real `nominara_app` connection — the role the worker and the hand-run
   * script actually use. `credit_ledger` carries FORCE ROW LEVEL SECURITY, and
   * the container superuser bypasses it, so every reconciler test in this file
   * ran against a privilege production does not have.
   */
  let appClient: Client;
  /** A pool on that same role — what `work` actually is in production. */
  let appPool: Pool;
  let workspaceId: string;
  /** A real `users` row: `credit_ledger.actor_id` carries an FK, and an adjustment must name someone who exists. */
  let humanId: string;

  const actor = (): { workspaceId: string; idempotencyKey: string; actorId: null; actorType: "system" } => ({
    workspaceId,
    idempotencyKey: `k-${randomUUID().slice(0, 8)}`,
    actorId: null,
    actorType: "system",
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 4 });

    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    appClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_app",
      resolvePassword("nominara_app", {}),
    );
    appPool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
      max: 4,
    });
  }, 300_000);

  afterAll(async () => {
    await appPool.end();
    await appClient.end();
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, credit_wallets, workspaces, users CASCADE");
    workspaceId = randomUUID();
    const human = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `a-${randomUUID().slice(0, 8)}@nominara.test`,
    ]);
    humanId = human.rows[0]!.id;
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  /**
   * Every balance operation runs inside a transaction, because they require
   * one — the wallet statement and the ledger entry have to commit together.
   * Production reaches them through `withTenantContext`, which is this with
   * the tenant GUCs set; the tests use the plainer version so a failure here
   * is about the ledger rather than about RLS.
   */
  async function inTx<T>(fn: (tx: ClientBase) => Promise<T>): Promise<T> {
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

  async function provision(grant: number): Promise<void> {
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, grant, { start: "2026-09-01", end: "2026-10-01" }));
  }

  async function ledgerRows(): Promise<
    { entry_type: string; credits: number; bucket: string | null; included_after: number; purchased_after: number; reserved_after: number; reason: string | null }[]
  > {
    const result = await db.query(
      `SELECT entry_type, credits, bucket, included_after, purchased_after, reserved_after, reason
         FROM credit_ledger WHERE workspace_id = $1 ORDER BY seq ASC`,
      [workspaceId],
    );
    return result.rows;
  }

  // ───────────────────────── scenario 1 ─────────────────────────

  describe("scenario 1 — every entry type is written at its moment", () => {
    it("records each type with the balances as they stand AFTER it", async () => {
      // ⚠ THE EXPECTED NUMBERS BELOW ARE HAND-COMPUTED, not read back from
      // the wallet. A test that asserted "the ledger says what the wallet
      // says" would pass against a pair that are wrong together, which is
      // the exact failure replay exists to catch.
      await provision(600);
      await inTx((tx) => recordPurchase(tx, actor(), 1000));
      await inTx((tx) => expireCredits(tx, actor(), "purchased", 250));
      await inTx((tx) => refundCredits(tx, actor(), "purchased", 50));
      await inTx((tx) => adjustCredits(tx, { ...actor(), actorId: humanId, actorType: "user", reason: "goodwill" }, "included", -100));

      const key = "req-1";
      const reserved = await reserveCredits(db, workspaceId, 40);
      await appendLedgerEntry(db, {
        workspaceId,
        entryType: "reserve",
        actionCode: "manual_scan",
        credits: 40,
        idempotencyKey: key,
        attempt: 1,
        after: reserved.wallet!,
        actorId: null,
        actorType: "system",
      });
      const committed = await commitCredits(db, workspaceId, 40, 40);
      await appendLedgerEntry(db, {
        workspaceId,
        entryType: "commit",
        actionCode: "manual_scan",
        credits: 40,
        idempotencyKey: key,
        attempt: 1,
        after: committed!,
        actorId: null,
        actorType: "system",
      });

      expect(await ledgerRows()).toEqual([
        { entry_type: "grant", credits: 600, bucket: "included", included_after: 600, purchased_after: 0, reserved_after: 0, reason: null },
        { entry_type: "purchase", credits: 1000, bucket: "purchased", included_after: 600, purchased_after: 1000, reserved_after: 0, reason: null },
        { entry_type: "expire", credits: 250, bucket: "purchased", included_after: 600, purchased_after: 750, reserved_after: 0, reason: null },
        { entry_type: "refund", credits: 50, bucket: "purchased", included_after: 600, purchased_after: 800, reserved_after: 0, reason: null },
        { entry_type: "adjustment", credits: -100, bucket: "included", included_after: 500, purchased_after: 800, reserved_after: 0, reason: "goodwill" },
        { entry_type: "reserve", credits: 40, bucket: null, included_after: 500, purchased_after: 800, reserved_after: 40, reason: null },
        { entry_type: "commit", credits: 40, bucket: null, included_after: 460, purchased_after: 800, reserved_after: 0, reason: null },
      ]);
    });

    it("accounts for the grant that provisioning itself applies", async () => {
      // ⚠ THE BUG THIS PINS. `provisionWallet` inserted `included_balance =
      // grant` and STORY-072 wrote no entry for it, so the first workspace to
      // touch a priced route held credits its ledger could not explain — and
      // the nightly verifier would have paged on every new workspace.
      await provision(600);

      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 600 });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("writes nothing on a re-provision, because nothing moved", async () => {
      await provision(600);
      const outcome = await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 600, { start: "2026-09-01", end: "2026-10-01" }));

      expect(outcome.applied).toBe(false);
      expect(await ledgerRows()).toHaveLength(1);
      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 600 });
    });

    it("refuses to move a balance for a workspace that has no wallet, rather than doing nothing quietly", async () => {
      // ⚠ NOT A SILENT NO-OP. Returning "already recorded" here would make a
      // sequencing bug indistinguishable from an ordinary redelivery — and
      // unlike a redelivery, this leaves nothing behind at all, so not even
      // the verifier would see the absence.
      await expect(inTx((tx) => grantCredits(tx, actor(), 100))).rejects.toThrow(/has no credit wallet/u);
    });

    it("writes no grant entry for a plan whose grant is zero", async () => {
      await provision(0);
      expect(await ledgerRows()).toEqual([]);
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });
  });

  describe("⚠ unit_detail is parsed on the way in, not merely typed", () => {
    // ⚠ THE TYPE WAS NOT A CHECK. `unitDetail` was `Record<string, number>`
    // and went straight to `JSON.stringify`, so a handler could write `{}` or
    // invented keys into an APPEND-ONLY financial record, and the read
    // endpoint returned them — both violating the route's own published
    // contract. `ledgerUnitDetailSchema`'s unit test asserts it "rejects an
    // unknown member rather than carrying it into a financial record";
    // nothing on the write path had ever run it.
    //
    // The casts below are the point rather than a convenience: the compiler
    // stops a TypeScript caller, and the runtime has to stop everyone else —
    // a JS consumer, a future refactor, a handler built from request data.
    beforeEach(async () => {
      await provision(600);
    });

    async function write(unitDetail: unknown): Promise<void> {
      const after = (await readWallet(db, workspaceId))!;
      await inTx((tx) =>
        appendLedgerEntry(tx, {
          workspaceId,
          entryType: "commit",
          actionCode: "manual_scan",
          credits: 1,
          idempotencyKey: `u-${randomUUID().slice(0, 8)}`,
          attempt: 1,
          after,
          actorId: null,
          actorType: "system",
          unitDetail: unitDetail as never,
        }),
      );
    }

    for (const [name, detail] of [
      ["an empty object", {}],
      ["a partial split", { prompts: 1, engines: 1, cells_charged: 2 }],
      ["an invented key", { prompts: 1, engines: 1, cells_charged: 2, cells_cached: 0, internal_cost_cents: 4237 }],
      ["the camelCase spelling", { prompts: 1, engines: 1, cellsCharged: 2, cellsCached: 0 }],
      ["a negative count", { prompts: 1, engines: 1, cells_charged: -2, cells_cached: 0 }],
    ] as const) {
      it(`refuses ${name}`, async () => {
        await expect(write(detail)).rejects.toThrow(/unit_detail does not match its contract/u);
      });
    }

    it("accepts the shape the contract publishes", async () => {
      await expect(write({ prompts: 15, engines: 2, cells_charged: 22, cells_cached: 8 })).resolves.toBeUndefined();
    });
  });

  // ───────────────────────── scenario 2 ─────────────────────────

  describe("scenario 2 — the ledger is append-only, trigger-enforced", () => {
    beforeEach(async () => {
      await provision(600);
    });

    it("rejects an UPDATE", async () => {
      await expect(db.query("UPDATE credit_ledger SET credits = 1 WHERE workspace_id = $1", [workspaceId])).rejects.toThrow(
        /append-only/iu,
      );
    });

    it("rejects a DELETE", async () => {
      await expect(db.query("DELETE FROM credit_ledger WHERE workspace_id = $1", [workspaceId])).rejects.toThrow(
        /append-only/iu,
      );
    });

    it("rejects an UPDATE that changes nothing, so there is no 'harmless' rewrite", async () => {
      await expect(
        db.query("UPDATE credit_ledger SET reason = reason WHERE workspace_id = $1", [workspaceId]),
      ).rejects.toThrow(/append-only/iu);
    });
  });

  // ───────────────────────── scenario 3 ─────────────────────────

  describe("scenario 3 — a correction must carry its reason", () => {
    beforeEach(async () => {
      await provision(600);
    });

    it("refuses an adjustment whose reason is blank, naming the rule rather than the constraint", async () => {
      await expect(
        inTx((tx) => adjustCredits(tx, { ...actor(), actorId: humanId, actorType: "user", reason: "   " }, "included", -10)),
      ).rejects.toThrow(/never silently rewrites a balance/u);
    });

    it("refuses it in the DATABASE too, for the callers that never go through the function", async () => {
      // ⚠ A psql session, a data migration, a future service. The function's
      // signature is the first line of defence and the database is the last.
      await expect(
        db.query(
          `INSERT INTO credit_ledger
             (workspace_id, actor_type, entry_type, credits, bucket, included_after, purchased_after,
              reserved_after, idempotency_key)
           VALUES ($1,'user','adjustment',-10,'included',590,0,0,'manual')`,
          [workspaceId],
        ),
      ).rejects.toThrow(/ck_credit_ledger_adjustment_reason/u);
    });

    it("refuses an adjustment attributed to somebody who does not exist", async () => {
      // ⚠ "HUMAN-AUTHORED" HAS TEETH AT THE DATABASE. `actor_id` carries an
      // FK to `users`, so an adjustment cannot name an invented person any
      // more than it can omit a reason — found by this suite trying exactly
      // that with a random UUID.
      await expect(
        inTx((tx) =>
          adjustCredits(tx, { ...actor(), actorId: randomUUID(), actorType: "user", reason: "plausible" }, "included", -10),
        ),
      ).rejects.toThrow(/credit_ledger_actor_id_fkey/u);
      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 600 });
    });

    it("⚠ refuses a tab, a newline and a non-breaking space as reasons, not just a run of spaces", async () => {
      // ⚠ `btrim(reason) <> \'\'` — the first version of this check — trims
      // the SPACE CHARACTER ALONE. A reason of one tab passed the database
      // while `adjustCredits` rejected it, so the constraint written to
      // backstop the function for psql sessions and data migrations was
      // strictly weaker than the function. The review probed all three and
      // all three were accepted.
      for (const [name, reason] of [
        ["tab", "\t"],
        ["newline", "\n"],
        ["non-breaking space", "\u00a0"],
        ["em space", "\u2003"],
      ] as const) {
        await expect(
          db.query(
            `INSERT INTO credit_ledger
               (workspace_id, actor_type, entry_type, credits, bucket, reason, included_after, purchased_after,
                reserved_after, idempotency_key)
             VALUES ($1,'user','adjustment',-10,'included',$2,590,0,0,$3)`,
            [workspaceId, reason, `blank-${name}`],
          ),
          `a ${name} was accepted as a reason`,
        ).rejects.toThrow(/ck_credit_ledger_adjustment_reason/u);
      }
    });

    it("leaves the balance untouched when the adjustment is refused", async () => {
      await expect(
        inTx((tx) => adjustCredits(tx, { ...actor(), actorId: humanId, actorType: "user", reason: "" }, "included", -10)),
      ).rejects.toThrow();
      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 600 });
    });
  });

  // ───────────────────────── scenario 4 ─────────────────────────

  describe("scenario 4 — a replayed entry is a no-op, not a second charge", () => {
    it("refuses a second reserve under the same key and attempt", async () => {
      await provision(600);
      const key = "same-key";
      const first = await reserveCredits(db, workspaceId, 40);
      expect(
        await appendLedgerEntry(db, {
          workspaceId,
          entryType: "reserve",
          actionCode: "manual_scan",
          credits: 40,
          idempotencyKey: key,
          attempt: 1,
          after: first.wallet!,
          actorId: null,
          actorType: "system",
        }),
      ).toBe(true);

      const second = await reserveCredits(db, workspaceId, 40);
      expect(
        await appendLedgerEntry(db, {
          workspaceId,
          entryType: "reserve",
          actionCode: "manual_scan",
          credits: 40,
          idempotencyKey: key,
          attempt: 1,
          after: second.wallet!,
          actorId: null,
          actorType: "system",
        }),
      ).toBe(false);
    });

    it("rolls the balance back when a redelivered grant finds its entry already recorded", async () => {
      // ⚠ THE SAVEPOINT IS WHAT MAKES THIS SAFE. The wallet statement runs
      // first — replay's ordering invariant requires it — so a redelivery
      // moves the balance before discovering the entry exists, and the
      // movement has to be undone without taking the caller's transaction
      // with it.
      await provision(0);
      const request = { ...actor(), idempotencyKey: "grant:cycle:2026-09" };

      expect((await inTx((tx) => grantCredits(tx, request, 600))).applied).toBe(true);
      expect((await inTx((tx) => grantCredits(tx, request, 600))).applied).toBe(false);

      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 600 });
      expect(await ledgerRows()).toHaveLength(1);
    });

    it("keeps the caller's own transaction alive through the rolled-back redelivery", async () => {
      // A redelivery inside a larger transaction must not poison it. If the
      // savepoint were missing, the conflict would abort everything the
      // caller had already done.
      await provision(0);
      const request = { ...actor(), idempotencyKey: "grant:cycle:2026-09" };
      await inTx((tx) => grantCredits(tx, request, 600));

      await db.query("BEGIN");
      await grantCredits(db, request, 600);
      const survives = await db.query("SELECT 1 AS ok");
      await db.query("COMMIT");

      expect(survives.rows[0]).toEqual({ ok: 1 });
    });
  });

  // ───────────────────────── scenario 5 ─────────────────────────

  describe("scenario 5 — the wallet replays from the ledger exactly", () => {
    it("matches after a full life: grant, purchase, reserve, commit, expire, adjust", async () => {
      await provision(600);
      await inTx((tx) => recordPurchase(tx, actor(), 1000));

      const key = "life";
      const reserved = await reserveCredits(db, workspaceId, 700);
      await appendLedgerEntry(db, {
        workspaceId,
        entryType: "reserve",
        actionCode: "manual_scan",
        credits: 700,
        idempotencyKey: key,
        attempt: 1,
        after: reserved.wallet!,
        actorId: null,
        actorType: "system",
      });
      // Consumes less than it held, and spills across both buckets.
      const committed = await commitCredits(db, workspaceId, 650, 700);
      await appendLedgerEntry(db, {
        workspaceId,
        entryType: "commit",
        actionCode: "manual_scan",
        credits: 650,
        idempotencyKey: key,
        attempt: 1,
        after: committed!,
        actorId: null,
        actorType: "system",
      });

      await inTx((tx) => expireCredits(tx, actor(), "purchased", 100));
      await inTx((tx) => adjustCredits(tx, { ...actor(), actorId: humanId, actorType: "user", reason: "support credit" }, "purchased", 25));

      // 600 included - 600 = 0; 1000 purchased - 50 - 100 + 25 = 875.
      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 0, purchasedBalance: 875, reserved: 0 });
      expect(replayLedger(await readLedgerForReplay(db, workspaceId)).balance).toEqual({
        included: 0,
        purchased: 875,
        reserved: 0,
      });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("reconciles the lifetime totals the real statements maintain, not just the balances", async () => {
      // ⚠ THESE ARE MAINTAINED BY DIFFERENT STATEMENTS than the balances —
      // `lifetime_granted` by the provisioning INSERT, `lifetime_purchased`
      // by `applyBucketDelta`, `lifetime_spent` by `commitCredits` — so the
      // replay's arithmetic agreeing with them is a claim about three
      // separate pieces of SQL, and only a real database can settle it.
      await provision(600);
      await inTx((tx) => recordPurchase(tx, actor(), 1000));

      const reserved = await reserveCredits(db, workspaceId, 40);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: 40,
        idempotencyKey: "spend", attempt: 1, after: reserved.wallet!, actorId: null, actorType: "system",
      });
      const committed = await commitCredits(db, workspaceId, 40, 40);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "commit", actionCode: "manual_scan", credits: 40,
        idempotencyKey: "spend", attempt: 1, after: committed!, actorId: null, actorType: "system",
      });

      expect(await readLifetimeCounters(db, workspaceId)).toEqual({ granted: 600, purchased: 1000, spent: 40 });
      expect(replayLedger(await readLedgerForReplay(db, workspaceId)).lifetime).toEqual({
        granted: 600,
        purchased: 1000,
        spent: 40,
      });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("⚠ counts a mid-cycle grantCredits into lifetime_granted, not just the provisioning one", async () => {
      // ⚠ THE MUTANT THIS CATCHES: `grantCredits` passing `lifetime: null`.
      // The review changed exactly that and all 35 integration and 27 unit
      // tests passed, because the only lifetime coverage went through
      // `provisionWalletWithGrant` and `recordPurchase`. `replayLedger`
      // credits `granted` for EVERY grant row, so the mutant makes the
      // verifier page on every workspace that receives a mid-cycle grant —
      // which is what STORY-075 will call this function for.
      await provision(600);
      await inTx((tx) => grantCredits(tx, actor(), 400));

      expect(await readLifetimeCounters(db, workspaceId)).toMatchObject({ granted: 1000 });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("⚠ counts recordPurchase into lifetime_purchased and not into lifetime_granted", async () => {
      await provision(0);
      await inTx((tx) => recordPurchase(tx, actor(), 250));

      expect(await readLifetimeCounters(db, workspaceId)).toEqual({ granted: 0, purchased: 250, spent: 0 });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("reports a lifetime total that drifted while the balances stayed right", async () => {
      // The shape STORY-072's review produced: the money was gone and
      // `lifetime_spent` said nothing had been spent.
      await provision(600);
      await db.query("UPDATE credit_wallets SET lifetime_granted = 0 WHERE workspace_id = $1", [workspaceId]);

      const mismatch = await verifyWorkspaceWallet(db, workspaceId);
      expect(mismatch?.counter).toEqual({ counter: "granted", wallet: 0, replayed: 600 });
      expect(mismatch?.wallet).toEqual(mismatch?.replayed);
    });

    it("reports a balance that moved with no entry behind it", async () => {
      // Scenario 6's deliberate discrepancy, made the way a real one would
      // be: a statement that touched the wallet and wrote nothing.
      await provision(600);
      await db.query("UPDATE credit_wallets SET included_balance = 640 WHERE workspace_id = $1", [workspaceId]);

      const mismatch = await verifyWorkspaceWallet(db, workspaceId);
      expect(mismatch?.reason).toContain("a movement was made with no entry");
      expect(mismatch?.wallet.included).toBe(640);
      expect(mismatch?.replayed.included).toBe(600);
    });
  });

  // ────────────────── the ordering the replay rests on ──────────────────

  describe("replay order — why `seq` and not `occurred_at`", () => {
    it("orders two racing movements by the wallet lock, not by which transaction began first", async () => {
      // ⚠ THIS IS MIGRATION 0023's ENTIRE JUSTIFICATION, reproduced. `now()`
      // is TRANSACTION START TIME. The late transaction below begins first,
      // takes its timestamp, and only then does the other one run to
      // completion and commit — so ordering by `occurred_at` puts the
      // movements in the opposite order to the one the balance actually
      // moved in, and replay reports a divergence on a wallet that is
      // perfectly correct.
      await provision(600);

      const early = await pool.connect();
      const late = await pool.connect();
      try {
        // `late` opens first and pins the EARLIER `now()`.
        await late.query("BEGIN");
        await late.query("SELECT now()");

        await early.query("BEGIN");
        const a = await reserveCredits(early, workspaceId, 10);
        await appendLedgerEntry(early, {
          workspaceId,
          entryType: "reserve",
          actionCode: "manual_scan",
          credits: 10,
          idempotencyKey: "a",
          attempt: 1,
          after: a.wallet!,
          actorId: null,
          actorType: "system",
        });
        await early.query("COMMIT");

        const b = await reserveCredits(late, workspaceId, 20);
        await appendLedgerEntry(late, {
          workspaceId,
          entryType: "reserve",
          actionCode: "manual_scan",
          credits: 20,
          idempotencyKey: "b",
          attempt: 1,
          after: b.wallet!,
          actorId: null,
          actorType: "system",
        });
        await late.query("COMMIT");
      } finally {
        early.release();
        late.release();
      }

      const bySeq = await db.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM credit_ledger WHERE entry_type = 'reserve' ORDER BY seq ASC",
      );
      const byTime = await db.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM credit_ledger WHERE entry_type = 'reserve' ORDER BY occurred_at ASC, seq ASC",
      );

      // The two orders genuinely disagree — otherwise this test proves
      // nothing about why `seq` exists.
      expect(bySeq.rows.map((r) => r.idempotency_key)).toEqual(["a", "b"]);
      expect(byTime.rows.map((r) => r.idempotency_key)).toEqual(["b", "a"]);

      // And `seq` is the order that replays cleanly.
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });
  });

  // ─────────────────────── scenarios 8 and 9 ───────────────────────

  describe("scenarios 8 and 9 — the orphan reconciler", () => {
    async function orphan(key: string, credits: number): Promise<void> {
      const reserved = await reserveCredits(db, workspaceId, credits);
      await appendLedgerEntry(db, {
        workspaceId,
        entryType: "reserve",
        actionCode: "manual_scan",
        credits,
        idempotencyKey: key,
        attempt: 1,
        after: reserved.wallet!,
        actorId: null,
        actorType: "system",
      });
    }

    beforeEach(async () => {
      await provision(600);
    });

    it("releases a reservation that was never settled, and says how much it handed back", async () => {
      await orphan("dead-pod", 40);
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 40, available: 560 });

      const outcome = await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });

      expect(outcome).toMatchObject({ found: 1, released: 1, credits: 40, failures: [] });
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, available: 600 });
    });

    it("writes the release into the ledger under the reservation's own key", async () => {
      await orphan("dead-pod", 40);
      await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });

      const release = await db.query<{ idempotency_key: string; attempt: number; reference_type: string; reserved_after: number }>(
        "SELECT idempotency_key, attempt, reference_type, reserved_after FROM credit_ledger WHERE entry_type = 'release'",
      );
      expect(release.rows).toEqual([
        { idempotency_key: "dead-pod", attempt: 1, reference_type: "credit_reconciler", reserved_after: 0 },
      ]);
    });

    it("scenario 9 — running twice releases once", async () => {
      await orphan("dead-pod", 40);

      const first = await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });
      const second = await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });

      expect(first.released).toBe(1);
      // The second run's DISCOVERY excludes it, so this pass never reaches the
      // conflict path at all — which is why the overlapping test below exists.
      expect(second).toMatchObject({ found: 0, released: 0, credits: 0 });
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, available: 600 });
      const releases = await db.query("SELECT 1 FROM credit_ledger WHERE entry_type = 'release'");
      expect(releases.rowCount).toBe(1);
    });

    it("⚠ scenario 9, properly — two OVERLAPPING runs release once and do not eat a live hold", async () => {
      // ⚠ THE SEQUENTIAL VERSION ABOVE DOES NOT TEST THE INVARIANT IT NAMES,
      // and the second-engineer review proved it by reproducing the failure
      // the test was supposed to forbid. Run two, discovery finds nothing, so
      // the conflict path is never entered. Two runs that both DISCOVER the
      // orphan — the hand-run script racing the queued job, or two cron ticks
      // — used to produce:
      //
      //   before: reserved 90   (orphan-A 40 + LIVE live-B 50)
      //   run A:  released 1
      //   run B:  released 0, reported clean — and committed its own
      //           `GREATEST(reserved - 40, 0)` anyway, because the refused
      //           ledger entry was returned as a boolean and ignored
      //   after : reserved 10   <-- 40 credits of live-B's hold destroyed
      //
      // Both runs take their snapshot BEFORE either releases, which is what
      // makes this the real concurrency case.
      await orphan("dead-pod", 40);
      await orphan("live-hold", 50);
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 90 });

      // Two independent scans of the same state, settled one after the other.
      const scan = async (): Promise<ReconcileOutcome> =>
        reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });
      const [a, b] = await Promise.all([scan(), scan()]);

      // Between them: each orphan released exactly once, whichever run won.
      expect(a.released + b.released).toBe(2);
      expect(a.alreadySettled + b.alreadySettled).toBe(a.found + b.found - 2);
      expect(a.credits + b.credits).toBe(90);
      expect([...a.failures, ...b.failures]).toEqual([]);

      // And the wallet is whole — not 90 minus a double release.
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, available: 600 });
      const releases = await db.query("SELECT 1 FROM credit_ledger WHERE entry_type = 'release'");
      expect(releases.rowCount).toBe(2);
    });

    it("⚠ discovery SEES THE ROWS on the runtime role production actually uses", async () => {
      // ⚠ EVERY OTHER TEST IN THIS FILE RUNS AS THE CONTAINER SUPERUSER,
      // WHICH BYPASSES RLS. `credit_ledger` carries FORCE ROW LEVEL SECURITY
      // and the reconciler's scan is cross-tenant by necessity, so on
      // `nominara_app` with no tenant context it returns ZERO ROWS — and
      // `found: 0` is indistinguishable from "there are no orphans". Both
      // production entry points built their pool from `DATABASE_URL_POOLED`,
      // which is that role. The second-engineer review reproduced it:
      //
      //   superuser:     found 2, released 2
      //   nominara_app:  found 0, released 0, "failures": []
      //
      // Discovery now runs on the privileged connection. This test is the one
      // that fails if anyone points it back at the pool.
      await orphan("dead-pod", 40);

      expect(await openReservations(appClient, 0)).toEqual([]);
      expect(await openReservations(db, 0)).toHaveLength(1);

      // ⚠ `work` IS THE APP-ROLE POOL, which is the whole point of the test.
      // Every other reconciler test here passes the superuser pool for both
      // halves, so pointing discovery back at `work` changes nothing and the
      // regression walks straight through. With the real runtime role on
      // `work`, a discovery that reads from it sees zero rows and this fails.
      const outcome = await reconcileOrphanedReservations({ discovery: db, work: appPool }, { graceMs: 0 });

      expect(outcome).toMatchObject({ found: 1, released: 1, credits: 40, failures: [] });
      // And the write half genuinely worked under the runtime role: RLS
      // scoped by `withTenantContext`, INSERT on a table it may only append to.
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, available: 600 });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("leaves a reservation younger than the grace period alone", async () => {
      // ⚠ TOO SHORT A GRACE AND THE RECONCILER RACES THE REQUEST IT IS
      // RECONCILING — releasing a hold on an action still running, which then
      // commits against a reservation that is no longer there.
      await orphan("in-flight", 40);

      const outcome = await reconcileOrphanedReservations({ discovery: db, work: pool });

      expect(outcome).toMatchObject({ found: 0, released: 0 });
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 40 });
      expect(ORPHAN_GRACE_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
    });

    it("ignores a reservation that was properly committed", async () => {
      const settled = await reserveCredits(db, workspaceId, 40);
      await appendLedgerEntry(db, {
        workspaceId,
        entryType: "reserve",
        actionCode: "manual_scan",
        credits: 40,
        idempotencyKey: "settled",
        attempt: 1,
        after: settled.wallet!,
        actorId: null,
        actorType: "system",
      });
      const committed = await commitCredits(db, workspaceId, 40, 40);
      await appendLedgerEntry(db, {
        workspaceId,
        entryType: "commit",
        actionCode: "manual_scan",
        credits: 40,
        idempotencyKey: "settled",
        attempt: 1,
        after: committed!,
        actorId: null,
        actorType: "system",
      });

      expect(await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 })).toMatchObject({ found: 0 });
    });

    it("releases the open attempt and leaves a settled earlier attempt of the same key alone", async () => {
      // A retry family: attempt 1 was released, attempt 2 died mid-flight.
      const one = await reserveCredits(db, workspaceId, 40);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: 40,
        idempotencyKey: "retried", attempt: 1, after: one.wallet!, actorId: null, actorType: "system",
      });
      const releasedWallet = await readWallet(db, workspaceId);
      await db.query("UPDATE credit_wallets SET reserved = 0 WHERE workspace_id = $1", [workspaceId]);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "release", actionCode: "manual_scan", credits: 40,
        idempotencyKey: "retried", attempt: 1,
        after: { ...releasedWallet!, reserved: 0, available: releasedWallet!.available + 40 },
        actorId: null, actorType: "system",
      });
      const two = await reserveCredits(db, workspaceId, 40);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: 40,
        idempotencyKey: "retried", attempt: 2, after: two.wallet!, actorId: null, actorType: "system",
      });

      const outcome = await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });

      expect(outcome).toMatchObject({ found: 1, released: 1, credits: 40 });
      const releases = await db.query<{ attempt: number }>(
        "SELECT attempt FROM credit_ledger WHERE entry_type = 'release' ORDER BY attempt ASC",
      );
      expect(releases.rows.map((r) => r.attempt)).toEqual([1, 2]);
    });

    it("reconciles across workspaces and reports each failure without abandoning the run", async () => {
      // ⚠ ONE TRANSACTION PER RESERVATION. A single transaction across the
      // estate would let one unreleasable orphan roll back every release that
      // had already succeeded, keeping everything un-reconciled indefinitely.
      const other = randomUUID();
      await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'O',$2,'growth')", [
        other,
        `o-${randomUUID().slice(0, 8)}`,
      ]);
      await orphan("first", 40);

      // A reservation whose wallet does not exist: the release has no
      // after-state to record, so it fails — and must not stop the other one.
      await db.query(
        `INSERT INTO credit_ledger
           (workspace_id, actor_type, entry_type, action_code, credits, included_after, purchased_after,
            reserved_after, idempotency_key)
         VALUES ($1,'system','reserve','manual_scan',10,0,0,10,'walletless')`,
        [other],
      );

      const outcome = await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });

      expect(outcome.found).toBe(2);
      expect(outcome.released).toBe(1);
      expect(outcome.failures).toHaveLength(1);
      expect(outcome.failures[0]?.workspaceId).toBe(other);
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0 });
    });
  });

  // ───────────── the seam between the reconciler and settlement ─────────────

  describe("a swept reservation cannot be charged", () => {
    beforeEach(async () => {
      await provision(600);
    });

    it("⚠ refuses a release that a commit already closed, rather than releasing twice", async () => {
      const held = await reserveCredits(db, workspaceId, 40);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: 40,
        idempotencyKey: "settled-then-swept", attempt: 1, after: held.wallet!, actorId: null, actorType: "system",
      });
      const committed = await commitCredits(db, workspaceId, 40, 40);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "commit", actionCode: "manual_scan", credits: 40,
        idempotencyKey: "settled-then-swept", attempt: 1, after: committed!, actorId: null, actorType: "system",
      });

      // A reconciler that had already snapshotted this reservation as open.
      const outcome = await inTx((tx) =>
        releaseReservation(tx, {
          workspaceId,
          idempotencyKey: "settled-then-swept",
          attempt: 1,
          credits: 40,
          actionCode: "manual_scan",
        }),
      );

      expect(outcome).toBe("already_settled");
      expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 560, reserved: 0 });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("⚠ leaves an unrelated live hold untouched when the swept one is released", async () => {
      // The shape the review reproduced: `commitCredits` tests the
      // workspace's AGGREGATE `reserved`, so a commit against a swept
      // reservation succeeds by eating whatever hold happens to be there.
      // `releaseReservation` is what keeps the two from being confused.
      const a = await reserveCredits(db, workspaceId, 40);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: 40,
        idempotencyKey: "slow-A", attempt: 1, after: a.wallet!, actorId: null, actorType: "system",
      });
      const b = await reserveCredits(db, workspaceId, 50);
      await appendLedgerEntry(db, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: 50,
        idempotencyKey: "live-B", attempt: 1, after: b.wallet!, actorId: null, actorType: "system",
      });

      // A sweeps. B's hold must survive it, and a second sweep of A must not
      // take a bite out of B.
      await reconcileOrphanedReservations({ discovery: db, work: pool }, { graceMs: 0 });
      const settled = await inTx((tx) =>
        releaseReservation(tx, {
          workspaceId, idempotencyKey: "slow-A", attempt: 1, credits: 40, actionCode: "manual_scan",
        }),
      );

      expect(settled).toBe("already_settled");
      // B was the only other orphan, so the sweep released it too — the point
      // is that the total handed back is 90 and not 130.
      expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, available: 600 });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("refuses to release against a workspace whose wallet is gone, rather than inventing an after-state", async () => {
      await appendLedgerEntry(db, {
        workspaceId, entryType: "reserve", actionCode: "manual_scan", credits: 10,
        idempotencyKey: "walletless", attempt: 1,
        after: { includedBalance: 0, purchasedBalance: 0, reserved: 10, available: -10, cycleEnd: "2026-10-01" },
        actorId: null, actorType: "system",
      });
      await db.query("DELETE FROM credit_wallets WHERE workspace_id = $1", [workspaceId]);

      await expect(
        inTx((tx) =>
          releaseReservation(tx, {
            workspaceId, idempotencyKey: "walletless", attempt: 1, credits: 10, actionCode: "manual_scan",
          }),
        ),
      ).rejects.toThrow(ReservationSettlementError);
    });
  });

  // ───────────────────────── scenario 14 ─────────────────────────

  describe("scenario 14 — expiry is explicable", () => {
    it("writes an entry for expiring purchased credits, so the drop has a cause", async () => {
      await provision(0);
      await inTx((tx) => recordPurchase(tx, actor(), 1000));
      await inTx((tx) => expireCredits(tx, { ...actor(), idempotencyKey: "expire:2027-09-16" }, "purchased", 1000));

      expect(await readWallet(db, workspaceId)).toMatchObject({ purchasedBalance: 0 });
      expect((await ledgerRows()).at(-1)).toMatchObject({ entry_type: "expire", credits: 1000, bucket: "purchased", purchased_after: 0 });
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("⚠ leaves the caller's transaction USABLE when a balance operation is refused", async () => {
      // ⚠ THE SAVEPOINT WAS ONLY ROLLED BACK ON THE REDELIVERY PATH. A
      // constraint violation propagated with it still open, so the caller's
      // transaction was ABORTED and every later statement failed with
      // "current transaction is aborted" — the opposite of what
      // `applyBalanceEntry`'s own comment promised. Every other test here
      // missed it because `inTx` rolls the whole transaction back anyway.
      await provision(0);
      await inTx((tx) => recordPurchase(tx, actor(), 100));
      await reserveCredits(db, workspaceId, 100);

      await db.query("BEGIN");
      try {
        await db.query("CREATE TEMP TABLE caller_work (n int)");
        await db.query("INSERT INTO caller_work VALUES (1)");

        await expect(expireCredits(db, actor(), "purchased", 100)).rejects.toThrow(/ck_wallet_reserved/u);

        // The caller's own work is still there and the transaction still commits.
        const survived = await db.query<{ n: number }>("SELECT n FROM caller_work");
        expect(survived.rows).toEqual([{ n: 1 }]);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    });

    it("refuses to expire credits that are currently reserved rather than driving the wallet negative", async () => {
      // `ck_wallet_reserved` is the arbiter. Expiring out from under a live
      // hold would leave `reserved` above the balance that backs it.
      await provision(0);
      await inTx((tx) => recordPurchase(tx, actor(), 100));
      await reserveCredits(db, workspaceId, 100);

      await expect(inTx((tx) => expireCredits(tx, actor(), "purchased", 100))).rejects.toThrow(/ck_wallet_reserved/u);
    });
  });

  // ───────────────── migration 0023's own constraints ─────────────────

  describe("migration 0023 — what the table now refuses", () => {
    beforeEach(async () => {
      await provision(600);
    });

    async function insert(columns: string, values: string): Promise<unknown> {
      return db.query(
        `INSERT INTO credit_ledger
           (workspace_id, actor_type, included_after, purchased_after, reserved_after, idempotency_key, ${columns})
         VALUES ($1,'system',600,0,0,'x',${values})`,
        [workspaceId],
      );
    }

    it("refuses a zero-magnitude grant, because nothing moved", async () => {
      await expect(insert("entry_type, credits, bucket", "'grant',0,'included'")).rejects.toThrow(
        /ck_credit_ledger_credits_sign/u,
      );
    });

    it("refuses a negative grant, because direction is the type's to say", async () => {
      await expect(insert("entry_type, credits, bucket", "'grant',-5,'included'")).rejects.toThrow(
        /ck_credit_ledger_credits_sign/u,
      );
    });

    it("refuses an adjustment of zero, which would explain nothing", async () => {
      await expect(insert("entry_type, credits, bucket, reason", "'adjustment',0,'included','why'")).rejects.toThrow(
        /ck_credit_ledger_credits_sign/u,
      );
    });

    it("permits a commit of zero, which is an action that consumed nothing", async () => {
      await expect(insert("entry_type, credits", "'commit',0")).resolves.toBeDefined();
    });

    it("refuses a balance entry that does not name its bucket", async () => {
      await expect(insert("entry_type, credits", "'purchase',100")).rejects.toThrow(/ck_credit_ledger_bucket_scope/u);
    });

    it("still lets a reservation omit the bucket, because it does not move one", async () => {
      await expect(insert("entry_type, credits", "'reserve',10")).resolves.toBeDefined();
    });

    it("⚠ refuses a bucket ON a reservation, so the column is never decorative", async () => {
      // The first version of this constraint was an implication, not a
      // biconditional: it required a bucket where one is needed and still
      // accepted one where it means nothing. `replayLedger` ignores it on
      // these three, so a `commit` row could claim the money came out of
      // `purchased` when the statement drew from `included` — invisible to
      // replay, and visible to anyone reading the ledger.
      for (const entryType of ["reserve", "commit", "release"]) {
        await expect(
          insert("entry_type, credits, bucket", `'${entryType}',10,'purchased'`),
          `${entryType} accepted a bucket`,
        ).rejects.toThrow(/ck_credit_ledger_bucket_scope/u);
      }
    });
  });
});

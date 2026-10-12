import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { adjustCredits, provisionWalletWithGrant, recordPurchase } from "../../src/lib/credits/balance.js";
import { expireDuePurchasedCredits } from "../../src/lib/credits/expire.js";
import { readLedgerForReplay, replayLedger, verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { commitCredits, readWallet, reserveCredits } from "../../src/lib/credits/wallet.js";
import { createCreditHousekeepingHandler } from "../../src/lib/queue/handlers/credit-housekeeping.handler.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import type { Job } from "bullmq";

// STORY-076 AC4 / STORY-073 AC12 — "Purchased rollover: 12 months from purchase, FIFO by expiry. Expiry writes an
// `expire` ledger entry." `expireCredits` existed, with tests, and nothing called it: a purchased credit never
// expired. This is the sweep that decides HOW MANY to expire per workspace, so the interesting cases are the
// accounting ones — credits are one fungible balance, lots are spent oldest-first, and an expiry must never destroy
// a credit the customer still holds under a lot that has NOT expired.
//
// Real SQL as `nominara_app` for the writes (RLS in force) and the owner role for discovery, which is how the
// worker runs it. The ledger is a dangerous area: the replay verifier must stay clean after every sweep.
describe("STORY-076 AC4 · expireDuePurchasedCredits", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let discovery: Client;
  let work: Pool;
  let workspaceId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    discovery = new Client({ connectionString: container.getConnectionUri() });
    await discovery.connect();
    work = new Pool({
      host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(),
      user: "nominara_app", password: resolvePassword("nominara_app", {}), max: 4,
    });
  }, 300_000);

  afterAll(async () => {
    await work.end();
    await discovery.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, credit_wallets, credit_purchases, workspaces, users CASCADE");
    workspaceId = await newWorkspace();
  });

  async function newWorkspace(): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [id, `w-${randomUUID().slice(0, 8)}`]);
    return id;
  }

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

  const request = (ws: string, key: string) => ({ workspaceId: ws, idempotencyKey: key, actorId: null, actorType: "system" as const });

  async function provision(ws: string, included = 0): Promise<void> {
    await inTx((tx) => provisionWalletWithGrant(tx, ws, included, { start: "2026-09-01", end: "2026-10-01" }));
  }

  /** A succeeded lot, credited to the wallet the way the Stripe handler does. `expiresIn` is a Postgres interval or null. */
  async function lot(ws: string, credits: number, expiresIn: string | null, status = "succeeded"): Promise<string> {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, status, expires_at)
       VALUES ($1,'starter_vault',$2,15.00,$3, CASE WHEN $4::text IS NULL THEN NULL ELSE now() + $4::interval END)
       RETURNING id`,
      [ws, credits, status, expiresIn],
    );
    if (status === "succeeded") await inTx((tx) => recordPurchase(tx, request(ws, `purchase-${randomUUID()}`), credits));
    return inserted.rows[0]!.id;
  }

  /** A human-authored credit into the purchased bucket with NO lot behind it (support goodwill). */
  async function goodwill(ws: string, credits: number): Promise<void> {
    const human = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID().slice(0, 8)}@nominara.test`])).rows[0]!.id;
    await inTx((tx) => adjustCredits(tx, { ...request(ws, `goodwill-${randomUUID()}`), actorId: human, actorType: "user", reason: "goodwill" }, "purchased", credits));
  }

  /** Spends from the purchased bucket — a debit the lot accounting must treat as FIFO consumption. */
  async function spendPurchased(ws: string, credits: number): Promise<void> {
    const human = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID().slice(0, 8)}@nominara.test`])).rows[0]!.id;
    await inTx((tx) => adjustCredits(tx, { ...request(ws, `spend-${randomUUID()}`), actorId: human, actorType: "user", reason: "test spend" }, "purchased", -credits));
  }

  const sweep = () => expireDuePurchasedCredits({ discovery, work });
  const purchased = async (ws = workspaceId) => (await readWallet(db, ws))!.purchasedBalance;
  const expireEntries = async (ws = workspaceId) =>
    (await db.query<{ credits: number; bucket: string; idempotency_key: string }>(
      "SELECT credits, bucket, idempotency_key FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'expire' ORDER BY seq", [ws])).rows;

  it("[AC4] expires an elapsed lot in full, writes ONE expire entry on the purchased bucket, and the replay stays clean", async () => {
    await provision(workspaceId, 600);
    await lot(workspaceId, 1000, "-1 second");
    const outcome = await sweep();
    expect(outcome).toMatchObject({ workspacesExpired: 1, creditsExpired: 1000, failures: [] });
    expect(await purchased()).toBe(0);
    expect(await expireEntries()).toEqual([expect.objectContaining({ credits: 1000, bucket: "purchased" })]);
    expect(replayLedger(await readLedgerForReplay(db, workspaceId)).divergence).toBeNull();
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    expect((await readWallet(db, workspaceId))!.includedBalance).toBe(600); // the expiring bucket is not this job's
  });

  it("[AC4] leaves a lot that has not yet elapsed untouched — a second before expiry is not expired", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 1000, "1 hour");
    expect(await sweep()).toMatchObject({ workspacesChecked: 0, workspacesExpired: 0, creditsExpired: 0 });
    expect(await purchased()).toBe(1000);
    expect(await expireEntries()).toEqual([]);
  });

  it("[AC4] a lot with NO expires_at (a sales grant) never expires", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 400, null);
    expect(await sweep()).toMatchObject({ creditsExpired: 0 });
    expect(await purchased()).toBe(400);
  });

  it("[AC4] counts only SUCCEEDED lots — a pending, failed or refunded purchase moved no credits and expires none", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 500, "-1 day", "pending");
    await lot(workspaceId, 500, "-1 day", "failed");
    await lot(workspaceId, 500, "-1 day", "refunded");
    expect(await sweep()).toMatchObject({ creditsExpired: 0, failures: [] });
  });

  it("[AC4] a pending or failed lot beside a succeeded one never inflates what expires — only succeeded lots are lots", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 day"); // succeeded, elapsed
    await lot(workspaceId, 500, "6 months"); // succeeded, live
    await lot(workspaceId, 400, "-1 day", "pending"); // moved no credits
    await lot(workspaceId, 300, "-1 day", "failed");
    // A LIVE unsucceeded lot too: counted into the total it would read as credits already consumed, and starve the expiry.
    await lot(workspaceId, 700, "6 months", "pending");
    expect(await purchased()).toBe(600);
    expect(await sweep()).toMatchObject({ creditsExpired: 100 }); // not 500, not 800
    expect(await purchased()).toBe(500);
  });

  it("[AC4] reads the balance UNDER the wallet row lock: a spend that commits while the sweep waits is seen, not overwritten", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 1000, "-1 second"); // P = 1000, one elapsed lot
    const human = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID().slice(0, 8)}@nominara.test`])).rows[0]!.id;
    const holder = await secondDiscovery();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE", [workspaceId]); // hold the wallet
      let done = false;
      const running = sweep().then((outcome) => { done = true; return outcome; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done, "the sweep must be waiting on the wallet row lock").toBe(false);
      // The holder spends 600 from the purchased bucket, then releases the lock.
      await adjustCredits(holder, { ...request(workspaceId, `spend-${randomUUID()}`), actorId: human, actorType: "user", reason: "test spend" }, "purchased", -600);
      await holder.query("COMMIT");
      const outcome = await running;
      // 600 of the lot was consumed first-in-first-out; the sweep must expire the 400 left, not the 1000 it saw before the lock.
      expect(outcome).toMatchObject({ creditsExpired: 400, failures: [] });
      expect(await purchased()).toBe(0);
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    } finally {
      await holder.end();
    }
  });

  it("[AC4] FIFO — credits spent from the purchased bucket were the OLDEST lot's, so a spent expired lot expires nothing", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 day"); // oldest, elapsed
    await lot(workspaceId, 500, "6 months");
    await spendPurchased(workspaceId, 150); // 100 from the elapsed lot, 50 from the live one
    expect(await purchased()).toBe(450);
    expect(await sweep()).toMatchObject({ creditsExpired: 0 });
    expect(await purchased()).toBe(450); // the customer's 450 are all live-lot credits
  });

  it("[AC4] FIFO — a PARTLY spent elapsed lot expires only what is left of it", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 day");
    await lot(workspaceId, 500, "6 months");
    await spendPurchased(workspaceId, 30);
    expect(await sweep()).toMatchObject({ creditsExpired: 70 });
    expect(await purchased()).toBe(500);
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  it("[AC4] never expires more than the purchased balance holds, even when the elapsed lots sum higher", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-2 days");
    await lot(workspaceId, 100, "-1 day");
    await spendPurchased(workspaceId, 150); // consumed FIFO: first lot gone, second half gone
    expect(await purchased()).toBe(50);
    expect(await sweep()).toMatchObject({ creditsExpired: 50 });
    expect(await purchased()).toBe(0);
  });

  it("[AC4] is IDEMPOTENT — a second sweep, a redelivered job, expires nothing more", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 1000, "-1 second");
    await sweep();
    expect(await sweep()).toMatchObject({ workspacesExpired: 0, creditsExpired: 0 });
    expect((await expireEntries()).length).toBe(1);
    expect(await purchased()).toBe(0);
  });

  it("[AC4] two OVERLAPPING sweeps expire once — the wallet row lock serialises them", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 1000, "-1 second");
    const second = await secondDiscovery();
    try {
      const [a, b] = await Promise.all([sweep(), expireDuePurchasedCredits({ discovery: second, work })]);
      expect(a.creditsExpired + b.creditsExpired).toBe(1000);
      expect([...a.failures, ...b.failures]).toEqual([]); // the loser recomputes to zero; it does not fail on the constraint
    } finally {
      await second.end(); // an un-ended client is terminated when the container stops, and vitest fails the run on it
    }
    expect((await expireEntries()).length).toBe(1);
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  async function secondDiscovery(): Promise<Client> {
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    return client;
  }

  it("[AC4] holds back credits a live reservation depends on: ck_wallet_reserved is never violated", async () => {
    await provision(workspaceId, 0);
    await lot(workspaceId, 100, "-1 day");
    // A reservation of 60 against a wallet of 100 purchased + 0 included: expiring all 100 would leave reserved 60 > 0.
    await db.query("UPDATE credit_wallets SET reserved = 60 WHERE workspace_id = $1", [workspaceId]);
    const outcome = await sweep();
    expect(outcome.failures).toEqual([]);
    expect(outcome.creditsExpired).toBe(40); // included + purchased - reserved = 40 is the most that can leave
    expect(await purchased()).toBe(60);
  });

  it("[AC4] workspaces are independent — one's lots never expire another's credits", async () => {
    const other = await newWorkspace();
    await provision(workspaceId);
    await provision(other);
    await lot(workspaceId, 1000, "-1 second");
    await lot(other, 700, "9 months");
    expect(await sweep()).toMatchObject({ workspacesExpired: 1, creditsExpired: 1000 });
    expect(await purchased(other)).toBe(700);
    expect(await expireEntries(other)).toEqual([]);
  });

  it("[AC4] a workspace whose expiry fails is reported and does not stop the others", async () => {
    const broken = await newWorkspace(); // an elapsed lot and NO wallet row: nothing to take credits from
    await db.query(
      "INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, status, expires_at) VALUES ($1,'starter_vault',50,15.00,'succeeded', now() - interval '1 day')",
      [broken],
    );
    await provision(workspaceId);
    await lot(workspaceId, 1000, "-1 second");
    const outcome = await sweep();
    expect(outcome.creditsExpired).toBe(1000);
    expect(outcome.failures.map((failure) => failure.workspaceId)).toEqual([broken]);
  });

  it("[AC4] a workspace with no elapsed lot costs nothing: no workspace is opened, no entry written", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 1000, "11 months");
    expect(await sweep()).toEqual({ workspacesChecked: 0, workspacesExpired: 0, creditsExpired: 0, failures: [] });
  });

  it("[AC4] credits that enter the purchased bucket WITHOUT a lot (a positive adjustment) are never expired as an elapsed lot", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 day");
    await spendPurchased(workspaceId, 100); // the whole elapsed lot is gone
    await goodwill(workspaceId, 100); // support credits 100 into the purchased bucket, no lot
    expect(await purchased()).toBe(100);
    expect(await sweep()).toMatchObject({ creditsExpired: 0, failures: [] });
    expect(await purchased()).toBe(100);
    expect(await expireEntries()).toEqual([]);
  });

  it("[AC4] a positive adjustment beside an elapsed lot: only the lot expires, the adjustment stays", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 day");
    await goodwill(workspaceId, 50);
    expect(await sweep()).toMatchObject({ creditsExpired: 100 });
    expect(await purchased()).toBe(50);
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  it("[AC4] a NEGATIVE adjustment is still FIFO consumption of the oldest lot", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 day");
    await goodwill(workspaceId, 40);
    await spendPurchased(workspaceId, 100); // takes the oldest 100 (the elapsed lot), leaves the 40 adjusted credits
    expect(await sweep()).toMatchObject({ creditsExpired: 0 });
    expect(await purchased()).toBe(40);
  });

  it("[STORY-076 test-plan 4] two lots elapsing on DIFFERENT sweeps, equal in size, produce two expire entries", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 day");
    expect(await sweep()).toMatchObject({ creditsExpired: 100 });
    await lot(workspaceId, 100, "-1 hour"); // the next lot to elapse is the same size
    expect(await sweep()).toMatchObject({ creditsExpired: 100, failures: [] });
    const entries = await expireEntries();
    expect(entries.map((entry) => entry.credits)).toEqual([100, 100]);
    expect(new Set(entries.map((entry) => entry.idempotency_key)).size).toBe(2);
    expect(await purchased()).toBe(0);
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  it("[AC4] a same-day second sweep after a hold is released expires the remainder (equal amounts must not collide)", async () => {
    await provision(workspaceId, 0);
    await lot(workspaceId, 100, "-1 day");
    await db.query("UPDATE credit_wallets SET reserved = 50 WHERE workspace_id = $1", [workspaceId]);
    expect(await sweep()).toMatchObject({ creditsExpired: 50 });
    await db.query("UPDATE credit_wallets SET reserved = 0 WHERE workspace_id = $1", [workspaceId]); // the hold is released
    expect(await sweep()).toMatchObject({ creditsExpired: 50, failures: [] }); // the same amount as the first
    expect(await purchased()).toBe(0);
    expect((await expireEntries()).length).toBe(2);
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  it("[AC4] the elapsed boundary is NOW: a lot expiring in an hour is not expired beside an elapsed one", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 minute");
    await lot(workspaceId, 200, "1 hour");
    expect(await sweep()).toMatchObject({ creditsExpired: 100 });
    expect(await purchased()).toBe(200);
  });

  it("[AC4] the expire entry names the lot it covers (the newest elapsed lot)", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-2 days");
    const newest = await lot(workspaceId, 100, "-1 day");
    await lot(workspaceId, 100, "6 months");
    await sweep();
    const entry = await db.query<{ reference_type: string; reference_id: string }>(
      "SELECT reference_type, reference_id FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'expire'", [workspaceId]);
    expect(entry.rows).toEqual([{ reference_type: "credit_purchase", reference_id: newest }]);
  });

  it("[AC4] discovery skips a workspace whose purchased balance is already empty — an old elapsed lot is not reopened forever", async () => {
    await provision(workspaceId);
    await lot(workspaceId, 100, "-1 day");
    await spendPurchased(workspaceId, 100);
    expect(await sweep()).toEqual({ workspacesChecked: 0, workspacesExpired: 0, creditsExpired: 0, failures: [] });
  });

  it("[AC4] the real reserve/commit path (included first) leaves the elapsed purchased lot to expire in full", async () => {
    await provision(workspaceId, 50);
    await lot(workspaceId, 100, "-1 day");
    await inTx(async (tx) => {
      expect((await reserveCredits(tx, workspaceId, 30)).ok).toBe(true);
      expect(await commitCredits(tx, workspaceId, 30, 30)).not.toBeNull(); // 30 of the 50 included; purchased untouched
    });
    expect(await sweep()).toMatchObject({ creditsExpired: 100, failures: [] });
    const wallet = (await readWallet(db, workspaceId))!;
    expect(wallet).toMatchObject({ includedBalance: 20, purchasedBalance: 0, reserved: 0 });
  });

  it("[AC4] the real path under a LIVE reservation: the sweep holds back what the hold needs, and a later commit spends the rest", async () => {
    await provision(workspaceId, 50);
    await lot(workspaceId, 100, "-1 day");
    await inTx(async (tx) => { expect((await reserveCredits(tx, workspaceId, 120)).ok).toBe(true); });
    expect(await sweep()).toMatchObject({ creditsExpired: 30, failures: [] }); // available = 150 - 120
    await inTx(async (tx) => { expect(await commitCredits(tx, workspaceId, 120, 120)).not.toBeNull(); }); // 50 included + 70 purchased
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 0, purchasedBalance: 0, reserved: 0 });
    expect(await sweep()).toMatchObject({ creditsExpired: 0 });
  });

  it("[AC4] a sweep racing a reserve+commit on the same wallet: nothing is lost or double counted, whichever wins", async () => {
    for (let round = 0; round < 6; round += 1) {
      const ws = await newWorkspace();
      await provision(ws, 0);
      await lot(ws, 100, "-1 day");
      const spender = await secondDiscovery();
      try {
        const spend = (async (): Promise<boolean> => {
          await spender.query("BEGIN");
          const reserved = (await reserveCredits(spender, ws, 60)).ok;
          if (reserved) await commitCredits(spender, ws, 60, 60);
          await spender.query("COMMIT");
          return reserved;
        })();
        const [spent, outcome] = await Promise.all([spend, sweep()]);
        expect(outcome.failures).toEqual([]);
        const expired = (await expireEntries(ws)).reduce((sum, entry) => sum + entry.credits, 0);
        expect(await purchased(ws)).toBe(0);
        expect(expired + (spent ? 60 : 0)).toBe(100);
      } finally {
        await spender.end();
      }
    }
  });

  it("[AC4] a sweep that waits on a held wallet lock sees the reserve+commit that committed meanwhile", async () => {
    await provision(workspaceId, 0);
    await lot(workspaceId, 100, "-1 second");
    const holder = await secondDiscovery();
    try {
      await holder.query("BEGIN");
      expect((await reserveCredits(holder, workspaceId, 60)).ok).toBe(true); // row lock held by the UPDATE
      let done = false;
      const running = sweep().then((outcome) => { done = true; return outcome; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done, "the sweep must be waiting on the wallet row lock").toBe(false);
      await commitCredits(holder, workspaceId, 60, 60);
      await holder.query("COMMIT");
      expect(await running).toMatchObject({ creditsExpired: 40, failures: [] });
      expect(await purchased()).toBe(0);
    } finally {
      await holder.end();
    }
  });

  // The handler on a real database: the owner connection for discovery, the runtime pool for the writes, the lock, and
  // the daily-counter purge — the other half of what `credit.housekeeping` was added to call.
  describe("credit.housekeeping handler — real SQL", () => {
    const tick = { data: {} } as unknown as Job;
    const handler = () =>
      createCreditHousekeepingHandler({ pool: work, env: { DATABASE_URL: container.getConnectionUri() } } as unknown as QueueHandlerContext)({} as never, tick);

    it("[STORY-076 AC4] expires an elapsed lot end to end through the handler, as the worker runs it", async () => {
      await provision(workspaceId);
      await lot(workspaceId, 1000, "-1 second");
      await handler();
      expect(await purchased()).toBe(0);
      expect((await expireEntries()).length).toBe(1);
      expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
    });

    it("[STORY-071 AC10] purges daily counters past the retention window and keeps the rest", async () => {
      await db.query(
        `INSERT INTO credit_daily_counters (workspace_id, utc_date, action_code, used_count, limit_count) VALUES
           ($1, (now() AT TIME ZONE 'UTC')::date - 40, 'lookup', 3, 10),
           ($1, (now() AT TIME ZONE 'UTC')::date - 34, 'lookup', 2, 10),
           ($1, (now() AT TIME ZONE 'UTC')::date,      'lookup', 1, 10)`,
        [workspaceId],
      );
      await handler();
      const left = await db.query<{ age: number }>(
        "SELECT ((now() AT TIME ZONE 'UTC')::date - utc_date)::int AS age FROM credit_daily_counters WHERE workspace_id = $1 ORDER BY utc_date",
        [workspaceId],
      );
      expect(left.rows.map((row) => row.age)).toEqual([34, 0]);
    });

    it("[STORY-076 AC4] yields to a replica that holds the lock: nothing expires, and nothing is left holding it afterwards", async () => {
      await provision(workspaceId);
      await lot(workspaceId, 1000, "-1 second");
      const other = new Client({ connectionString: container.getConnectionUri() });
      await other.connect();
      try {
        expect(await tryAdvisorySessionLock(other, globalQueueLockKey("credit.housekeeping"))).toBe(true);
        await handler();
        expect(await purchased()).toBe(1000);
      } finally {
        await other.end();
      }
      await handler(); // the holder is gone, so the next tick runs
      expect(await purchased()).toBe(0);
    });
  });
});

import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { adjustCredits, provisionWalletWithGrant, recordPurchase } from "../../src/lib/credits/balance.js";
import { expireDuePurchasedCredits } from "../../src/lib/credits/expire.js";
import { readLedgerForReplay, replayLedger, verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { readWallet } from "../../src/lib/credits/wallet.js";

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
  async function lot(ws: string, credits: number, expiresIn: string | null, status = "succeeded"): Promise<void> {
    await db.query(
      `INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, status, expires_at)
       VALUES ($1,'starter_vault',$2,15.00,$3, CASE WHEN $4::text IS NULL THEN NULL ELSE now() + $4::interval END)`,
      [ws, credits, status, expiresIn],
    );
    if (status === "succeeded") await inTx((tx) => recordPurchase(tx, request(ws, `purchase-${randomUUID()}`), credits));
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
    await lot(workspaceId, 1000, "1 minute");
    expect(await sweep()).toMatchObject({ workspacesExpired: 0, creditsExpired: 0 });
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
    const [a, b] = await Promise.all([sweep(), expireDuePurchasedCredits({ discovery: await secondDiscovery(), work })]);
    expect(a.creditsExpired + b.creditsExpired).toBe(1000);
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
});

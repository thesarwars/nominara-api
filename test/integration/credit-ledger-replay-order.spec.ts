import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { adjustCredits, provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { readLedgerForReplay, replayLedger, verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { readWallet } from "../../src/lib/credits/wallet.js";

// STORY-073 AC4 — the nightly replay orders the ledger by `seq`. `readLedgerForReplay` selected `seq::text` and then
// wrote `ORDER BY seq`; Postgres resolves an ORDER BY name against the OUTPUT columns first, so it sorted the TEXT
// ("10" < "8" < "9"). The replay then walked the entries out of order and reported a false divergence for every
// workspace whose ledger crossed a power of ten. Found in PR #91's review.
//
// Real SQL, because the defect lives in how Postgres resolves the name and no fake reproduces that.
describe("STORY-073 · readLedgerForReplay orders by the NUMERIC seq", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let humanId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
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
    humanId = (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`a-${randomUUID().slice(0, 8)}@nominara.test`])).rows[0]!.id;
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
  });

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

  /** Starts the identity so this workspace's entries carry seq 8, 9, 10, 11, 12 — straddling 9 -> 10. */
  async function restartSeqAt(next: number): Promise<void> {
    await db.query(`ALTER TABLE credit_ledger ALTER COLUMN seq RESTART WITH ${String(next)}`);
  }

  async function ledgerWithSeqStraddling9To10(): Promise<void> {
    await restartSeqAt(8);
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 100, { start: "2026-09-01", end: "2026-10-01" })); // seq 8
    for (let i = 0; i < 4; i += 1) {
      await inTx((tx) =>
        adjustCredits(
          tx,
          { workspaceId, idempotencyKey: `adj-${String(i)}`, actorId: humanId, actorType: "user", reason: "support credit" },
          "purchased",
          10,
        ),
      ); // seq 9, 10, 11, 12
    }
  }

  it("[STORY-073 AC4] returns the entries in NUMERIC seq order across the 9 -> 10 boundary", async () => {
    await ledgerWithSeqStraddling9To10();
    const seqs = (await readLedgerForReplay(db, workspaceId)).map((row) => row.seq);
    expect(seqs).toEqual(["8", "9", "10", "11", "12"]);
  });

  it("[STORY-073 AC4] a ledger that crosses 9 -> 10 replays to the wallet and the verifier reports NO divergence", async () => {
    await ledgerWithSeqStraddling9To10();
    expect(await readWallet(db, workspaceId)).toMatchObject({ includedBalance: 100, purchasedBalance: 40, reserved: 0 });
    const replayed = replayLedger(await readLedgerForReplay(db, workspaceId));
    expect(replayed.divergence).toBeNull();
    expect(replayed.balance).toEqual({ included: 100, purchased: 40, reserved: 0 });
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  it("[STORY-073 AC4] a ledger crossing 99 -> 100 is ordered numerically too", async () => {
    await restartSeqAt(98);
    await inTx((tx) => provisionWalletWithGrant(tx, workspaceId, 100, { start: "2026-09-01", end: "2026-10-01" })); // 98
    for (let i = 0; i < 3; i += 1) {
      await inTx((tx) =>
        adjustCredits(tx, { workspaceId, idempotencyKey: `adj-${String(i)}`, actorId: humanId, actorType: "user", reason: "support credit" }, "purchased", 5),
      ); // 99, 100, 101
    }
    expect((await readLedgerForReplay(db, workspaceId)).map((row) => row.seq)).toEqual(["98", "99", "100", "101"]);
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });
});

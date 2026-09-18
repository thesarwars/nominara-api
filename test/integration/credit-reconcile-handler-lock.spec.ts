import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Job } from "bullmq";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { readWallet, reserveCredits } from "../../src/lib/credits/wallet.js";
import { createCreditReconcileHandler } from "../../src/lib/queue/handlers/credit-reconcile.handler.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";
import type { Env } from "../../src/config/env.schema.js";

// STORY-141 — `system-architecture.md` §4 specifies `credit.reconcile` as
// "1, advisory-locked" and only the concurrency half was ever built.
//
// ⚠ THIS IS THE FIRST TEST OF THIS HANDLER AT ALL. `createCreditReconcileHandler`
// appeared only in `src/` until now: `credit-ledger-reconciliation.spec.ts`
// drives `reconcileOrphanedReservations` directly, so everything the HANDLER
// adds around the scan — the privileged discovery connection, its lifetime,
// and now the lock — was unasserted. STORY-140 gave this job a timer, which
// is what makes the gap reachable: BullMQ's `concurrency: 1` bounds one
// Worker instance, not the queue, so two worker-rollup replicas each tick
// this every ten minutes and can overlap. `locks.ts`'s header makes exactly
// this argument for exactly this queue.

describe("STORY-141 · credit.reconcile holds §4's advisory lock", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let appPool: Pool;
  let env: Env;
  let workspaceId: string;

  const LOCK_KEY = globalQueueLockKey("credit.reconcile");

  /** The job shape the scheduler produces — `data: {}`, no payload. */
  const tick = (): Job => ({ data: {} }) as unknown as Job;

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
    appPool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: "nominara_app",
      password: resolvePassword("nominara_app", {}),
      max: 4,
    });
    // The handler opens its OWN privileged connection from this url — that is
    // the connection the lock has to live on, so it must be the real thing.
    env = { DATABASE_URL: container.getConnectionUri() } as unknown as Env;
  }, 300_000);

  afterAll(async () => {
    await appPool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, credit_wallets, workspaces, users CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query("BEGIN");
    await provisionWalletWithGrant(db as ClientBase, workspaceId, 600, { start: "2026-09-01", end: "2026-10-01" });
    await db.query("COMMIT");
  });

  /**
   * An orphan the handler will actually pick up.
   *
   * ⚠ IT HAS TO BE OLDER THAN THE GRACE WINDOW, and the window cannot be
   * turned off here. `credit-ledger-reconciliation.spec.ts` passes
   * `{ graceMs: 0 }`, but the HANDLER takes the production default
   * (`ORPHAN_GRACE_MS`, 15 minutes) and giving it a test-only override would
   * mean testing a code path production does not run. Without the backdate
   * every assertion below passes vacuously: nothing is ever found, so
   * "yielded" and "swept" look identical.
   *
   * The row is INSERTED with a backdated `occurred_at` rather than updated
   * into one — `credit_ledger` is append-only and trigger-enforced, and
   * `appendLedgerEntry` deliberately lets the column default to the
   * DATABASE's clock so the app can never hand one in.
   */
  async function orphan(key: string, credits: number): Promise<void> {
    const reserved = await reserveCredits(db, workspaceId, credits);
    const after = reserved.wallet!;
    await db.query(
      `INSERT INTO credit_ledger
         (workspace_id, actor_id, actor_type, entry_type, action_code, credits,
          included_after, purchased_after, reserved_after, idempotency_key, attempt, occurred_at)
       VALUES ($1, NULL, 'system', 'reserve', 'manual_scan', $2, $3, $4, $5, $6, 1, now() - interval '30 minutes')`,
      [workspaceId, credits, after.includedBalance, after.purchasedBalance, after.reserved, key],
    );
  }

  async function releaseCount(): Promise<number> {
    const result = await db.query("SELECT 1 FROM credit_ledger WHERE entry_type = 'release'");
    return result.rowCount ?? 0;
  }

  /** A granted privilege makes the role undroppable, so it goes first. */
  async function dropBlindRole(): Promise<void> {
    await db.query("REVOKE ALL ON DATABASE nominara_test FROM lock_but_blind").catch(() => undefined);
    await db.query("DROP OWNED BY lock_but_blind").catch(() => undefined);
    await db.query("DROP ROLE IF EXISTS lock_but_blind").catch(() => undefined);
  }

  /** Holds the lock on a connection of its own, as another replica would. */
  async function asAnotherReplica<T>(fn: () => Promise<T>): Promise<T> {
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      expect(await tryAdvisorySessionLock(other, LOCK_KEY)).toBe(true);
      return await fn();
    } finally {
      await other.end();
    }
  }

  it("sweeps the orphan when nothing else holds the lock", async () => {
    await orphan("dead-pod", 40);

    await createCreditReconcileHandler({ pool: appPool, env })(db, tick());

    expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, available: 600 });
    expect(await releaseCount()).toBe(1);
  });

  it("⚠ YIELDS ENTIRELY when another replica holds the lock — and releases nothing", async () => {
    // The whole point. Before STORY-140 nothing enqueued this job, so two
    // simultaneous reconcilers were not reachable and §4's "advisory-locked"
    // was moot. A timer in every replica makes it reachable.
    await orphan("dead-pod", 40);

    await asAnotherReplica(async () => {
      await createCreditReconcileHandler({ pool: appPool, env })(db, tick());
    });

    // Untouched: the hold is still live and no release was written.
    expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 40, available: 560 });
    expect(await releaseCount()).toBe(0);
  });

  it("⚠ the yielded tick does not throw — a skipped run is a normal outcome, not a job failure", async () => {
    // If this threw, the tick would go down the retry ladder and into the
    // dead-letter queue, and an operator reading that queue during an
    // incident would find the reconciler apparently broken when it was
    // merely being polite.
    await orphan("dead-pod", 40);

    await asAnotherReplica(async () => {
      await expect(createCreditReconcileHandler({ pool: appPool, env })(db, tick())).resolves.toBeUndefined();
    });
  });

  it("⚠ RELEASES the lock when the run finishes, so the next tick is not locked out forever", async () => {
    // A session-scoped lock that is never released is the failure `locks.ts`'s
    // header warns about. Proven by taking it afterwards rather than by
    // reading the code.
    await orphan("dead-pod", 40);

    await createCreditReconcileHandler({ pool: appPool, env })(db, tick());

    const probe = new Client({ connectionString: container.getConnectionUri() });
    await probe.connect();
    try {
      expect(await tryAdvisorySessionLock(probe, LOCK_KEY)).toBe(true);
    } finally {
      await probe.end();
    }
  });

  it("⚠ RELEASES the lock even when the scan THROWS, not merely when it fails a row", async () => {
    // The `finally` is what makes this true. Without it, one failed run wedges
    // the reconciler for the life of the process — and the reconciler is the
    // path that hands credits back to people who were never charged, so it
    // would fail silently and indefinitely.
    //
    // ⚠ A BROKEN `work` POOL DOES NOT TEST THIS. `reconcile.ts` checks its
    // client out INSIDE the try and records a pool failure into `failures[]`
    // rather than throwing, and the handler deliberately does not fail the job
    // on those. The reachable throw is DISCOVERY failing — a dropped
    // connection, a statement timeout, or a privilege regression — which
    // propagates out of `openReservations`.
    //
    // Reproduced with a role that can take an advisory lock but cannot read
    // `credit_ledger`, because advisory locks require no table privileges at
    // all. So the lock IS taken and the scan then throws, which is exactly the
    // window the `finally` exists for.
    await orphan("dead-pod", 40);
    await dropBlindRole();
    await db.query("CREATE ROLE lock_but_blind LOGIN PASSWORD 'blind'");
    await db.query("GRANT CONNECT ON DATABASE nominara_test TO lock_but_blind");
    const blindUrl = `postgres://lock_but_blind:blind@${container.getHost()}:${String(container.getMappedPort(5432))}/nominara_test`;

    await expect(
      createCreditReconcileHandler({ pool: appPool, env: { DATABASE_URL: blindUrl } as unknown as Env })(db, tick()),
    ).rejects.toThrow(/credit_ledger/);

    const probe = new Client({ connectionString: container.getConnectionUri() });
    await probe.connect();
    try {
      expect(await tryAdvisorySessionLock(probe, LOCK_KEY)).toBe(true);
    } finally {
      await probe.end();
      await dropBlindRole();
    }
  });

  it("⚠ two genuinely concurrent ticks sweep the orphan exactly once between them", async () => {
    // The production shape: two replicas, same instant. One wins the lock and
    // sweeps; the other yields. `credit-ledger-reconciliation.spec.ts` already
    // proves the ledger survives an overlap WITHOUT the lock — this proves the
    // overlap no longer happens.
    await orphan("dead-pod", 40);
    await orphan("dead-pod-2", 50);

    await Promise.all([
      createCreditReconcileHandler({ pool: appPool, env })(db, tick()),
      createCreditReconcileHandler({ pool: appPool, env })(db, tick()),
    ]);

    expect(await releaseCount()).toBe(2);
    expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, available: 600 });
  });

  it("⚠ locks on the key locks.ts already names for this queue, not a new one", async () => {
    // `globalQueueLockKey`'s own doc comment names `credit.reconcile`, and
    // `queue-advisory-locks.spec.ts` has tested that key since STORY-030.
    // Locking on anything else would be a second, private lock that the
    // existing one does not exclude.
    await orphan("dead-pod", 40);
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      expect(await tryAdvisorySessionLock(holder, "queue-lock:credit.reconcile:global")).toBe(true);
      await createCreditReconcileHandler({ pool: appPool, env })(db, tick());
      expect(await releaseCount()).toBe(0);
    } finally {
      await holder.end();
    }
  });
});

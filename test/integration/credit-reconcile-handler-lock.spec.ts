import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool, type ClientBase } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

// ⚠ A PASSTHROUGH SPY ON `connect`, so the URL the handler ACTUALLY opens is
// observable. Asserting `withKeepalives()` builds the right string proves the
// function; it does not prove the handler calls it, and a mutation dropping
// the call passed the whole spec until this was added. Postgres exposes no way
// to read another backend's GUCs, so the connection string is the seam.
const connectedUrls: string[] = [];
vi.mock("../../src/db/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/db/client.js")>("../../src/db/client.js");
  return {
    ...actual,
    connect: async (url: string) => {
      connectedUrls.push(url);
      return actual.connect(url);
    },
  };
});
import type { Job } from "bullmq";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { readWallet, reserveCredits } from "../../src/lib/credits/wallet.js";
import { createCreditReconcileHandler, withKeepalives } from "../../src/lib/queue/handlers/credit-reconcile.handler.js";
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

  async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("waitUntil timed out");
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

  it("⚠ HOLDS the lock ACROSS the per-reservation transactions, and frees it after", async () => {
    // ⚠ THE ONE TEST THAT PINS THE WHOLE PREMISE, and the first version of
    // this spec did not have it. Probing after the handler returns cannot
    // distinguish "released" from "never taken" — a handler that ignores the
    // lock entirely passes that. A review proved it: five of the original
    // seven tests passed unchanged against the pre-change handler.
    //
    // The reason a SESSION lock was introduced at all is that it must outlive
    // the per-reservation transactions, which run on a DIFFERENT connection
    // (the `work` pool). So the assertion has to happen while the scan is
    // genuinely in flight. This stalls it there: an outside transaction holds
    // the wallet row with `FOR UPDATE`, so the reconciler blocks INSIDE a
    // release transaction, and only then is the lock probed.
    await orphan("dead-pod", 40);

    const blocker = new Client({ connectionString: container.getConnectionUri() });
    await blocker.connect();
    const probe = new Client({ connectionString: container.getConnectionUri() });
    await probe.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT 1 FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE", [workspaceId]);

      const running = createCreditReconcileHandler({ pool: appPool, env })(db, tick());

      // Wait until the reconciler is genuinely blocked on that row rather
      // than merely started — otherwise this races the scan's own startup and
      // would pass for the wrong reason.
      await waitUntil(async () => {
        const waiting = await probe.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%credit_wallets%'`,
        );
        return (waiting.rowCount ?? 0) > 0;
      });

      // MID-SCAN: the lock is held, across a transaction on another connection.
      expect(await tryAdvisorySessionLock(probe, LOCK_KEY)).toBe(false);

      await blocker.query("ROLLBACK");
      await running;

      // AFTER: free again.
      expect(await tryAdvisorySessionLock(probe, LOCK_KEY)).toBe(true);
    } finally {
      await blocker.end();
      await probe.end();
    }
  }, 30_000);

  it("⚠ does not leave the lock held when the scan THROWS, not merely when it fails a row", async () => {
    // ⚠ WHAT THIS PINS AND WHAT IT DOES NOT. It proves the error path leaves
    // no lock behind; it CANNOT distinguish that from never taking one, and a
    // review measured it passing against the pre-change handler. The test
    // above is what establishes the lock is taken at all. This one covers the
    // `finally` on the throw path, which is a narrower but real claim.
    //
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

  it("⚠ of two genuinely concurrent ticks, exactly ONE scans and the other yields", async () => {
    // ⚠ ASSERTED ON THE LOGS, NOT THE LEDGER, AND THAT IS THE POINT. The first
    // version checked `releaseCount() === 2` — which holds WITHOUT any lock,
    // because `releaseReservation` is already idempotent and the loser's
    // releases come back `already_settled`. So it re-proved
    // `credit-ledger-reconciliation.spec.ts`'s invariant and said nothing
    // about this change; a review measured it passing pre-change.
    //
    // What distinguishes locked from merely-safe is how many runs SCANNED.
    await orphan("dead-pod", 40);
    await orphan("dead-pod-2", 50);

    const scans: string[] = [];
    const yields: string[] = [];
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      if (String(message).startsWith("orphan scan")) scans.push(String(message));
    });
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation((message: unknown) => {
      if (String(message).includes("yielding")) yields.push(String(message));
    });

    try {
      await Promise.all([
        createCreditReconcileHandler({ pool: appPool, env })(db, tick()),
        createCreditReconcileHandler({ pool: appPool, env })(db, tick()),
      ]);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(scans).toHaveLength(1);
    expect(yields).toHaveLength(1);
    // And the ledger is still correct, which was never in doubt.
    expect(await releaseCount()).toBe(2);
    expect(await readWallet(db, workspaceId)).toMatchObject({ reserved: 0, available: 600 });
  }, 30_000);

  it("⚠ LEAKS NO BACKEND, which is what makes `discovery.end()` load-bearing", async () => {
    // ⚠ THE MUTANT THAT USED TO SURVIVE. An earlier comment called `end()` and
    // the explicit unlock redundant; a review proved that backwards. Remove
    // `end()` and every one of these ticks leaks an OWNER-ROLE, non-pooled
    // backend — one every ten minutes per replica in production, until
    // `max_connections` is exhausted and `connect()` starts failing, at which
    // point reconciliation stops entirely. Nothing pinned it.
    //
    // Yielded ticks are used because they are the cheapest path through the
    // whole function, and they still open and must close a connection.
    const owner = async (): Promise<number> => {
      const result = await db.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'nominara' AND datname = current_database()`,
      );
      return result.rows[0]!.n as number;
    };

    await orphan("dead-pod", 40);
    const before = await owner();

    await asAnotherReplica(async () => {
      for (let i = 0; i < 5; i += 1) {
        await createCreditReconcileHandler({ pool: appPool, env })(db, tick());
      }
    });

    expect(await owner()).toBe(before);
  }, 30_000);

  it("⚠ BOUNDS how long a dead process can hold the lock, via server-side keepalives", async () => {
    // ⚠ WITHOUT THIS THE LOCK IS WORSE THAN NO LOCK. A replica that is
    // PARTITIONED rather than killed leaves a live backend holding a
    // fleet-wide lock, and nothing in this repository sets any timeout — so
    // every other replica's tick yields until the OS TCP keepalive default
    // notices, which is TWO HOURS on Linux. For that whole window no orphaned
    // reservation in any workspace is returned to anyone, and because a
    // yielded tick COMPLETES, the dead-letter queue stays empty and every
    // alarm reads green.
    //
    // Asserted against `pg_settings` on a connection built the same way the
    // handler builds its own, because a URL that merely looks right proves
    // nothing — the option has to actually reach the backend.
    const probe = new Client({ connectionString: withKeepalives(container.getConnectionUri()) });
    await probe.connect();
    try {
      const settings = await probe.query<{ name: string; setting: string }>(
        "SELECT name, setting FROM pg_settings WHERE name LIKE 'tcp_keepalives%' ORDER BY name",
      );
      expect(settings.rows).toEqual([
        { name: "tcp_keepalives_count", setting: "3" },
        { name: "tcp_keepalives_idle", setting: "60" },
        { name: "tcp_keepalives_interval", setting: "10" },
      ]);
    } finally {
      await probe.end();
    }
  });

  it("⚠ the HANDLER opens its discovery connection with those keepalives", async () => {
    // The wiring, not the helper. Dropping `withKeepalives(...)` from the
    // handler's own `connect()` call passed every other test in this file.
    connectedUrls.length = 0;
    await orphan("dead-pod", 40);

    await createCreditReconcileHandler({ pool: appPool, env })(db, tick());

    expect(connectedUrls).toHaveLength(1);
    expect(connectedUrls[0]).toContain("tcp_keepalives_idle%3D60");
  });

  it("⚠ preserves whatever the database URL already carried", async () => {
    // Appending options by string concatenation would corrupt a URL that
    // already has a query, and the reconciler's connection is the privileged
    // one — a malformed url here fails the run, not a request.
    const built = new URL(withKeepalives("postgres://u:p@h:5432/db?sslmode=require"));
    expect(built.searchParams.get("sslmode")).toBe("require");
    expect(built.searchParams.get("options")).toContain("tcp_keepalives_idle=60");
    expect(built.pathname).toBe("/db");
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

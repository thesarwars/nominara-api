import { randomUUID } from "node:crypto";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { firstValueFrom, of, throwError } from "rxjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { CreditGuard } from "../../src/api/guards/credit.guard.js";
import { CreditInterceptor } from "../../src/api/interceptors/credit.interceptor.js";
import { CONFIRMED_CREDITS_HEADER } from "../../src/api/guards/credit.guard.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { incrementDailyCounter } from "../../src/lib/usage/daily-cap.js";
import { readWallet } from "../../src/lib/credits/wallet.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";

// STORY-072 — THE SETTLEMENT SEAM, DRIVEN THROUGH THE REAL CLASSES.
//
// The second-engineer review's sharpest point: the first version of this
// story's settlement test hand-called `incrementDailyCounter`,
// `reserveCredits` and `compensateDailyCounter` in sequence and asserted the
// result. It passed. The product was broken, because `CreditGuard` ran that
// sequence inside one transaction and threw from it, so the compensation
// rolled back — and no test ever invoked the guard.
//
// Four of the five defects it found lived in code with no test at all. These
// exercise the real `CreditGuard` and the real `CreditInterceptor`.

const PRICE = 100;

describe("STORY-072 · settlement through the real guard and interceptor", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceId: string;

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
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, credit_daily_counters, credit_wallets, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'free')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  function guard(): CreditGuard {
    const reflector = { getAllAndOverride: () => "deep_scan" } as unknown as Reflector;
    const resolver = {
      resolveForWorkspace: () =>
        Promise.resolve({
          workspace_id: workspaceId,
          plan_key: "free",
          entitlement_version: 1,
          entitlements: {
            "deep_scan.credits": { value: PRICE, source: "plan", live: true },
            "credits.included_per_cycle": { value: 300, source: "plan", live: true },
          },
        }),
    } as unknown as EntitlementResolver;
    return new CreditGuard(reflector, resolver, pool);
  }

  interface Req {
    tenant: { workspaceId: string };
    headers: Record<string, string>;
    creditReservation?: unknown;
    dailyCapCompensation?: { workspaceId: string; action: "lookup" };
  }

  function request(key: string, over: Partial<Req> = {}): Req {
    return {
      tenant: { workspaceId },
      headers: { [CONFIRMED_CREDITS_HEADER]: String(PRICE), "idempotency-key": key },
      ...over,
    };
  }

  function contextFor(req: Req): ExecutionContext {
    return {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: () => undefined }) }),
    } as unknown as ExecutionContext;
  }

  async function wallet() {
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => readWallet(db, workspaceId));
  }

  async function ledger(entryType: string): Promise<number> {
    const rows = await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1 AND entry_type = $2", [
      workspaceId,
      entryType,
    ]);
    return rows.rowCount ?? 0;
  }

  it("provisions a wallet on first use — nothing else in the product creates one", async () => {
    expect(await wallet()).toBeNull();
    await guard().canActivate(contextFor(request("k-1")));
    expect(await wallet()).toMatchObject({ includedBalance: 300, reserved: PRICE });
  });

  it("⚠ ACCOUNTS FOR THE PROVISIONING GRANT IN THE LEDGER, not just in the balance", async () => {
    // ⚠ STORY-073: `provisionWallet` inserted `included_balance = 300` and
    // wrote no entry, so the very first workspace to touch a priced route
    // held credits its ledger could not explain — and the nightly verifier
    // would have paged on every new workspace.
    //
    // The assertion is here, on the GUARD, because that is the only caller.
    // The second-engineer review reverted this call site to `provisionWallet`
    // — reinstating the exact defect the change exists to fix — and 2,286
    // unit and 1,238 integration tests stayed green, because the coverage
    // lived on the library function rather than on the path that uses it.
    await guard().canActivate(contextFor(request("k-1")));

    expect(await ledger("grant")).toBe(1);
    expect(await verifyWorkspaceWallet(db, workspaceId)).toBeNull();
  });

  it("BLOCKER 1 — a REDELIVERED request does not open a second reservation", async () => {
    // The review drained a 600-credit wallet to zero with three retries of
    // one action, each leaking a reservation, `lifetime_spent: 0`.
    // `ux_credit_ledger_idem` is what stops it: the second reserve entry
    // conflicts and the wallet movement is rolled back with it.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await guard().canActivate(contextFor(request("same-key")));
    }

    expect(await wallet()).toMatchObject({ reserved: PRICE, available: 200 });
    expect(await ledger("reserve")).toBe(1);
  });

  it("a DIFFERENT key is a different action and does reserve again", async () => {
    await guard().canActivate(contextFor(request("k-a")));
    await guard().canActivate(contextFor(request("k-b")));
    expect(await wallet()).toMatchObject({ reserved: 2 * PRICE });
    expect(await ledger("reserve")).toBe(2);
  });

  it("refuses a priced route with NO idempotency key, before reserving anything", async () => {
    const req = request("unused");
    delete req.headers["idempotency-key"];
    await expect(guard().canActivate(contextFor(req))).rejects.toMatchObject({ code: "validation_failed" });
    expect(await wallet()).toBeNull();
  });

  it("BLOCKER 2 — a wallet refusal COMPENSATES the daily counter, outside the rolled-back transaction", async () => {
    // STORY-071 AC6. The first implementation compensated inside the
    // transaction it then threw from, so the decrement died with it — and
    // the test that claimed otherwise never called this guard.
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
       VALUES ($1, 0, 0, 0, (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 30)`,
      [workspaceId],
    );
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
      incrementDailyCounter(db, workspaceId, "lookup", 3),
    );

    const req = request("k-broke", { dailyCapCompensation: { workspaceId, action: "lookup" } });
    await expect(guard().canActivate(contextFor(req))).rejects.toMatchObject({ code: "insufficient_credits" });

    const used = await db.query<{ used_count: string }>(
      "SELECT used_count::text FROM credit_daily_counters WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(Number(used.rows[0]!.used_count)).toBe(0);
  });

  it("the refusal carries the required amount, the bucket split and the tier-filtered packs", async () => {
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
       VALUES ($1, 5, 2, 0, (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 30)`,
      [workspaceId],
    );
    await expect(guard().canActivate(contextFor(request("k-poor")))).rejects.toMatchObject({
      code: "insufficient_credits",
      details: {
        required: PRICE,
        available: 7,
        wallet: { included_balance: 5, purchased_balance: 2, reserved: 0 },
        packs: [],
      },
    });
  });

  it("leads the refusal with the scheduled-work guarantee", async () => {
    // A customer who reads "out of credits" and concludes their tracking has
    // stopped will cancel over a misunderstanding.
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, purchased_balance, reserved, cycle_start, cycle_end)
       VALUES ($1, 0, 0, 0, (now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 30)`,
      [workspaceId],
    );
    await expect(guard().canActivate(contextFor(request("k-copy")))).rejects.toMatchObject({
      message: expect.stringMatching(/^Your scheduled tracking is unaffected/) as unknown as string,
    });
  });

  // ── The interceptor ─────────────────────────────────────────────────────

  async function runInterceptor(req: Req, handler: () => unknown): Promise<unknown> {
    const interceptor = new CreditInterceptor(pool);
    const next: CallHandler = {
      handle: () => {
        try {
          return of(handler());
        } catch (error) {
          return throwError(() => error);
        }
      },
    };
    // Inside a tenant transaction, exactly as TenantContextInterceptor puts it.
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
      firstValueFrom(interceptor.intercept(contextFor(req), next)),
    );
  }

  it("commits on success, inside the request's transaction, and records the entry", async () => {
    const req = request("k-ok");
    await guard().canActivate(contextFor(req));
    await runInterceptor(req, () => ({ ok: true }));

    expect(await wallet()).toMatchObject({ includedBalance: 200, reserved: 0 });
    expect(await ledger("commit")).toBe(1);
  });

  it("BLOCKER 4 — a COMMIT FAILURE still releases, rather than stranding the reservation", async () => {
    const req = request("k-commit-fails");
    await guard().canActivate(contextFor(req));

    // Release the reservation behind the interceptor's back, so its commit
    // matches no row — the reconciler-swept-it-first case.
    await withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
      db.query("UPDATE credit_wallets SET reserved = 0 WHERE workspace_id = $1", [workspaceId]),
    );

    await expect(runInterceptor(req, () => ({ ok: true }))).rejects.toBeDefined();
    // The request fails rather than handing out a free run.
    expect(await ledger("commit")).toBe(0);
  });

  it("releases on a handler failure, off the request's connection", async () => {
    const req = request("k-boom");
    await guard().canActivate(contextFor(req));
    expect(await wallet()).toMatchObject({ reserved: PRICE });

    await expect(
      runInterceptor(req, () => {
        throw new Error("handler exploded");
      }),
    ).rejects.toThrow(/handler exploded/);

    // Scheduled off the critical path, so give the immediate a turn.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await wallet()).toMatchObject({ reserved: 0, includedBalance: 300 });
    expect(await ledger("release")).toBe(1);
  });

  it("BLOCKER 3 — the release completes on its own pool WHILE the request holds the only other connection", async () => {
    // The first version of this test asserted only that the request rejected
    // with /boom/ — which `setImmediate` alone makes true whether or not the
    // release ever got a connection. The re-review reproduced it passing
    // against the pre-fix mutant. So this asserts the release's EFFECT, and
    // does it while the request's connection is still checked out of a pool
    // of ONE: if the release competed for that pool, it could never finish.
    const tight = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
    try {
      const req = request("k-tight");
      await guard().canActivate(contextFor(req));
      expect(await wallet()).toMatchObject({ reserved: PRICE });

      const interceptor = new CreditInterceptor(tight);
      const next: CallHandler = { handle: () => throwError(() => new Error("boom")) };

      const client = await tight.connect();
      try {
        await expect(
          withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () =>
            firstValueFrom(interceptor.intercept(contextFor(req), next)),
          ),
        ).rejects.toThrow(/boom/);

        // THE POOL OF ONE IS STILL HELD RIGHT HERE. A release that used it
        // would be waiting behind this line forever.
        await expect
          .poll(async () => (await wallet())?.reserved, { timeout: 5_000 })
          .toBe(0);
        expect(await ledger("release")).toBe(1);
      } finally {
        client.release();
      }
      await interceptor.onModuleDestroy();
    } finally {
      await tight.end();
    }
  }, 30_000);

  // ── The re-review's two blockers ────────────────────────────────────────

  it("RE-REVIEW B1 — a retry after a RELEASED attempt reserves again instead of re-attaching to nothing", async () => {
    // `IdempotencyInterceptor` releases its claim when a handler throws,
    // explicitly so "a client retrying after a transient fault" is not
    // refused. The first ledger dedupe treated the permanent `reserve` entry
    // as proof of a standing reservation, so that retry re-attached to a
    // reservation that had been released — the handler succeeded, the commit
    // matched no row, and the key was poisoned forever.
    const first = request("k-retry");
    await guard().canActivate(contextFor(first));
    await expect(
      runInterceptor(first, () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow(/transient/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await wallet()).toMatchObject({ reserved: 0, includedBalance: 300 });

    // The retry must get credits of its own.
    const retry = request("k-retry");
    await guard().canActivate(contextFor(retry));
    expect(await wallet()).toMatchObject({ reserved: PRICE });

    await runInterceptor(retry, () => ({ ok: true }));
    expect(await wallet()).toMatchObject({ includedBalance: 200, reserved: 0 });
    expect(await ledger("commit")).toBe(1);
    // Two attempts, two reserve entries — the second under an attempt key.
    expect(await ledger("reserve")).toBe(2);
  });

  it("RE-REVIEW B2 — a key whose action ALREADY COMMITTED is refused, so the handler cannot run free", async () => {
    // When `IdempotencyInterceptor` loses its stored response it degrades to
    // executing, so the handler really would run a second time. The first
    // version skipped the debit silently and handed out a free run that had
    // really spent at the engine. Refusing at the guard stops the handler
    // running at all.
    const req = request("k-done");
    await guard().canActivate(contextFor(req));
    await runInterceptor(req, () => ({ ok: true }));
    expect(await wallet()).toMatchObject({ includedBalance: 200 });

    await expect(guard().canActivate(contextFor(request("k-done")))).rejects.toMatchObject({ code: "conflict" });
    // Nothing moved, and no second reservation was opened.
    expect(await wallet()).toMatchObject({ includedBalance: 200, reserved: 0 });
    expect(await ledger("reserve")).toBe(1);
  });

  it("ROUND 3 — a client key containing '#' cannot reach another request's reservation", async () => {
    // `idempotencyKeySchema` permits any character, so `job#2` was a legal
    // client key AND the namespace the guard used for its own second attempt
    // at `job`. The review reproduced both directions inside one workspace:
    // a second seat's own key refused as "already charged", and a retry of
    // `job` committing against `job#2`'s live reservation.
    //
    // Migration 0022 made the attempt a COLUMN. A client cannot write one.
    const a = request("job");
    await guard().canActivate(contextFor(a));
    await expect(
      runInterceptor(a, () => {
        throw new Error("transient");
      }),
    ).rejects.toThrow(/transient/);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // A second seat's own key, which used to collide with `job`'s attempt 2.
    const b = request("job#2");
    await guard().canActivate(contextFor(b));
    expect(await wallet()).toMatchObject({ reserved: PRICE });

    // And `job`'s retry takes a reservation of its OWN, not the second
    // seat's — both are held at once.
    const retry = request("job");
    await guard().canActivate(contextFor(retry));
    expect(await wallet()).toMatchObject({ reserved: 2 * PRICE });

    const rows = await db.query<{ idempotency_key: string; attempt: number }>(
      "SELECT idempotency_key, attempt FROM credit_ledger WHERE entry_type = 'reserve' ORDER BY occurred_at",
      [],
    );
    expect(rows.rows.map((row) => `${row.idempotency_key}/${String(row.attempt)}`)).toEqual([
      "job/1",
      "job#2/1",
      "job/2",
    ]);
  });

  it("ROUND 3 — the already-completed refusal never tells the client to retry with a new key", async () => {
    // That wording turned a lost acknowledgement into a double charge: a
    // fresh key reserves, executes and charges again for one customer
    // intent.
    const req = request("k-charged");
    await guard().canActivate(contextFor(req));
    await runInterceptor(req, () => ({ ok: true }));

    await expect(guard().canActivate(contextFor(request("k-charged")))).rejects.toMatchObject({
      code: "conflict",
      message: expect.not.stringContaining("new Idempotency-Key") as unknown as string,
    });
  });

  it("a redelivery while the reservation is STILL OPEN re-attaches rather than reserving twice", async () => {
    const req = request("k-open");
    await guard().canActivate(contextFor(req));
    await guard().canActivate(contextFor(request("k-open")));

    expect(await wallet()).toMatchObject({ reserved: PRICE });
    expect(await ledger("reserve")).toBe(1);
  });
});

import { randomUUID } from "node:crypto";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { firstValueFrom, of, throwError } from "rxjs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditGuard, CONFIRMED_CREDITS_HEADER } from "../../src/api/guards/credit.guard.js";
import { CreditInterceptor } from "../../src/api/interceptors/credit.interceptor.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import type { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-D-7 checkpoint-3 finding 4 / owner decision 4 — the auto-top-up trigger is reached by a signed
// `billing.auto_topup` queue job, enqueued AFTER a debit leaves the balance below the threshold, and never
// by anything on the request path. This drives the real CreditGuard and CreditInterceptor (the only code that
// reserves and commits a debit) with a recording producer.

const PRICE = 100; // reserved at the guard; the wallet is provisioned with 300 included, so available is 200 after the commit

describe("NEW-D-7 checkpoint-3 · a debit below the threshold enqueues billing.auto_topup", () => {
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

  const interceptors: CreditInterceptor[] = [];
  afterEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    for (const interceptor of interceptors.splice(0)) await interceptor.onModuleDestroy();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credit_ledger, credit_daily_counters, credit_wallets, workspaces CASCADE");
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
  });

  function guard(): CreditGuard {
    const reflector = { getAllAndOverride: () => "deep_scan" } as unknown as Reflector;
    const resolver = {
      resolveForWorkspace: () =>
        Promise.resolve({
          workspace_id: workspaceId,
          plan_key: "growth",
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
  }
  const request = (key: string): Req => ({ tenant: { workspaceId }, headers: { [CONFIRMED_CREDITS_HEADER]: String(PRICE), "idempotency-key": key } });
  const contextFor = (req: Req): ExecutionContext =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ header: () => undefined }) }),
    }) as unknown as ExecutionContext;

  /** Reserves through the real guard, then sets the auto-top-up configuration on the provisioned wallet. */
  async function reserve(key: string, config: { enabled: boolean; threshold: number } | null): Promise<Req> {
    const req = request(key);
    await guard().canActivate(contextFor(req));
    if (config !== null) {
      await db.query(
        `UPDATE credit_wallets SET auto_topup_enabled = $2, auto_topup_pack_key = 'starter_vault', auto_topup_threshold = $3, auto_topup_max_per_cycle = 3
          WHERE workspace_id = $1`,
        [workspaceId, config.enabled, config.threshold],
      );
    }
    return req;
  }

  interface Enqueued {
    name: string;
    workspaceId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    commitVisibleElsewhere: boolean;
  }

  function recordingProducer(opts: { reject?: boolean } = {}): { producer: QueueProducer; calls: Enqueued[] } {
    const calls: Enqueued[] = [];
    const producer = {
      enqueueTenantJob: vi.fn(async (name: string, ws: string, payload: Record<string, unknown>, options: { idempotencyKey: string }) => {
        // Seen from a DIFFERENT connection: true only once the request's transaction has committed.
        const seen = await pool.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [ws]);
        calls.push({ name, workspaceId: ws, payload, idempotencyKey: options.idempotencyKey, commitVisibleElsewhere: (seen.rowCount ?? 0) === 1 });
        if (opts.reject === true) throw new Error("valkey down");
        return {} as never;
      }),
    } as unknown as QueueProducer;
    return { producer, calls };
  }

  async function settle(req: Req, producer: QueueProducer | undefined, handler: () => unknown = () => ({ ok: true })): Promise<unknown> {
    const interceptor = new CreditInterceptor(pool, producer);
    interceptors.push(interceptor);
    const next: CallHandler = {
      handle: () => {
        try {
          return of(handler());
        } catch (error) {
          return throwError(() => error);
        }
      },
    };
    return withTenantContext(db, { workspaceId, actorId: SYSTEM_ACTOR_ID }, () => firstValueFrom(interceptor.intercept(contextFor(req), next)));
  }
  const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  it("NEW-D-7-ENQ-1 · a debit that leaves available below the threshold enqueues exactly one signed tenant job for that workspace", async () => {
    const { producer, calls } = recordingProducer();
    await settle(await reserve("k-low", { enabled: true, threshold: 250 }), producer); // available 200 < 250
    await drain();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "billing.auto_topup", workspaceId, payload: {} });
    expect(calls[0]!.idempotencyKey.startsWith(`autotopup:${workspaceId}:`)).toBe(true);
  });

  it("NEW-D-7-ENQ-2 · the job is enqueued only AFTER the request's transaction has committed the debit", async () => {
    const { producer, calls } = recordingProducer();
    await settle(await reserve("k-after", { enabled: true, threshold: 250 }), producer);
    await drain();
    expect(calls[0]?.commitVisibleElsewhere).toBe(true);
  });

  it("NEW-D-7-ENQ-3 · auto-top-up off: nothing is enqueued, however low the balance", async () => {
    const { producer, calls } = recordingProducer();
    await settle(await reserve("k-off", { enabled: false, threshold: 250 }), producer);
    await drain();
    expect(calls).toEqual([]);
  });

  it("NEW-D-7-ENQ-4 · a wallet that was never configured enqueues nothing (threshold NULL)", async () => {
    const { producer, calls } = recordingProducer();
    await settle(await reserve("k-unconfigured", null), producer);
    await drain();
    expect(calls).toEqual([]);
  });

  it("NEW-D-7-ENQ-5 · boundary: available EQUAL to the threshold does not enqueue; one below does", async () => {
    const equal = recordingProducer();
    await settle(await reserve("k-equal", { enabled: true, threshold: 200 }), equal.producer); // available 200, not < 200
    await drain();
    expect(equal.calls).toEqual([]);

    await db.query("TRUNCATE credit_ledger, credit_daily_counters, credit_wallets CASCADE");
    const below = recordingProducer();
    await settle(await reserve("k-below", { enabled: true, threshold: 201 }), below.producer); // available 200 < 201
    await drain();
    expect(below.calls).toHaveLength(1);
  });

  it("NEW-D-7-ENQ-6 · a debit that stays above the threshold enqueues nothing", async () => {
    const { producer, calls } = recordingProducer();
    await settle(await reserve("k-high", { enabled: true, threshold: 50 }), producer);
    await drain();
    expect(calls).toEqual([]);
  });

  it("NEW-D-7-ENQ-7 · a failed request (the handler throws, the hold is released) enqueues nothing", async () => {
    const { producer, calls } = recordingProducer();
    const req = await reserve("k-fails", { enabled: true, threshold: 250 });
    await expect(
      settle(req, producer, () => {
        throw new Error("handler exploded");
      }),
    ).rejects.toThrow(/handler exploded/);
    await drain();
    expect(calls).toEqual([]);
  });

  it("NEW-D-7-ENQ-8 · an enqueue that fails never fails the request: the debit is committed and the response is returned", async () => {
    const { producer } = recordingProducer({ reject: true });
    const out = await settle(await reserve("k-valkey-down", { enabled: true, threshold: 250 }), producer);
    await drain();
    expect(out).toEqual({ ok: true });
    const commits = await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [workspaceId]);
    expect(commits.rowCount).toBe(1);
  });

  it("NEW-D-7-ENQ-9 · a process with no producer wired still settles the debit", async () => {
    const out = await settle(await reserve("k-no-producer", { enabled: true, threshold: 250 }), undefined);
    expect(out).toEqual({ ok: true });
  });
});

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { Logger } from "@nestjs/common";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { QUEUE_HANDLERS, type QueueHandlerFactory, type QueueName } from "../../src/lib/queue/handlers.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { waitFor } from "../support/queue-test-harness.js";
import { loadEnv } from "../../src/config/env.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { signingKeysFromEnv } from "../../src/lib/queue/worker-factory.js";

// STORY-124 — the registry, end to end through a real BullMQ worker built
// by the real bootstrapWorker(), against a real Valkey and a real Postgres.
//
// The unit specs prove the table and the client lifecycle in isolation.
// What only this can prove is that a registered handler is actually reached
// by a job — and, just as importantly, that an unregistered queue is not.

// notify.dispatch: rollup group, tenant-scoped, so the handler runs inside
// withTenantJob and can be asked what context it sees.
const HANDLED: QueueName = "notify.dispatch";
// Non-tenant-scoped, so its processor reaches getClient() immediately —
// which is what makes the not-wired error observable. On a tenant-scoped
// queue the signature is verified first, and correctly so.
const UNHANDLED_UNSIGNED: QueueName = "credit.reconcile";
const WORKSPACE_ID = "018bcfe5-0000-7000-8000-0000000000aa";

describe("STORY-124 · the queue-handler registry", () => {
  let valkey: ValkeyFixture;
  let container: StartedPostgreSqlContainer;
  const originalEnv = { ...process.env };
  const registered: QueueName[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    const db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.end();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    valkey = await startValkeyFixture();
    applyFakeApiEnv();
    process.env.QUEUE_REDIS_URL = valkey.connectionString;
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();
  }, 60_000);

  afterEach(async () => {
    // The registry is a module-level table; anything this file adds to it
    // is removed again, so a later suite never sees a handler this one
    // invented.
    for (const name of registered.splice(0)) delete QUEUE_HANDLERS[name];
    process.env = { ...originalEnv };
    await valkey.stop();
    vi.restoreAllMocks();
  });

  function register(name: QueueName, factory: QueueHandlerFactory): void {
    QUEUE_HANDLERS[name] = factory;
    registered.push(name);
  }

  async function boot(group: string) {
    process.env.WORKER_GROUP = group;
    const { bootstrapWorker, WORKER_GROUP_WORKERS } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    const runtime = app.get<{ workers: readonly { name: string; opts: { autorun: boolean } }[] }>(WORKER_GROUP_WORKERS);
    return { app, runtime };
  }

  // ---- scenario 2 --------------------------------------------------------

  it("scenario 2 — with nothing registered, every worker in the group stays inert", async () => {
    const { app, runtime } = await boot("rollup");
    try {
      expect(runtime.workers.length).toBeGreaterThan(0);
      for (const worker of runtime.workers) {
        // Inert is a better lie than broken: a worker that pulled a job it
        // cannot process would fail it down the retry ladder and into the
        // DLQ, turning "not built yet" into "tried and failed".
        expect(worker.opts.autorun, `${worker.name} must not pull jobs with no handler`).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  // ---- scenario 3 --------------------------------------------------------

  it("scenario 3 — registering one handler autoruns that worker and leaves its siblings inert", async () => {
    register(HANDLED, () => async () => undefined);

    const { app, runtime } = await boot("rollup");
    try {
      const handled = runtime.workers.find((worker) => worker.name === HANDLED);
      expect(handled, `${HANDLED} must be in the rollup group`).toBeDefined();
      expect(handled!.opts.autorun).toBe(true);

      for (const worker of runtime.workers.filter((w) => w.name !== HANDLED)) {
        expect(worker.opts.autorun, `${worker.name} has no handler and must stay inert`).toBe(false);
      }
    } finally {
      await app.close();
    }
  });

  // ---- scenario 4 --------------------------------------------------------

  it("scenario 4 — a job on a handled queue reaches the handler, inside the tenant transaction", async () => {
    const seen: Array<{ workspace: string | null; jobId: string | undefined }> = [];

    register(HANDLED, () => async (tx, job) => {
      // The handler is handed the transaction withTenantJob opened, so the
      // GUC is already set. If the registry wired `process` outside that
      // transaction this would come back empty.
      const result = await tx.query<{ ws: string | null }>("SELECT current_setting('app.current_workspace_id', true) AS ws");
      seen.push({ workspace: result.rows[0]?.ws ?? null, jobId: job.id });
    });

    const { app } = await boot("rollup");
    const entry = QUEUE_TOPOLOGY.find((e) => e.name === HANDLED)!;
    const producer = createQueueWorkerConnection(valkey.connectionString);
    // The same prefix the worker computed, from the same env.
    const queue = buildQueue(entry, { connection: producer, prefix: queueKeyPrefix(loadEnv().NODE_ENV) });

    try {
      // Signed with the keys the WORKER will verify against — read from the
      // same loadEnv() the bootstrap reads, not from the shared test
      // harness, whose kid ("test-kid-k1") is not the env's
      // ("test-queue-kid-1"). A mismatch here does not fail loudly: the job
      // is rejected, retried down the ladder, and the handler simply never
      // runs, which reads exactly like a registry that is not wired.
      const keys = signingKeysFromEnv(loadEnv());
      const envelope = signQueueJobPayload({ workspaceId: WORKSPACE_ID, kid: keys.current.kid }, keys.current.key);

      await enqueueJob(queue, entry, envelope, {
        idempotencyKey: `story-124-${Date.now()}`,
        priorityVariant: "scheduled",
      });

      await waitFor(() => seen.length === 1, { timeoutMs: 20_000 });
      expect(seen[0]!.workspace, "the handler must run inside the context withTenantJob opened").toBe(WORKSPACE_ID);
    } finally {
      await queue.close();
      await producer.quit().catch(() => undefined);
      await app.close();
    }
  }, 60_000);

  // ---- scenario 7 --------------------------------------------------------

  it("scenario 7 — an unhandled queue's processor still throws the not-wired error if forced", async () => {
    const { app, runtime } = await boot("rollup");
    try {
      const inert = runtime.workers.find((worker) => worker.name === UNHANDLED_UNSIGNED)!;
      const processor = (inert as unknown as { processFn: (job: unknown) => Promise<unknown> }).processFn;
      await expect(processor({ data: {} })).rejects.toThrow(/no handler wired yet/);
      await expect(processor({ data: {} })).rejects.toThrow(UNHANDLED_UNSIGNED);
    } finally {
      await app.close();
    }
  });

  // ---- scenario 8 --------------------------------------------------------

  it("scenario 8 — the boot line names the live queues and the inert ones separately", async () => {
    register(HANDLED, () => async () => undefined);
    const logged: string[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      logged.push(String(message));
    });

    const { app } = await boot("rollup");
    try {
      const line = logged.find((message) => message.includes('worker group "rollup"'));
      expect(line, "bootstrap must log a group summary").toBeDefined();
      expect(line).toContain(`1 processing (${HANDLED})`);
      expect(line).toMatch(/inert, no handler wired \(.*credit\.reconcile/);
      // A group that processes nothing must not read the same as one that
      // processes everything.
      expect(line).not.toContain("0 inert");
    } finally {
      await app.close();
    }
  });
});

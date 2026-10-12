import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { signingKeysFromEnv } from "../../src/lib/queue/worker-factory.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { waitFor } from "../support/queue-test-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// SCANFIX D8 - the incident's root cause, in the change's own words: the token bucket was "built,
// configured and tested and NEVER WIRED". A test that builds its own Worker with the lease handed
// in proves the lease works, not that the worker PROCESS installs it - delete the `engineLease`
// spread (or the whole `capture.execute` branch) from src/worker.ts and every other test stays
// green while the system is back to the incident.
//
// This boots the REAL `bootstrapWorker` for WORKER_GROUP=capture against real Valkeys (queue and
// cache instances), with the capture.execute HANDLER replaced by a recorder (and Postgres by a
// stub that hands out a no-op client), enqueues signed gemini jobs through the real producer, and
// asserts on the gap between the calls the handler receives.

const calls = vi.hoisted(() => ({ at: [] as number[] }));

vi.mock("../../src/lib/queue/handlers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/queue/handlers.js")>();
  return {
    ...actual,
    handlerFor: (name: string) =>
      name === "capture.execute"
        ? () => () => {
            calls.at.push(Date.now());
            return Promise.resolve();
          }
        : actual.handlerFor(name as never),
  };
});

vi.mock("../../src/db/pg-pool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/pg-pool.js")>();
  const { fakeClient: client } = await import("../support/queue-test-harness.js");
  return {
    ...actual,
    createPgPool: () => ({
      connect: () => Promise.resolve({ ...client(), release: () => undefined }),
      end: () => Promise.resolve(),
    }),
  };
});

const RPM = 120;
const GAP_MS = 60_000 / RPM;
const JOBS = 4;

describe("SCANFIX-D8 · bootstrapWorker installs the engine pacing on capture.execute", () => {
  let queueFixture: ValkeyFixture;
  let cacheValkey: StartedValkey;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    [queueFixture, cacheValkey] = await Promise.all([startValkeyFixture(), startValkey()]);
    calls.at.length = 0;
    applyFakeApiEnv();
    process.env.QUEUE_REDIS_URL = queueFixture.connectionString;
    process.env.VALKEY_CACHE_URL = cacheValkey.url;
    process.env.WORKER_GROUP = "capture";
    process.env.GEMINI_REQUESTS_PER_MINUTE = String(RPM);
    process.env.NODE_ENV = "test";
  }, 60_000);

  afterEach(async () => {
    process.env = { ...originalEnv };
    await Promise.all([queueFixture.stop(), cacheValkey.stop()]);
  });

  it("SCANFIX-D8a · jobs for gemini reach the handler no closer together than GEMINI_REQUESTS_PER_MINUTE allows, through the worker the BOOT built", async () => {
    const { bootstrapWorker } = await import("../../src/worker.js");
    const app = await bootstrapWorker();
    const env = loadEnv();
    const connection = createQueueWorkerConnection(queueFixture.connectionString);
    const producer = new QueueProducer(connection, queueKeyPrefix(env.NODE_ENV), signingKeysFromEnv(env));
    try {
      const workspaceId = randomUUID();
      for (let i = 0; i < JOBS; i += 1) {
        await producer.enqueueTenantJob(
          "capture.execute",
          workspaceId,
          { projectId: randomUUID(), runId: randomUUID(), promptId: randomUUID(), engineKey: "gemini", sampleIndex: i },
          { idempotencyKey: `boot-pace-${String(i)}`, priorityVariant: "interactive" },
        );
      }
      await waitFor(() => calls.at.length >= JOBS, { timeoutMs: JOBS * GAP_MS + 8_000, label: "all paced jobs to reach the handler" });

      expect(calls.at).toHaveLength(JOBS);
      // Without the lease the concurrent worker would hand all four to the handler at once.
      for (let i = 0; i < calls.at.length; i += 1) {
        for (let j = i + 1; j < calls.at.length; j += 1) {
          expect(calls.at[j]! - calls.at[i]!, `call ${String(j)} vs call ${String(i)}`).toBeGreaterThanOrEqual((j - i) * GAP_MS * 0.85);
        }
      }
    } finally {
      await producer.onModuleDestroy();
      connection.disconnect();
      await app.close();
    }
  }, 60_000);
});

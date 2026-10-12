import { Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CaptureFailureError } from "../../src/lib/engines/failure-taxonomy.js";
import { captureEngineLeaseOptions } from "../../src/lib/engines/engine-lease.js";
import { TokenBucket } from "../../src/lib/engines/token-bucket.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { buildQueue, enqueueJob } from "../../src/lib/queue/queue-factory.js";
import { QUEUE_TOPOLOGY } from "../../src/lib/queue/topology.js";
import { buildWorker } from "../../src/lib/queue/worker-factory.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";
import { TEST_SIGNING_KEYS, fakeClient, jobDataFor, waitFor } from "../support/queue-test-harness.js";

// SCANFIX D3 — the 2026-10-12 incident, replayed against a fake Gemini: 51 cells
// dispatched at once, the free-tier key allowing 10 requests a minute. Unpaced,
// every cell hit the vendor together, 429'd, and spent all five of its attempts.
//
// REAL Valkey, REAL BullMQ, the REAL worker factory with the lease the worker
// process wires (`captureEngineLeaseOptions`); only the vendor is fake. The rate
// is scaled up (120 per minute = one request per 500 ms) so the proof takes
// seconds, not minutes; the arithmetic is the same.

const ENTRY = QUEUE_TOPOLOGY.find((e) => e.name === "capture.execute")!;
const RPM = 120;
const GAP_MS = 60_000 / RPM;
const CELLS = 8;
const FIRST_N_RATE_LIMITED = 3;
const RETRY_AFTER_MS = 1_000;

describe("SCANFIX-D3 · cells for an engine are paced to GEMINI_REQUESTS_PER_MINUTE and a 429 completes slowly instead of failing", () => {
  let queueFixture: ValkeyFixture;
  let cacheFixture: ValkeyFixture;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    [queueFixture, cacheFixture] = await Promise.all([startValkeyFixture(), startValkeyFixture()]);
  }, 60_000);

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  afterAll(async () => {
    await queueFixture.stop();
    await cacheFixture.stop();
  });

  it("SCANFIX-D3u · N cells against a 429ing gemini all complete within the paced budget, and no two calls are closer than the configured rate allows", async () => {
    const producerConnection = createQueueWorkerConnection(queueFixture.connectionString);
    const workerConnection = createQueueWorkerConnection(queueFixture.connectionString);
    const cacheRedis = createQueueWorkerConnection(cacheFixture.connectionString);
    const prefix = queueKeyPrefix("scanfix-pacing-1");
    const queue = buildQueue(ENTRY, { connection: producerConnection, prefix });

    const calls: number[] = [];
    const done = new Set<string>();
    let failedJobs = 0;

    // The fake vendor: the first three requests are rate-limited with Retry-After,
    // everything after that answers. It records WHEN it was asked.
    const fakeGemini = (): void => {
      calls.push(Date.now());
      if (calls.length <= FIRST_N_RATE_LIMITED) {
        throw new CaptureFailureError("rate_limited", "gemini", undefined, { retryAfterMs: RETRY_AFTER_MS });
      }
    };

    const worker: Worker = buildWorker(ENTRY, {
      connection: workerConnection,
      prefix,
      keys: TEST_SIGNING_KEYS,
      getClient: () => fakeClient(),
      process: (_tx, job) => {
        fakeGemini();
        done.add(String(job.id));
        return Promise.resolve();
      },
      engineLease: captureEngineLeaseOptions({ ENGINE_TOKEN_BUCKETS: "{}", GEMINI_REQUESTS_PER_MINUTE: RPM }, new TokenBucket(cacheRedis)),
    });
    worker.on("failed", () => {
      failedJobs += 1;
    });

    cleanups.push(async () => {
      await worker.close();
      await queue.close();
      await producerConnection.quit().catch(() => undefined);
      await workerConnection.quit().catch(() => undefined);
      await cacheRedis.quit().catch(() => undefined);
    });

    const startedAt = Date.now();
    for (let i = 0; i < CELLS; i += 1) {
      await enqueueJob(queue, ENTRY, jobDataFor(ENTRY, { engineKey: "gemini", promptId: `p${String(i)}` }), {
        idempotencyKey: `pace-${String(i)}`,
        priorityVariant: "interactive",
      });
    }

    // The budget: every request (cells + the 429'd retries) needs its own token,
    // plus the Retry-After the vendor demanded, plus slack for delayed-job polling.
    const budgetMs = (CELLS + FIRST_N_RATE_LIMITED) * GAP_MS + RETRY_AFTER_MS + 6_000;
    await waitFor(() => done.size === CELLS, { timeoutMs: budgetMs, label: "all paced cells to complete" });
    const elapsedMs = Date.now() - startedAt;

    expect(failedJobs).toBe(0); // a 429 is a deferral, never a failure, never a spent attempt
    expect(done.size).toBe(CELLS);
    expect(calls).toHaveLength(CELLS + FIRST_N_RATE_LIMITED);
    // It really was slow: the vendor was never asked for more than the rate allows.
    expect(elapsedMs).toBeGreaterThanOrEqual((calls.length - 1) * GAP_MS * 0.85);
    // NEVER EXCEED THE RATE: with a one-token bucket, call j can be no earlier than
    // (j - i) refill intervals after call i, for every pair. 15% for scheduler jitter.
    for (let i = 0; i < calls.length; i += 1) {
      for (let j = i + 1; j < calls.length; j += 1) {
        expect(calls[j]! - calls[i]!).toBeGreaterThanOrEqual((j - i) * GAP_MS * 0.85);
      }
    }
  }, 60_000);

  it("SCANFIX-D3v · the lease options the worker wires resolve the engine from the job payload and refuse a payload with no valid engine", () => {
    const options = captureEngineLeaseOptions({ ENGINE_TOKEN_BUCKETS: "{}", GEMINI_REQUESTS_PER_MINUTE: 10 }, {} as TokenBucket);
    const job = (engineKey: unknown) => ({ data: { payload: { engineKey } } }) as never;
    expect(options.resolveEngineKey(job("gemini"))).toBe("gemini");
    expect(() => options.resolveEngineKey(job("not-an-engine"))).toThrow();
    expect(() => options.resolveEngineKey({ data: {} } as never)).toThrow();
    expect(options.configFor("gemini")).toEqual({ capacity: 1, refillPerSecond: 10 / 60 });
  });
});

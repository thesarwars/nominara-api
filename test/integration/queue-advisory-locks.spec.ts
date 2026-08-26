import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globalQueueLockKey, projectQueueLockKey, withGlobalQueueLock, withProjectQueueLock } from "../../src/lib/queue/locks.js";

// STORY-030 Phase C — system-architecture.md §4: `rollup.metric_daily` is
// "serialised per project by lock", `topic.cluster` is "advisory-locked per
// project", `credit.reconcile` is "advisory-locked" (global). Same
// pg_advisory_xact_lock(hashtextextended(key, 0)) idiom already established
// by oauth.service.ts / email-otp.service.ts / audit-chain.service.ts:
// transaction-scoped, auto-released at COMMIT/ROLLBACK — proven here against
// a REAL Postgres (two separate backend connections; a mocked client cannot
// exercise real lock contention).
//
// Why credit.reconcile needs this lock even though its BullMQ concurrency is
// already 1: BullMQ's `concurrency` option bounds how many jobs ONE Worker
// instance pulls at once — it says nothing about a SECOND Worker instance
// (a second replica of the "rollup" worker-group process, running
// concurrently for horizontal scaling) also listening on the same queue.
// Two replicas each running credit.reconcile at concurrency:1 can still run
// two credit.reconcile jobs at the same instant, one per replica. The
// advisory lock is what makes reconciliation single-flight ACROSS the whole
// fleet, not just within one process — concurrency:1 alone does not reach
// that far.

describe("STORY-030 Phase C · queue advisory locks — per-project and global serialisation", () => {
  let container: StartedPostgreSqlContainer;
  let clientA: Client;
  let clientB: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    clientA = new Client({ connectionString: container.getConnectionUri() });
    clientB = new Client({ connectionString: container.getConnectionUri() });
    await clientA.connect();
    await clientB.connect();
  }, 120_000);

  afterAll(async () => {
    await clientA.end();
    await clientB.end();
    await container.stop();
  });

  interface Tracker {
    inFlight: number;
    peak: number;
  }

  function tracker(): Tracker {
    return { inFlight: 0, peak: 0 };
  }

  async function trackedWork(t: Tracker, holdMs: number): Promise<void> {
    t.inFlight += 1;
    t.peak = Math.max(t.peak, t.inFlight);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    t.inFlight -= 1;
  }

  it("two jobs for the SAME project on rollup.metric_daily never run concurrently", async () => {
    const t = tracker();
    const projectId = "11111111-1111-1111-1111-111111111111";

    async function runOn(client: Client): Promise<void> {
      await client.query("BEGIN");
      await withProjectQueueLock(client, "rollup.metric_daily", projectId, () => trackedWork(t, 150));
      await client.query("COMMIT");
    }

    await Promise.all([runOn(clientA), runOn(clientB)]);

    expect(t.peak).toBe(1);
  });

  it("two jobs for DIFFERENT projects on rollup.metric_daily run concurrently — the lock is per-project, not queue-wide", async () => {
    const t = tracker();

    async function runOn(client: Client, projectId: string): Promise<void> {
      await client.query("BEGIN");
      await withProjectQueueLock(client, "rollup.metric_daily", projectId, () => trackedWork(t, 150));
      await client.query("COMMIT");
    }

    await Promise.all([
      runOn(clientA, "22222222-2222-2222-2222-222222222222"),
      runOn(clientB, "33333333-3333-3333-3333-333333333333"),
    ]);

    expect(t.peak).toBe(2);
  });

  it("two credit.reconcile jobs never run concurrently — the lock is global, with no per-project scope", async () => {
    const t = tracker();

    async function runOn(client: Client): Promise<void> {
      await client.query("BEGIN");
      await withGlobalQueueLock(client, "credit.reconcile", () => trackedWork(t, 150));
      await client.query("COMMIT");
    }

    await Promise.all([runOn(clientA), runOn(clientB)]);

    expect(t.peak).toBe(1);
  });

  it("project and global lock keys never collide with each other or across queues", () => {
    expect(projectQueueLockKey("rollup.metric_daily", "p1")).not.toBe(projectQueueLockKey("topic.cluster", "p1"));
    expect(projectQueueLockKey("rollup.metric_daily", "p1")).not.toBe(globalQueueLockKey("rollup.metric_daily"));
  });
});

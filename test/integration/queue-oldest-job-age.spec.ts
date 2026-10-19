import { Queue } from "bullmq";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createQueueWorkerConnection, queueKeyPrefix } from "../../src/lib/queue/connection.js";
import { oldestWaitingAgeSeconds } from "../../src/lib/queue/queue-age-monitor.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-030 AC8 — against real BullMQ, because which end of the waiting list holds the oldest job, and whether a
// priority job sits in `waiting` or `prioritized`, are properties of the library that a fake would only restate.

describe("STORY-030 AC8 · oldestWaitingAgeSeconds against a real queue", () => {
  let fixture: ValkeyFixture;
  let queue: Queue;
  let n = 0;
  const NOW = 1_800_000_000_000;

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  beforeEach(async () => {
    n += 1;
    queue = new Queue("lookup.execute", { connection: createQueueWorkerConnection(fixture.connectionString), prefix: `${queueKeyPrefix("age")}-${String(n)}` });
  });

  afterAll(async () => {
    await queue.close();
    await fixture.stop();
  });

  it("with priority jobs (the lookup.execute shape) the age is the oldest enqueue time", async () => {
    // Added in the order they would really arrive: a later enqueue has a later timestamp.
    await queue.add("j", { n: 1 }, { priority: 1, timestamp: NOW - 12_000 });
    await queue.add("j", { n: 2 }, { priority: 1, timestamp: NOW - 5_000 });
    await queue.add("j", { n: 3 }, { priority: 1, timestamp: NOW - 1_000 });
    expect(await oldestWaitingAgeSeconds(queue, NOW)).toBe(12);
  });

  it("with plain waiting jobs the head read still finds the oldest", async () => {
    await queue.add("j", { n: 1 }, { timestamp: NOW - 30_000 });
    await queue.add("j", { n: 2 }, { timestamp: NOW - 20_000 });
    await queue.add("j", { n: 3 }, { timestamp: NOW - 2_000 });
    expect(await oldestWaitingAgeSeconds(queue, NOW)).toBe(30);
  });

  it("a delayed job is not waiting and does not count, however old its timestamp", async () => {
    await queue.add("j", { n: 1 }, { delay: 3_600_000, timestamp: NOW - 500_000 });
    expect(await oldestWaitingAgeSeconds(queue, NOW)).toBeNull();
  });

  it("an empty queue is null", async () => {
    expect(await oldestWaitingAgeSeconds(queue, NOW)).toBeNull();
  });
});

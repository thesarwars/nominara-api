import { afterEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  createQueueReaderConnection,
  createQueueWorkerConnection,
  queueKeyPrefix,
} from "../../src/lib/queue/connection.js";
import { DEAD_VALKEY_URL } from "../support/test-valkey.js";

// STORY-121 — one factory served two roles whose requirements are OPPOSITE,
// and the health probe got the wrong one.
//
// A BullMQ WORKER must retry forever: `maxRetriesPerRequest: null` is the
// library's own documented requirement, because without it ioredis abandons a
// blocking command and BullMQ misreports a connection problem as a job
// failure — which would dead-letter a perfectly good payload for an
// infrastructure reason.
//
// A READER needs the opposite. With `maxRetriesPerRequest: null` an
// UNREACHABLE instance produces no error to catch: the command never rejects
// and never resolves. There is nothing to time out and nothing to log. That is
// how `/health/ready` came to HANG rather than fail — confirmed end to end in
// docker compose, where the container sat unhealthy with no HTTP response at
// all.
//
// A port nothing listens on, chosen the same way the STORY-022 breaker
// scenario picks one: connection refused fast, never a black hole.
const DEAD_ADDRESS = DEAD_VALKEY_URL;

describe("STORY-121 · the queue connection's two roles", () => {
  const open: Redis[] = [];

  afterEach(() => {
    for (const connection of open.splice(0)) connection.disconnect();
  });

  function track(connection: Redis): Redis {
    open.push(connection);
    return connection;
  }

  // THE DEFECT. Without a bounded retry budget this does not fail with a wrong
  // answer — it never settles, and the test dies on vitest's own timeout
  // rather than on an assertion.
  it("a READER against an unreachable instance rejects, bounded, rather than hanging", async () => {
    const reader = track(createQueueReaderConnection(DEAD_ADDRESS));

    const startedAt = process.hrtime.bigint();
    await expect(reader.get("probe"), "an unreachable queue instance must produce an ERROR").rejects.toThrow();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(elapsedMs, "and it must do so quickly enough for a probe to answer").toBeLessThan(5_000);
  }, 15_000);

  // The other half, and it must not be "fixed" along with the first: bounding
  // a worker's budget would trade a silent hang for BullMQ dead-lettering good
  // payloads whenever the connection wobbles.
  it("a WORKER keeps BullMQ's required forever-retry", () => {
    const worker = track(createQueueWorkerConnection(DEAD_ADDRESS));
    expect(worker.options.maxRetriesPerRequest, "BullMQ requires exactly null here").toBeNull();
  });

  it("a READER does not, which is the whole difference between them", () => {
    const reader = track(createQueueReaderConnection(DEAD_ADDRESS));
    expect(reader.options.maxRetriesPerRequest).not.toBeNull();
  });

  // The prefix is unchanged by this story and is asserted so a refactor of the
  // module cannot quietly move it.
  it("the queue key prefix still namespaces by environment", () => {
    expect(queueKeyPrefix("production")).toBe("nominara-queue-production");
    expect(queueKeyPrefix("test")).not.toBe(queueKeyPrefix("production"));
  });
});

import { Logger } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachDeadLetterHandler, dlqEntrySchema, dlqQueueName, recordDeadLetter } from "../../../src/lib/queue/dead-letter.js";
import { QUEUE_TOPOLOGY } from "../../../src/lib/queue/topology.js";
import * as metrics from "../../../src/lib/telemetry/metrics.js";

describe("STORY-030 · dlqQueueName", () => {
  it("derives {queue}.dlq for every documented queue name shape", () => {
    expect(dlqQueueName("capture.execute")).toBe("capture.execute.dlq");
    expect(dlqQueueName("deploy.cms")).toBe("deploy.cms.dlq");
  });
});

describe("STORY-030 · dlqEntrySchema", () => {
  const validEntry = {
    queue: "capture.execute",
    jobId: "1",
    payload: { workspaceId: "018bcfe5-0000-7000-8000-000000000001" },
    error: { name: "Error", message: "boom", stack: "Error: boom\n    at x" },
    attemptsMade: 5,
    failedAt: new Date().toISOString(),
  };

  it("accepts a well-formed dead-letter entry, payload preserved byte-identical", () => {
    const parsed = dlqEntrySchema.parse(validEntry);
    expect(parsed.payload).toEqual(validEntry.payload);
  });

  it("rejects an entry with an unexpected top-level field (.strict())", () => {
    expect(() => dlqEntrySchema.parse({ ...validEntry, extra: "nope" })).toThrow();
  });

  it("rejects an entry missing the error message", () => {
    const { error, ...rest } = validEntry;
    expect(() => dlqEntrySchema.parse({ ...rest, error: { name: error.name } })).toThrow();
  });
});

// Code-review fix (post Phase B) — attachDeadLetterHandler's terminal-failure
// write is fire-and-forget; a rejection from dlqQueue.add() itself (a Valkey
// blip, a future dlqEntrySchema.parse() throw, ...) must never be silently
// swallowed — the DLQ is the last line of defense against data loss for a
// terminally-failed job, so a failure to even RECORD that failure must be
// loud (logged + counted), never a quiet unhandled rejection.
describe("STORY-030 · attachDeadLetterHandler — a DLQ write failure is never silently swallowed", () => {
  const entry = QUEUE_TOPOLOGY.find((candidate) => candidate.name === "capture.plan")!;
  let loggerErrorSpy: ReturnType<typeof vi.spyOn>;
  let incrementCounterSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loggerErrorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    incrementCounterSpy = vi.spyOn(metrics, "incrementCounter").mockImplementation(() => undefined);
  });

  afterEach(() => {
    loggerErrorSpy.mockRestore();
    incrementCounterSpy.mockRestore();
  });

  function fakeWorkerAndListeners() {
    const listeners: Array<(job: Job | undefined, error: Error) => void> = [];
    const worker = {
      on: (_event: "failed", listener: (job: Job | undefined, error: Error) => void) => {
        listeners.push(listener);
      },
    };
    return { worker, listeners };
  }

  it("logs at error level (queue, job id, DLQ-write error) and increments a counter when dlqQueue.add() itself rejects", async () => {
    const dlqWriteError = new Error("valkey blip writing the DLQ entry");
    const dlqQueue = { add: vi.fn().mockRejectedValue(dlqWriteError) } as unknown as Queue;
    const { worker, listeners } = fakeWorkerAndListeners();

    attachDeadLetterHandler(worker, dlqQueue, entry);

    const terminalJob = { id: "5", data: { probe: true }, attemptsMade: 4, opts: { attempts: 4 } } as unknown as Job;
    listeners[0]!(terminalJob, new Error("the original job failure — must NOT appear in this log line"));

    // Flush the fire-and-forget promise chain.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loggerErrorSpy).toHaveBeenCalled();
    const loggedText = loggerErrorSpy.mock.calls.map((call: unknown[]) => JSON.stringify(call)).join("\n");
    expect(loggedText).toContain(entry.name);
    expect(loggedText).toContain("5");
    expect(loggedText).toContain(dlqWriteError.message);

    expect(incrementCounterSpy).toHaveBeenCalledWith(
      "nominara_queue_dlq_write_failed_total",
      expect.objectContaining({ queue: entry.name }),
    );
  });

  it("never lets a DLQ write failure escape as an unhandled promise rejection", async () => {
    const dlqQueue = { add: vi.fn().mockRejectedValue(new Error("boom")) } as unknown as Queue;
    const { worker, listeners } = fakeWorkerAndListeners();

    attachDeadLetterHandler(worker, dlqQueue, entry);
    const terminalJob = { id: "9", data: {}, attemptsMade: 1, opts: { attempts: 1 } } as unknown as Job;

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      listeners[0]!(terminalJob, new Error("original"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    expect(unhandled).toHaveLength(0);
  });
});

// STORY-030 Phase C — a job processor's contract is `Promise<T>`, not
// `Promise<T>` guaranteed to reject with an `Error`. BullMQ's own Worker
// passes whatever was thrown straight through to the "failed" listener
// (worker.js's handleFailed reads `err.message` directly, with no
// `instanceof Error` normalization) — so a processor that `throw`s a bare
// string or plain object reaches recordDeadLetter/toDlqEntry exactly as
// thrown. Before this fix, toDlqEntry assumed `error: Error` and read
// `.name`/`.message`/`.stack` off it directly: for a thrown string those are
// all `undefined`, and dlqEntrySchema requires `name`/`message` as non-
// optional strings — so the DLQ write itself threw a ZodError, and the
// terminally-failed job's payload was NEVER recorded anywhere, silently
// dropped except for a confusing "DLQ write failed" log line.
describe("STORY-030 · recordDeadLetter — a non-Error throw still produces a usable DLQ entry", () => {
  const entry = QUEUE_TOPOLOGY.find((candidate) => candidate.name === "capture.plan")!;

  function jobFor(dedupId?: string): Job {
    return {
      id: "42",
      data: { probe: true },
      attemptsMade: 4,
      deduplicationId: dedupId,
    } as unknown as Job;
  }

  it("normalizes a thrown string into a DLQ entry with a real name/message, not \"undefined\"", async () => {
    const added: unknown[] = [];
    const dlqQueue = { add: vi.fn(async (_name: string, data: unknown) => added.push(data)) } as unknown as Queue;

    await recordDeadLetter(dlqQueue, entry, jobFor(), "raw string thrown by the processor" as unknown as Error);

    expect(added).toHaveLength(1);
    const written = dlqEntrySchema.parse(added[0]);
    expect(written.error.message).toBe("raw string thrown by the processor");
    expect(written.error.name).not.toBe("undefined");
    expect(typeof written.error.name).toBe("string");
    expect(written.error.name.length).toBeGreaterThan(0);
  });

  it("normalizes a thrown plain object into a DLQ entry with a stringified message, not \"undefined\"", async () => {
    const added: unknown[] = [];
    const dlqQueue = { add: vi.fn(async (_name: string, data: unknown) => added.push(data)) } as unknown as Queue;

    const thrown = { code: "ENGINE_TIMEOUT", detail: "adapter did not respond" };
    await recordDeadLetter(dlqQueue, entry, jobFor(), thrown as unknown as Error);

    expect(added).toHaveLength(1);
    const written = dlqEntrySchema.parse(added[0]);
    expect(written.error.message).toContain("ENGINE_TIMEOUT");
    expect(written.error.message).not.toBe("undefined");
    expect(typeof written.error.name).toBe("string");
  });

  it("still records a genuine Error exactly as before (no regression)", async () => {
    const added: unknown[] = [];
    const dlqQueue = { add: vi.fn(async (_name: string, data: unknown) => added.push(data)) } as unknown as Queue;

    await recordDeadLetter(dlqQueue, entry, jobFor(), new TypeError("boom"));

    const written = dlqEntrySchema.parse(added[0]);
    expect(written.error.name).toBe("TypeError");
    expect(written.error.message).toBe("boom");
  });
});

import { describe, expect, it, vi } from "vitest";
import { scanStreamCompletedSchema } from "../../../contracts/tools/index.js";
import { ConflictError, IdempotencyConflictError, InsufficientCreditsError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { InMemoryCacheAdapter } from "../../lib/cache/in-memory-cache.adapter.js";
import type { Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { failureFor } from "../../lib/visibility-scan/scan-aggregate.js";
import { writeScanEvent } from "../../lib/visibility-scan/scan-events.js";
import { VisibilityScanService, type ScanAccepted } from "./visibility-scan.service.js";

// STORY-079 review round 1 - the idempotency claim, and the stream's own deadline. The database and the queue are replaced by fakes: what is under
// test is the service's decisions, not Postgres.

const TENANT = { workspaceId: "00000000-0000-7000-8000-000000000001", actorId: "00000000-0000-7000-8000-000000000002" };
const RUN_ID = "00000000-0000-7000-8000-0000000000aa";
const BODY = { brand_name: "Acme", query_text: "best crm" };
const META = { actorType: "user" as const, ip: null, userAgent: null, requestId: "R" };
const DAY_MS = 24 * 60 * 60 * 1000;

const fakeClient = { query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined };
const pool = { connect: async () => fakeClient };
const accepted = (over: Partial<ScanAccepted> = {}): ScanAccepted => ({ runId: RUN_ID, engines: ["perplexity", "chatgpt"], availableAfter: 90, resumed: false, startedAtMs: Date.now(), ...over });

function build(cache: Cache) {
  const tools = { peek: vi.fn(async () => ({ inputs: { engine_keys: ["perplexity"] }, created_at: new Date().toISOString(), status: "running" })) };
  const service = new VisibilityScanService(tools as never, {} as never, {} as never, {} as never, pool as never, cache);
  const start = vi.fn(async () => accepted());
  (service as unknown as { start: unknown }).start = start;
  (service as unknown as { giveBackDailyAllowance: unknown }).giveBackDailyAllowance = vi.fn(async () => undefined);
  return { service, start, tools };
}
const headers = (key: string) => ({ confirmedCredits: "10", idempotencyKey: key });

describe("STORY-079 review - the idempotency claim never lets a charged scan be charged again", () => {
  it("the claim lasts the 24-hour replay window the API specification requires (api-specification.md section 1)", async () => {
    const cache = new InMemoryCacheAdapter();
    const set = vi.spyOn(cache, "set");
    await build(cache).service.accept(TENANT, BODY, headers("k1"), META);
    expect(set.mock.calls.length).toBeGreaterThan(0);
    for (const call of set.mock.calls) expect(call[2]?.ttlMs).toBe(DAY_MS);
  });

  it("a retry 90 minutes later with the same key and body attaches to the original run: no new run, no new charge", async () => {
    let nowMs = Date.now();
    const cache = new InMemoryCacheAdapter(() => nowMs);
    const { service, start } = build(cache);
    await service.accept(TENANT, BODY, headers("k2"), META);
    nowMs += 90 * 60 * 1000;
    const again = await service.accept(TENANT, BODY, headers("k2"), META);
    expect(start).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ runId: RUN_ID, resumed: true });
  });

  it("when the run id cannot be written after the scan was charged, the claim STAYS, the caller still gets the run, and a retry does not start a second one", async () => {
    const cache = new InMemoryCacheAdapter();
    const realSet = cache.set.bind(cache);
    vi.spyOn(cache, "set").mockImplementation(async (key, value, options) => {
      if (!value.startsWith("pending:")) throw new Error("valkey timeout");
      return await realSet(key, value, options);
    });
    const { service, start } = build(cache);
    const first = await service.accept(TENANT, BODY, headers("k3"), META);
    expect(first.runId).toBe(RUN_ID);
    expect(start).toHaveBeenCalledTimes(1);
    await expect(service.accept(TENANT, BODY, headers("k3"), META)).rejects.toBeInstanceOf(ConflictError);
    expect(start).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("a start that itself throws releases the claim, so the caller's retry is a genuine retry", async () => {
    const cache = new InMemoryCacheAdapter();
    const { service, start } = build(cache);
    start.mockRejectedValueOnce(new Error("insufficient"));
    await expect(service.accept(TENANT, BODY, headers("k4"), META)).rejects.toThrow("insufficient");
    await service.accept(TENANT, BODY, headers("k4"), META);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("the same key with a different body is 409 idempotency_conflict, the spec's code", async () => {
    const cache = new InMemoryCacheAdapter();
    const { service } = build(cache);
    await service.accept(TENANT, BODY, headers("k5"), META);
    await expect(service.accept(TENANT, { ...BODY, query_text: "other" }, headers("k5"), META)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("a key in the server's reserved ledger namespace is refused before anything is written", async () => {
    const cache = new InMemoryCacheAdapter();
    const { service, start } = build(cache);
    await expect(service.accept(TENANT, BODY, headers("prompt_activate:x"), META)).rejects.toBeInstanceOf(ValidationFailedError);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("STORY-079 review - the stream's own deadline does not make a money statement it cannot back", () => {
  function sinkOf() {
    const chunks: string[] = [];
    return { chunks, sink: { write: (c: string) => chunks.push(c), end: () => undefined, onClose: () => undefined } };
  }
  const terminal = (chunks: string[]) => {
    const frame = chunks.join("").split("\n\n").find((c) => c.includes("event: scan.completed"));
    return JSON.parse(/^data: (.+)$/m.exec(frame ?? "")![1]!) as Record<string, unknown>;
  };

  it("at the stream deadline with the run still unsettled and nothing landed, the terminal event says it is NOT settled and states no charge figure", async () => {
    const { service } = build(new InMemoryCacheAdapter());
    (service as unknown as { settled: unknown }).settled = vi.fn(async () => undefined);
    const { chunks, sink } = sinkOf();
    await service.stream(TENANT, accepted({ startedAtMs: Date.now() - 10_000 }), sink, { pollMs: 5, partialAfterMs: 50 });
    const done = terminal(chunks);
    expect(scanStreamCompletedSchema.safeParse(done).success).toBe(true);
    expect(done).toMatchObject({ settled: false, deadline_reached: true, credits: { charged: null, refunded: null } });
  });

  it("when the stream itself fails, the terminal event is likewise provisional", async () => {
    const cache = new InMemoryCacheAdapter();
    vi.spyOn(cache, "getMany").mockRejectedValue(new Error("valkey down"));
    const { service } = build(cache);
    const { chunks, sink } = sinkOf();
    await service.stream(TENANT, accepted(), sink, { pollMs: 5, partialAfterMs: 50 });
    expect(terminal(chunks)).toMatchObject({ settled: false, credits: { charged: null, refunded: null } });
  });
});

describe("STORY-079 review round 2", () => {
  it("at the stream deadline an engine that already FAILED keeps its real reason; only a silent engine is deadline_exceeded", async () => {
    const cache = new InMemoryCacheAdapter();
    await writeScanEvent(cache, cacheKeyNamespace(), TENANT.workspaceId, RUN_ID, { kind: "engine_failed", failure: failureFor("perplexity", "engine_spend_ceiling_reached") });
    const { service } = build(cache);
    (service as unknown as { settled: unknown }).settled = vi.fn(async () => undefined);
    const chunks: string[] = [];
    await service.stream(TENANT, accepted({ startedAtMs: Date.now() - 10_000 }), { write: (c: string) => chunks.push(c), end: () => undefined, onClose: () => undefined }, { pollMs: 5, partialAfterMs: 50 });
    const frame = chunks.join("").split("\n\n").find((c) => c.includes("event: scan.completed"));
    const done = JSON.parse(/^data: (.+)$/m.exec(frame ?? "")![1]!) as { engine_failures: { engine: string; code: string }[] };
    expect(done.engine_failures.map((f) => [f.engine, f.code])).toEqual([["perplexity", "engine_spend_ceiling_reached"], ["chatgpt", "deadline_exceeded"]]);
  });

  it("a start whose COMMIT failed after Postgres committed keeps the claim with the run id, so a retry attaches instead of charging again", async () => {
    const cache = new InMemoryCacheAdapter();
    const { service, start } = build(cache);
    start.mockRejectedValueOnce(new Error("connection terminated during COMMIT"));
    (service as unknown as { committedRunFor: unknown }).committedRunFor = vi.fn(async () => RUN_ID);
    await expect(service.accept(TENANT, BODY, headers("k9"), META)).rejects.toThrow("COMMIT");
    const again = await service.accept(TENANT, BODY, headers("k9"), META);
    expect(start).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ runId: RUN_ID, resumed: true });
  });

  it("round 3 - an ambiguous commit still counts as a started scan: its daily allowance is NOT given back", async () => {
    const { service, start } = build(new InMemoryCacheAdapter());
    start.mockRejectedValueOnce(new Error("connection terminated during COMMIT"));
    (service as unknown as { committedRunFor: unknown }).committedRunFor = vi.fn(async () => RUN_ID);
    await expect(service.accept(TENANT, BODY, headers("k10"), META)).rejects.toThrow("COMMIT");
    expect((service as unknown as { giveBackDailyAllowance: ReturnType<typeof vi.fn> }).giveBackDailyAllowance).not.toHaveBeenCalled();
  });

  it("round 3 - a typed refusal (402) is definitive: the database is NOT probed for a 'committed' run, the claim is released and the allowance is given back", async () => {
    const cache = new InMemoryCacheAdapter();
    const { service, start } = build(cache);
    start.mockRejectedValueOnce(new InsufficientCreditsError({ message: "no credits", details: {} } as never));
    const probe = vi.fn(async () => RUN_ID);
    (service as unknown as { committedRunFor: unknown }).committedRunFor = probe;
    await expect(service.accept(TENANT, BODY, headers("k11"), META)).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(probe).not.toHaveBeenCalled();
    expect((service as unknown as { giveBackDailyAllowance: ReturnType<typeof vi.fn> }).giveBackDailyAllowance).toHaveBeenCalledTimes(1);
    // The claim was released: the retry of the same key starts a run.
    await service.accept(TENANT, BODY, headers("k11"), META);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("round 4 - a COMMIT not yet visible to the first probe is found by a retry: the claim is kept and the run attaches", async () => {
    const cache = new InMemoryCacheAdapter();
    const { service, start } = build(cache);
    start.mockRejectedValueOnce(new Error("connection terminated during COMMIT"));
    const probe = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValueOnce(RUN_ID);
    (service as unknown as { committedRunFor: unknown }).committedRunFor = probe;
    await expect(service.accept(TENANT, BODY, headers("k12"), META)).rejects.toThrow("COMMIT");
    expect(probe).toHaveBeenCalledTimes(3);
    const again = await service.accept(TENANT, BODY, headers("k12"), META);
    expect(start).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ runId: RUN_ID, resumed: true });
  });

  it("round 4 - a probe that finds nothing on all 3 attempts releases the claim, so the retry starts a run", async () => {
    const cache = new InMemoryCacheAdapter();
    const { service, start } = build(cache);
    start.mockRejectedValueOnce(new Error("connection reset"));
    const probe = vi.fn(async () => undefined);
    (service as unknown as { committedRunFor: unknown }).committedRunFor = probe;
    await expect(service.accept(TENANT, BODY, headers("k13"), META)).rejects.toThrow("reset");
    expect(probe).toHaveBeenCalledTimes(3);
    await service.accept(TENANT, BODY, headers("k13"), META);
    expect(start).toHaveBeenCalledTimes(2);
  });
});

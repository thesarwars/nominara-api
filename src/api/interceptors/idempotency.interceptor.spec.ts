import { Reflector } from "@nestjs/core";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { from, of, lastValueFrom, throwError } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_REPLAYED_HEADER } from "../../../contracts/common/idempotency.schema.js";
import { InMemoryCacheAdapter } from "../../lib/cache/in-memory-cache.adapter.js";
import { IDEMPOTENT_KEY } from "../decorators/idempotent.decorator.js";
import { DomainError } from "../errors/domain-errors.js";
import { IdempotencyStore } from "../idempotency/store.js";
import { IdempotencyInterceptor } from "./idempotency.interceptor.js";

// STORY-025 T15/T16 — the plan's test rows 1, 2, 3, 4, 5 and 11.
//
// Driven at the interceptor rather than over HTTP, deliberately: the property
// under test is the claim-read-record protocol, and a container plus a full
// ApiModule per test would prove nothing more about it. STORY-024 T12 removed
// a spec that did exactly that to assert string parsing.
//
// Row 11 (cross-tenant collision) IS here rather than deferred, because it is
// the one row where being wrong is a data leak rather than a double charge.

const WS_A = "0192f1a0-0000-7000-8000-00000000000a";
const WS_B = "0192f1a0-0000-7000-8000-00000000000b";

interface Harness {
  interceptor: IdempotencyInterceptor;
  cache: InMemoryCacheAdapter;
  clock: { ms: number };
  header: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const clock = { ms: 1_000_000 };
  const cache = new InMemoryCacheAdapter(() => clock.ms);
  const header = vi.fn();
  const status = vi.fn();
  const interceptor = new IdempotencyInterceptor(new Reflector(), new IdempotencyStore(cache));
  return { interceptor, cache, clock, header, status };
}

function contextFor(options: {
  idempotent?: boolean;
  key?: string;
  workspaceId?: string | null;
  userId?: string;
  url?: string;
  body?: unknown;
  header: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  statusCode?: number;
}): ExecutionContext {
  function handler(): void {}
  if (options.idempotent !== false) {
    Reflect.defineMetadata(IDEMPOTENT_KEY, true, handler);
  }
  class FakeController {}

  const request = {
    headers: options.key === undefined ? {} : { "idempotency-key": options.key },
    method: "POST",
    url: options.url ?? "/v1/things",
    body: options.body ?? { amount: 1 },
    auth:
      options.workspaceId === null
        ? { sub: options.userId ?? "user-1" }
        : { ws: options.workspaceId ?? WS_A, sub: options.userId ?? "user-1" },
  };
  const reply = { header: options.header, status: options.status, statusCode: options.statusCode ?? 201 };

  return {
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ExecutionContext;
}

const handlerReturning = (value: unknown): CallHandler => ({ handle: () => of(value) });

/** The envelope a real request would produce — what AC2 requires a replay to reproduce byte for byte. */
const ORIGINAL_ENVELOPE = {
  data: { id: "thing-1", charged: true },
  meta: { request_id: "req-original", scoring_version: "v1", computed_at: "2026-08-25T09:00:00.000Z" },
};

async function run(
  harness: Harness,
  context: ExecutionContext,
  next: CallHandler,
): Promise<{ body: unknown } | { error: DomainError }> {
  try {
    return { body: await lastValueFrom(await harness.interceptor.intercept(context, next)) };
  } catch (error) {
    return { error: error as DomainError };
  }
}

describe("STORY-025 · IdempotencyInterceptor", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("passes an unmarked route straight through, key or no key", async () => {
    const spy = vi.fn(() => of("plain"));
    const result = await run(
      harness,
      contextFor({ idempotent: false, header: harness.header, status: harness.status }),
      { handle: spy },
    );
    expect(result).toEqual({ body: "plain" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // ---- row 1 -------------------------------------------------------------

  it("row 1 — refuses a marked route with no Idempotency-Key, and does not run the handler", async () => {
    const spy = vi.fn(() => of("ran"));
    const result = await run(harness, contextFor({ header: harness.header, status: harness.status }), {
      handle: spy,
    });

    expect("error" in result && result.error.code).toBe("validation_failed");
    expect(spy, "an unprotected billable request must not execute").not.toHaveBeenCalled();
  });

  it("row 1 — refuses a key longer than the 255-character cap", async () => {
    const result = await run(
      harness,
      contextFor({ key: "k".repeat(256), header: harness.header, status: harness.status }),
      handlerReturning("ran"),
    );
    expect("error" in result && result.error.code).toBe("validation_failed");
  });

  it("refuses an idempotent route reached without a workspace — the record has no key to live under", async () => {
    const result = await run(
      harness,
      contextFor({ key: "k1", workspaceId: null, header: harness.header, status: harness.status }),
      handlerReturning("ran"),
    );
    expect("error" in result && result.error.code).toBe("conflict");
  });

  // ---- row 2 -------------------------------------------------------------

  describe("row 2 — a replay with the same key and body", () => {
    it("returns the ORIGINAL envelope byte for byte and runs the handler exactly once", async () => {
      const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
      const first = await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), {
        handle: spy,
      });
      const second = await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), {
        handle: spy,
      });

      expect(first).toEqual({ body: ORIGINAL_ENVELOPE });
      expect(second).toEqual({ body: ORIGINAL_ENVELOPE });
      expect(JSON.stringify((second as { body: unknown }).body)).toBe(JSON.stringify(ORIGINAL_ENVELOPE));
      expect(spy, "the whole of NFR-API-07: the effect happens once").toHaveBeenCalledTimes(1);
    });

    it("carries Idempotency-Replayed: true on the replay and not on the original (D6)", async () => {
      const context = () => contextFor({ key: "k1", header: harness.header, status: harness.status });
      await run(harness, context(), handlerReturning(ORIGINAL_ENVELOPE));
      expect(harness.header).not.toHaveBeenCalledWith(IDEMPOTENCY_REPLAYED_HEADER, "true");

      await run(harness, context(), handlerReturning(ORIGINAL_ENVELOPE));
      expect(harness.header).toHaveBeenCalledWith(IDEMPOTENCY_REPLAYED_HEADER, "true");
    });

    it("replays the original status code, not the default for the route", async () => {
      await run(
        harness,
        contextFor({ key: "k1", header: harness.header, status: harness.status, statusCode: 202 }),
        handlerReturning(ORIGINAL_ENVELOPE),
      );
      await run(
        harness,
        contextFor({ key: "k1", header: harness.header, status: harness.status, statusCode: 201 }),
        handlerReturning(ORIGINAL_ENVELOPE),
      );
      expect(harness.status).toHaveBeenCalledWith(202);
    });

    it("treats a body whose keys were reordered as the SAME body", async () => {
      // A retry that re-serialises its JSON must be a replay, not a conflict —
      // otherwise the safety of a retry depends on the client's serialiser.
      const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
      await run(
        harness,
        contextFor({ key: "k1", body: { a: 1, b: 2 }, header: harness.header, status: harness.status }),
        { handle: spy },
      );
      const second = await run(
        harness,
        contextFor({ key: "k1", body: { b: 2, a: 1 }, header: harness.header, status: harness.status }),
        { handle: spy },
      );

      expect(second).toEqual({ body: ORIGINAL_ENVELOPE });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ---- row 3 -------------------------------------------------------------

  it("row 3 — the same key with a different body is a 409 idempotency_conflict carrying hashes only", async () => {
    const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
    await run(
      harness,
      contextFor({ key: "k1", body: { amount: 1 }, header: harness.header, status: harness.status }),
      { handle: spy },
    );
    const second = await run(
      harness,
      contextFor({ key: "k1", body: { amount: 999 }, header: harness.header, status: harness.status }),
      { handle: spy },
    );

    expect("error" in second && second.error.code).toBe("idempotency_conflict");
    const details = ("error" in second ? second.error.details : {}) as Record<string, unknown>;
    expect(Object.keys(details).sort()).toEqual(["key_hash", "original_recorded_at", "original_request_hash"]);
    expect(JSON.stringify(details), "a conflict must not echo the original body").not.toContain("amount");
    expect(spy, "the conflicting request must not execute").toHaveBeenCalledTimes(1);
  });

  it("row 3 — a different key on the same body is a new request, not a conflict", async () => {
    const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
    await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), { handle: spy });
    await run(harness, contextFor({ key: "k2", header: harness.header, status: harness.status }), { handle: spy });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // ---- row 4 -------------------------------------------------------------

  it("row 4 — a second request while the first is in flight is refused, and does not execute", async () => {
    // The first request claims the key and then blocks inside its handler.
    // The second must find the claim, recognise it as in-flight, and refuse —
    // rather than find no completed record and execute the effect twice.
    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const spy = vi.fn(() => from(gate.then(() => ORIGINAL_ENVELOPE)));

    const first = run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), {
      handle: spy,
    });
    // Let the first interceptor get past its claim and into the handler.
    // A microtask loop rather than a fixed number of ticks or a sleep: the
    // count depends on how many awaits sit between claim and handle, which is
    // an implementation detail this test should not encode.
    for (let tick = 0; tick < 50 && spy.mock.calls.length === 0; tick++) {
      await Promise.resolve();
    }
    expect(spy, "the first request must be running before the second arrives").toHaveBeenCalledTimes(1);

    const second = await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), {
      handle: spy,
    });

    releaseFirst();
    await first;

    expect("error" in second && second.error.code).toBe("conflict");
    expect(("error" in second ? second.error.details : {}) as Record<string, unknown>).toEqual({
      current_state: "in_flight",
    });
    expect(spy, "the in-flight original must not be executed a second time").toHaveBeenCalledTimes(1);
  });

  // ---- row 5 -------------------------------------------------------------

  it("row 5 — a replay after the 24-hour window is a new request", async () => {
    const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
    await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), { handle: spy });

    harness.clock.ms += 24 * 60 * 60 * 1000;

    await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), { handle: spy });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("row 5 — one millisecond before the window closes it is still a replay", async () => {
    const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
    await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), { handle: spy });

    harness.clock.ms += 24 * 60 * 60 * 1000 - 1;

    await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), { handle: spy });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // ---- row 11 ------------------------------------------------------------

  it("row 11 — two workspaces using the identical key and body never see each other's response", async () => {
    // NFR-API-06. Valkey has no row-level security, so this is decided entirely
    // by the key: if the workspace segment were missing, workspace B would
    // receive workspace A's response envelope.
    const envelopeA = { data: { id: "A" }, meta: {} };
    const envelopeB = { data: { id: "B" }, meta: {} };

    const a = await run(
      harness,
      contextFor({ key: "shared", workspaceId: WS_A, header: harness.header, status: harness.status }),
      handlerReturning(envelopeA),
    );
    const b = await run(
      harness,
      contextFor({ key: "shared", workspaceId: WS_B, header: harness.header, status: harness.status }),
      handlerReturning(envelopeB),
    );

    expect(a).toEqual({ body: envelopeA });
    expect(b, "workspace B must execute its own request, never replay A's").toEqual({ body: envelopeB });
  });

  it("row 11 — two users of ONE workspace using the same key are two requests, not a replay", async () => {
    const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
    await run(
      harness,
      contextFor({ key: "shared", userId: "user-1", header: harness.header, status: harness.status }),
      { handle: spy },
    );
    await run(
      harness,
      contextFor({ key: "shared", userId: "user-2", header: harness.header, status: harness.status }),
      { handle: spy },
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // ---- failure handling --------------------------------------------------

  it("releases the claim when the handler fails, so a retry is not locked out for 24 hours", async () => {
    const failing: CallHandler = { handle: () => throwError(() => new Error("boom")) };
    await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), failing);

    const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
    const retry = await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), {
      handle: spy,
    });

    expect(retry).toEqual({ body: ORIGINAL_ENVELOPE });
    expect(spy, "a failed request leaves nothing worth replaying").toHaveBeenCalledTimes(1);
  });

  it("does not record a response for a failed request", async () => {
    const failing: CallHandler = { handle: () => throwError(() => new Error("boom")) };
    await run(harness, contextFor({ key: "k1", header: harness.header, status: harness.status }), failing);
    expect(harness.header).not.toHaveBeenCalledWith(IDEMPOTENCY_REPLAYED_HEADER, "true");
  });

  it("keys the record by route, so the same key on a different path is a different request", async () => {
    const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
    await run(
      harness,
      contextFor({ key: "k1", url: "/v1/things", header: harness.header, status: harness.status }),
      { handle: spy },
    );
    await run(
      harness,
      contextFor({ key: "k1", url: "/v1/others", header: harness.header, status: harness.status }),
      { handle: spy },
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("ignores the query string when identifying the route", async () => {
    const spy = vi.fn(() => of(ORIGINAL_ENVELOPE));
    await run(
      harness,
      contextFor({ key: "k1", url: "/v1/things?trace=1", header: harness.header, status: harness.status }),
      { handle: spy },
    );
    await run(
      harness,
      contextFor({ key: "k1", url: "/v1/things?trace=2", header: harness.header, status: harness.status }),
      { handle: spy },
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

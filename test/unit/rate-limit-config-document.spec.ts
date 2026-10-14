import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rateLimitConfigSchema,
  rateLimitRouteClassSchema,
  type RateLimitRouteClass,
} from "../../contracts/common/rate-limit.schema.js";
import { RateLimitBuckets, type RateLimitIdentity } from "../../src/api/rate-limit/buckets.js";
import { RATE_LIMIT_DEFAULTS } from "../../src/api/rate-limit/defaults.js";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { rateLimitConfigKey } from "../../src/lib/cache/valkey-keys.js";

// STORY-025 AC10 — "Bucket configuration is data, so a limit change needs no redeploy."
// Plan OQ-5: a Valkey-held document at `{env}:global:ratelimit:config`, read on a short TTL, falling back to the
// committed defaults. The bound on "short" is 15 s (docs-pending/STORY-025-*).
//
// The test this replaces was vacuous: it asserted a FRESH bucket store allowed a first request, which is true of any
// configuration. Every "change takes effect" assertion here is paired with a control that runs the SAME steps without
// the change and gets the other answer.

const ENV = "test";
const REFRESH_BOUND_MS = 15_000;
const IDENTITY = { env: ENV, workspaceId: "0192f1a0-0000-7000-8000-00000000000a", userId: "user-1", ip: "203.0.113.7" };

const writesDefaults = RATE_LIMIT_DEFAULTS.find((entry) => entry.route_class === "writes")!;
const DEFAULT_WRITES_BURST = writesDefaults.burst; // 20 (api-specification.md §12)

/** Tightest burst the envelope allows for `writes` (a tenth of the default's 20); the buckets keep their scopes. */
const TIGHT_WRITES_BURST = DEFAULT_WRITES_BURST / 10;

/** A complete document where `writes` is at the envelope's tightest, every other class untouched. */
function documentWithTightWrites(): string {
  return JSON.stringify(
    RATE_LIMIT_DEFAULTS.map((entry) =>
      entry.route_class === "writes"
        ? {
            route_class: "writes",
            burst: TIGHT_WRITES_BURST,
            buckets: [
              { scope: "user", limit: 6, window: "rolling", window_ms: 60_000 },
              { scope: "workspace", limit: 24, window: "rolling", window_ms: 60_000 },
            ],
          }
        : entry,
    ),
  );
}

/** A schema-valid document where one class is replaced and every other class is the committed default. */
function documentWith(routeClass: string, replacement: unknown): string {
  return JSON.stringify(RATE_LIMIT_DEFAULTS.map((entry) => (entry.route_class === routeClass ? replacement : entry)));
}

/** What a probe drives through `check()`: the class, who is calling, and how far apart the requests are. */
interface Drive {
  readonly routeClass: RateLimitRouteClass;
  readonly identity: RateLimitIdentity;
  readonly stepMs: number;
  readonly requests: number;
}

const WRITES_DRIVE: Drive = { routeClass: "writes", identity: { ...IDENTITY, userId: "u" }, stepMs: 0, requests: 50 };

describe("STORY-025 AC10 · bucket configuration is data", () => {
  let clock: { ms: number };
  let cache: InMemoryCacheAdapter;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = { ms: Date.UTC(2026, 9, 14, 12, 0, 0) };
    cache = new InMemoryCacheAdapter(() => clock.ms);
    warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const subject = (over: Cache = cache): RateLimitBuckets => new RateLimitBuckets(over, RATE_LIMIT_DEFAULTS, () => clock.ms);

  /** How many consecutive requests from one fresh user are allowed before the first refusal, up to `cap`. */
  async function allowedBeforeRefusal(s: RateLimitBuckets, userId: string, cap = 50): Promise<number> {
    for (let i = 0; i < cap; i++) {
      if (!(await s.check("writes", { ...IDENTITY, userId })).allowed) return i;
    }
    return cap;
  }

  async function putDocument(body: string): Promise<void> {
    await cache.set(rateLimitConfigKey(ENV), body, { ttlMs: 86_400_000 });
  }

  it("STORY-025 row 9 · a document written to Valkey changes the limit with no redeploy, within the refresh bound", async () => {
    const s = subject();
    expect(await allowedBeforeRefusal(s, "before"), "control: with no document the code default applies").toBe(DEFAULT_WRITES_BURST);

    await putDocument(documentWithTightWrites());
    clock.ms += REFRESH_BOUND_MS;

    expect(await allowedBeforeRefusal(s, "after"), "the same process, the same steps, a different limit").toBe(TIGHT_WRITES_BURST);
  });

  it("STORY-025 row 9 · control: the same steps WITHOUT the document leave the limit where it was", async () => {
    const s = subject();
    await allowedBeforeRefusal(s, "before");
    clock.ms += REFRESH_BOUND_MS;
    expect(await allowedBeforeRefusal(s, "after")).toBe(DEFAULT_WRITES_BURST);
  });

  it("STORY-025 row 9 · removing the document returns the code defaults, within the bound", async () => {
    await putDocument(documentWithTightWrites());
    const s = subject();
    expect(await allowedBeforeRefusal(s, "tight")).toBe(TIGHT_WRITES_BURST);

    await cache.delete(rateLimitConfigKey(ENV));
    clock.ms += REFRESH_BOUND_MS;
    expect(await allowedBeforeRefusal(s, "restored")).toBe(DEFAULT_WRITES_BURST);
  });

  it("STORY-025 AC10 · a MISSING document is the code defaults, enforced — never unlimited", async () => {
    expect(await allowedBeforeRefusal(subject(), "u")).toBe(DEFAULT_WRITES_BURST);
  });

  /** Enforcement observed through `check()`: how many requests pass, and whether a refusal names a hard cap. */
  async function observe(s: RateLimitBuckets, drive: Drive): Promise<{ allowed: number; refusedByHardCap: boolean }> {
    let allowed = 0;
    let refusedByHardCap = false;
    for (let i = 0; i < drive.requests; i++) {
      const decision = await s.check(drive.routeClass, drive.identity);
      if (decision.allowed) allowed += 1;
      else if (decision.exhausted?.hardCap === true) refusedByHardCap = true;
      clock.ms += drive.stepMs;
    }
    return { allowed, refusedByHardCap };
  }

  const preAuth: RateLimitIdentity = { env: ENV, ip: "203.0.113.7" };
  const userCaller: RateLimitIdentity = { ...IDENTITY, userId: "probe-user" };
  const cappedTiers = RATE_LIMIT_DEFAULTS.find((entry) => entry.route_class === "capture_backed_tools_capped_tiers")!;
  const reads = RATE_LIMIT_DEFAULTS.find((entry) => entry.route_class === "reads")!;
  const writes = RATE_LIMIT_DEFAULTS.find((entry) => entry.route_class === "writes")!;
  const projectRuns = RATE_LIMIT_DEFAULTS.find((entry) => entry.route_class === "project_runs")!;

  // Each schema-valid probe PASSES rateLimitConfigSchema (asserted below). The two numeric ones keep the default bucket
  // set, so ONLY the factor bound can reject them.
  const invalid: Array<[string, string, Drive?]> = [
    ["not JSON", "{not json"],
    ["JSON of the wrong shape", JSON.stringify({ writes: 1 })],
    ["an empty list (every class missing = no limits)", "[]"],
    [
      "a class missing",
      JSON.stringify(RATE_LIMIT_DEFAULTS.filter((entry) => entry.route_class !== "writes")),
    ],
    [
      "a zero limit",
      JSON.stringify(
        RATE_LIMIT_DEFAULTS.map((entry) =>
          entry.route_class === "writes"
            ? { ...entry, buckets: [{ scope: "user", limit: 0, window: "rolling", window_ms: 60_000 }] }
            : entry,
        ),
      ),
    ],
    [
      "an unknown key",
      JSON.stringify(RATE_LIMIT_DEFAULTS.map((entry) => ({ ...entry, unlimited: true }))),
    ],
    [
      "schema-valid, auth with only workspace buckets (pre-auth sign-in unlimited)",
      documentWith("auth", {
        route_class: "auth",
        burst: 5,
        buckets: [{ scope: "workspace", limit: 10, window: "rolling", window_ms: 60_000 }],
      }),
      { routeClass: "auth", identity: preAuth, stepMs: 0, requests: 50 },
    ],
    [
      "schema-valid, project_runs at burst 1e9 / limit 1e9 / window 1 ms (unlimited)",
      documentWith("project_runs", {
        ...projectRuns,
        burst: 1_000_000_000,
        buckets: projectRuns.buckets.map((bucket) => ({ ...bucket, limit: 1_000_000_000, window_ms: 1 })),
      }),
      { routeClass: "project_runs", identity: userCaller, stepMs: 0, requests: 50 },
    ],
    [
      "schema-valid, capped tiers without the utc_day hard cap (daily_limit_reached gone)",
      documentWith("capture_backed_tools_capped_tiers", {
        ...cappedTiers,
        buckets: cappedTiers.buckets.filter((bucket) => bucket.window !== "utc_day"),
      }),
      { routeClass: "capture_backed_tools_capped_tiers", identity: userCaller, stepMs: 61_000, requests: 8 },
    ],
    [
      "schema-valid, reads at limit 1 / window 9e15 ms (effectively zero refill)",
      documentWith("reads", {
        ...reads,
        buckets: reads.buckets.map((bucket) => ({ ...bucket, limit: 1, window_ms: 9_000_000_000_000_000 })),
      }),
      { routeClass: "reads", identity: userCaller, stepMs: 1_000, requests: 200 },
    ],
    [
      "schema-valid, a hard_cap added to a class that has none",
      documentWith("writes", {
        ...writes,
        buckets: writes.buckets.map((bucket) => (bucket.scope === "user" ? { ...bucket, hard_cap: true } : bucket)),
      }),
      { ...WRITES_DRIVE, identity: userCaller },
    ],
  ];

  it("STORY-025 AC10 · the five envelope probes are SCHEMA-VALID, so only the envelope can refuse them", () => {
    const probes = invalid.filter(([name]) => name.startsWith("schema-valid"));
    expect(probes).toHaveLength(5);
    for (const [name, body] of probes) {
      expect(() => rateLimitConfigSchema.parse(JSON.parse(body)), name).not.toThrow();
    }
  });

  it.each(invalid)("STORY-025 AC10 · an INVALID document (%s) falls back to the code defaults, logged, and still limits", async (_name, body, drive = WRITES_DRIVE) => {
    const control = await observe(subject(new InMemoryCacheAdapter(() => clock.ms)), drive);
    clock.ms = Date.UTC(2026, 9, 14, 12, 0, 0);

    await putDocument(body);
    const enforced = await observe(subject(), drive);

    expect(enforced, "the same requests see exactly what the code defaults allow").toEqual(control);
    expect(warn, "the fallback is logged, not silent").toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("rate-limit config");
    expect(logged, "the document body is not echoed into the log").not.toContain("unlimited");
  });

  it("STORY-025 AC10 · an UNREADABLE cache falls back to the code defaults, logged, and still limits", async () => {
    const broken: Cache = {
      get: () => Promise.reject(new Error("valkey down")),
      getMany: (keys) => cache.getMany(keys),
      set: (key, value, options) => cache.set(key, value, options),
      delete: (key) => cache.delete(key),
      deleteIf: (key, expected) => cache.deleteIf(key, expected),
      increment: (key, ttlMs) => cache.increment(key, ttlMs),
      timeToLiveMs: (key) => cache.timeToLiveMs(key),
      consume: (key, bucket) => cache.consume(key, bucket),
    };

    expect(await allowedBeforeRefusal(subject(broken), "u")).toBe(DEFAULT_WRITES_BURST);
    expect(warn).toHaveBeenCalled();
  });

  it("STORY-025 AC10 · the document is read at most once per refresh interval, not on every request", async () => {
    let reads = 0;
    const counting: Cache = {
      get: (key) => {
        reads += 1;
        return cache.get(key);
      },
      getMany: (keys) => cache.getMany(keys),
      set: (key, value, options) => cache.set(key, value, options),
      delete: (key) => cache.delete(key),
      deleteIf: (key, expected) => cache.deleteIf(key, expected),
      increment: (key, ttlMs) => cache.increment(key, ttlMs),
      timeToLiveMs: (key) => cache.timeToLiveMs(key),
      consume: (key, bucket) => cache.consume(key, bucket),
    };
    const s = subject(counting);
    for (let i = 0; i < 10; i++) await s.check("writes", IDENTITY);
    expect(reads).toBe(1);
    clock.ms += REFRESH_BOUND_MS;
    await s.check("writes", IDENTITY);
    expect(reads).toBe(2);
  });

  it("STORY-025 AC10 · the document the loader accepts is exactly the contract's rateLimitConfigSchema", () => {
    expect(() => rateLimitConfigSchema.parse(JSON.parse(documentWithTightWrites()))).not.toThrow();
    expect(rateLimitRouteClassSchema.options).toHaveLength(13);
  });
});

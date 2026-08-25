import { describe, expect, it } from "vitest";
import {
  rateLimitConfigSchema,
  rateLimitRouteClassSchema,
} from "../../contracts/common/rate-limit.schema.js";
import { RateLimitBuckets, msUntilUtcMidnight, utcDayStamp } from "../../src/api/rate-limit/buckets.js";
import { RATE_LIMIT_DEFAULTS } from "../../src/api/rate-limit/defaults.js";
import { defaultRouteClass } from "../../src/api/rate-limit/route-class.js";
import type { Cache } from "../../src/lib/cache/cache.port.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";

// STORY-025 T15/T17 — the plan's test rows 6, 7, 9 and 10, plus the
// transcription check coding-standards.md §11 asks for: "numeric constants
// match the reference exactly — not a plausible neighbour."

const IDENTITY = {
  env: "test",
  workspaceId: "0192f1a0-0000-7000-8000-00000000000a",
  userId: "user-1",
  ip: "203.0.113.7",
};

function buckets(config = RATE_LIMIT_DEFAULTS, clock = { ms: Date.UTC(2026, 7, 25, 12, 0, 0) }): {
  subject: RateLimitBuckets;
  clock: { ms: number };
} {
  const cache = new InMemoryCacheAdapter(() => clock.ms);
  return { subject: new RateLimitBuckets(cache, config, () => clock.ms), clock };
}

// ---- the transcription --------------------------------------------------

describe("STORY-025 · §12 transcribed exactly", () => {
  it("defines every one of the thirteen route classes, once each", () => {
    expect(RATE_LIMIT_DEFAULTS).toHaveLength(13);
    expect(RATE_LIMIT_DEFAULTS.map((entry) => entry.route_class).sort()).toEqual(
      [...rateLimitRouteClassSchema.options].sort(),
    );
  });

  it("satisfies its own contract", () => {
    expect(rateLimitConfigSchema.safeParse(RATE_LIMIT_DEFAULTS).success).toBe(true);
  });

  // Read straight off api-specification.md §12's table. If one of these ever
  // disagrees with the reference, the reference is right.
  it.each([
    ["auth", "user", 10, 60_000],
    ["auth", "ip", 30, 60_000],
    ["reads", "user", 300, 60_000],
    ["reads", "workspace", 1_200, 60_000],
    ["writes", "user", 60, 60_000],
    ["writes", "workspace", 240, 60_000],
    ["capture_backed_tools", "workspace", 20, 60_000],
    ["project_runs", "user", 6, 3_600_000],
    ["project_runs", "workspace", 30, 3_600_000],
    ["project_aux_audits", "user", 10, 3_600_000],
    ["project_aux_audits", "workspace", 60, 3_600_000],
    ["geo_alignment", "user", 30, 3_600_000],
    ["geo_alignment", "workspace", 120, 3_600_000],
    ["command_parse", "user", 120, 60_000],
    ["command_execute", "user", 20, 60_000],
    ["command_execute", "workspace", 60, 60_000],
    ["credit_pack_purchase", "user", 5, 3_600_000],
    ["credit_pack_purchase", "workspace", 10, 3_600_000],
    ["portal_session", "ip", 10, 3_600_000],
    ["public_niche_reports", "ip", 120, 3_600_000],
  ])("%s / %s is %i per %i ms", (routeClass, scope, limit, windowMs) => {
    const entry = RATE_LIMIT_DEFAULTS.find((candidate) => candidate.route_class === routeClass)!;
    const bucket = entry.buckets.find((candidate) => candidate.scope === scope && candidate.limit === limit);
    expect(bucket, `${routeClass}/${scope} at ${String(limit)} is missing`).toBeDefined();
    expect(bucket!.window_ms).toBe(windowMs);
  });

  it.each([
    ["auth", 5],
    ["reads", 60],
    ["writes", 20],
    ["capture_backed_tools", 2],
    ["capture_backed_tools_capped_tiers", 1],
    ["project_runs", 2],
    ["project_aux_audits", 3],
    ["geo_alignment", 5],
    ["command_parse", 30],
    ["command_execute", 5],
    ["credit_pack_purchase", 2],
    ["portal_session", 2],
    ["public_niche_reports", 1],
  ])("%s bursts at %i", (routeClass, burst) => {
    expect(RATE_LIMIT_DEFAULTS.find((entry) => entry.route_class === routeClass)!.burst).toBe(burst);
  });

  it("carries the two capture-backed daily buckets §12 lists alongside the per-minute ones", () => {
    // "5/min, 40/day" — a per-scope slot would have silently kept one.
    const tools = RATE_LIMIT_DEFAULTS.find((entry) => entry.route_class === "capture_backed_tools")!;
    const userBuckets = tools.buckets.filter((bucket) => bucket.scope === "user");
    expect(userBuckets.map((bucket) => bucket.limit).sort((a, b) => a - b)).toEqual([5, 40]);
  });

  it("marks exactly one bucket in the whole table a hard cap — §12's 3/UTC-day", () => {
    const hardCaps = RATE_LIMIT_DEFAULTS.flatMap((entry) =>
      entry.buckets.filter((bucket) => bucket.hard_cap).map((bucket) => ({ entry: entry.route_class, bucket })),
    );
    expect(hardCaps).toHaveLength(1);
    expect(hardCaps[0]!.entry).toBe("capture_backed_tools_capped_tiers");
    expect(hardCaps[0]!.bucket.limit).toBe(3);
    expect(hardCaps[0]!.bucket.window).toBe("utc_day");
  });
});

// ---- classification -----------------------------------------------------

describe("STORY-025 · the default route class", () => {
  it("puts /auth/* under auth even though those routes are POSTs", () => {
    // Method-first would file sign-in under Writes at 60/min per user rather
    // than 10/min — six times the reference, on the surface most worth
    // limiting.
    expect(defaultRouteClass("POST", "/v1/auth/otp/request")).toBe("auth");
    expect(defaultRouteClass("GET", "/v1/auth/oauth/google/callback")).toBe("auth");
  });

  it("classes a GET as a read and everything else as a write", () => {
    expect(defaultRouteClass("GET", "/v1/workspaces")).toBe("reads");
    expect(defaultRouteClass("POST", "/v1/workspaces")).toBe("writes");
    expect(defaultRouteClass("PATCH", "/v1/workspaces/x")).toBe("writes");
    expect(defaultRouteClass("DELETE", "/v1/members/x")).toBe("writes");
  });

  it("treats HEAD and OPTIONS as writes — §12 does not name them, and the conservative reading is the safe one", () => {
    expect(defaultRouteClass("HEAD", "/v1/workspaces")).toBe("writes");
    expect(defaultRouteClass("OPTIONS", "/v1/workspaces")).toBe("writes");
  });
});

// ---- rows 6, 7, 9, 10 ---------------------------------------------------

describe("STORY-025 · additive evaluation", () => {
  const ONE_PER_MINUTE = rateLimitConfigSchema.parse(
    rateLimitRouteClassSchema.options.map((routeClass) => ({
      route_class: routeClass,
      burst: 2,
      buckets: [
        { scope: "user", limit: 2, window: "rolling", window_ms: 60_000 },
        { scope: "workspace", limit: 4, window: "rolling", window_ms: 60_000 },
      ],
    })),
  );

  it("row 6 — exhausting the per-user bucket refuses, and says when to retry", async () => {
    const { subject } = buckets(ONE_PER_MINUTE);
    await subject.check("writes", IDENTITY);
    await subject.check("writes", IDENTITY);
    const refused = await subject.check("writes", IDENTITY);

    expect(refused.allowed).toBe(false);
    expect(refused.exhausted?.scope).toBe("user");
    expect(refused.resetAfterMs, "a refusal with no interval tells a client nothing").toBeGreaterThan(0);
  });

  it("row 7 — a FRESH user is still refused once the workspace bucket is exhausted", async () => {
    // Additivity. Without the workspace bucket, one tenant could saturate
    // shared capacity by spreading traffic across users.
    const { subject } = buckets(ONE_PER_MINUTE);
    for (const userId of ["u1", "u2"]) {
      await subject.check("writes", { ...IDENTITY, userId });
      await subject.check("writes", { ...IDENTITY, userId });
    }

    const fresh = await subject.check("writes", { ...IDENTITY, userId: "u3" });
    expect(fresh.allowed).toBe(false);
    expect(fresh.exhausted?.scope).toBe("workspace");
  });

  it("does not spend a later bucket for a request an earlier one already refused", async () => {
    // Charging every bucket for a request that was refused anyway would let
    // one user's excess drain everyone else's capacity — an abuse control that
    // amplifies abuse.
    //
    // Asserted by counting which KEYS were consumed, not by watching a second
    // caller's outcome: with one Burst per row (see the note on the UTC cap
    // below) the two buckets share a capacity, so an interaction test here
    // would be measuring that reading rather than the short-circuit.
    const consumed: string[] = [];
    const clock = { ms: Date.UTC(2026, 7, 25, 12, 0, 0) };
    const inner = new InMemoryCacheAdapter(() => clock.ms);
    const counting: Cache = {
      get: (key) => inner.get(key),
      set: (key, value, options) => inner.set(key, value, options),
      delete: (key) => inner.delete(key),
      increment: (key, ttlMs) => inner.increment(key, ttlMs),
      timeToLiveMs: (key) => inner.timeToLiveMs(key),
      consume: (key, bucket) => {
        consumed.push(key);
        return inner.consume(key, bucket);
      },
    };
    const subject = new RateLimitBuckets(counting, ONE_PER_MINUTE, () => clock.ms);

    await subject.check("writes", IDENTITY);
    await subject.check("writes", IDENTITY);
    const beforeRefusal = consumed.length;

    const refused = await subject.check("writes", IDENTITY);
    expect(refused.allowed).toBe(false);
    expect(refused.exhausted?.scope).toBe("user");

    const afterRefusal = consumed.slice(beforeRefusal);
    expect(afterRefusal, "the refusal must consume the user bucket and stop").toHaveLength(1);
    expect(afterRefusal[0]).toContain(":user:");
    expect(afterRefusal.some((key) => key.includes(":workspace:"))).toBe(false);
  });

  it("row 9 — a changed limit takes effect with no restart", async () => {
    const { subject: strict } = buckets(ONE_PER_MINUTE);
    await strict.check("writes", IDENTITY);
    await strict.check("writes", IDENTITY);
    expect((await strict.check("writes", IDENTITY)).allowed).toBe(false);

    const relaxed = rateLimitConfigSchema.parse(
      ONE_PER_MINUTE.map((entry) => ({ ...entry, burst: 10, buckets: entry.buckets.map((b) => ({ ...b, limit: 100 })) })),
    );
    const { subject: loosened } = buckets(relaxed);
    expect((await loosened.check("writes", IDENTITY)).allowed).toBe(true);
  });

  it("row 10 — an allowed request reports the TIGHTEST applicable bucket, so a client paces itself against the real constraint", async () => {
    const { subject } = buckets(ONE_PER_MINUTE);
    const first = await subject.check("writes", IDENTITY);
    expect(first.allowed).toBe(true);
    // user 2/min is tighter than workspace 4/min.
    expect(first.limit).toBe(2);
  });

  it("counts two workspaces separately", async () => {
    const { subject } = buckets(ONE_PER_MINUTE);
    for (let i = 0; i < 4; i++) await subject.check("writes", IDENTITY);
    const other = await subject.check("writes", { ...IDENTITY, workspaceId: "0192f1a0-0000-7000-8000-00000000000b" });
    expect(other.allowed).toBe(true);
  });

  it("refuses a route class it has no configuration for, rather than allowing it", async () => {
    const partial = [RATE_LIMIT_DEFAULTS[0]!];
    const { subject } = buckets(partial);
    await expect(subject.check("writes", IDENTITY)).rejects.toThrow(/no configuration/);
  });
});

// ---- the calendar cap ---------------------------------------------------

describe("STORY-025 · the UTC-day hard cap", () => {
  it("resets at midnight rather than on a rolling window", () => {
    const noon = Date.UTC(2026, 7, 25, 12, 0, 0);
    expect(msUntilUtcMidnight(noon)).toBe(12 * 60 * 60 * 1000);
    expect(utcDayStamp(noon)).toBe("2026-08-25");
    expect(utcDayStamp(noon + 12 * 60 * 60 * 1000)).toBe("2026-08-26");
  });

  // AMBIGUITY IN §12, IMPLEMENTED LITERALLY AND FLAGGED RATHER THAN RESOLVED.
  // The capped-tier row carries ONE Burst (1) alongside buckets whose windows
  // are a minute, a day and an hour. Read literally — burst is the capacity of
  // every bucket in the row — the workspace "3/day" bucket holds one token and
  // refills one per eight hours, so the tightest applicable bucket is 1 per 8h
  // and the 3/UTC-day cap is never the binding constraint. That may be exactly
  // what a capped tier should feel like, or the Burst column may be meant for
  // the minute-scale buckets only. §12 does not say. This test asserts what the
  // literal reading produces; the question goes on the hand-carried list.
  it("under the literal reading of §12, the 3/day workspace bucket binds before the daily cap", async () => {
    const { subject, clock } = buckets(RATE_LIMIT_DEFAULTS);
    const capped = "capture_backed_tools_capped_tiers" as const;

    expect((await subject.check(capped, IDENTITY)).allowed).toBe(true);
    clock.ms += 61_000;
    const second = await subject.check(capped, IDENTITY);
    expect(second.allowed).toBe(false);
    expect(second.exhausted?.scope, "the workspace daily bucket, not the per-minute one").toBe("workspace");
  });

  it("allows exactly the cap across a day once the slower buckets have refilled, then frees it at midnight", async () => {
    const { subject, clock } = buckets(RATE_LIMIT_DEFAULTS);
    const capped = "capture_backed_tools_capped_tiers" as const;
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;

    // Start just after midnight so three eight-hourly calls fit inside one UTC
    // day, which is what makes the cap — rather than a refill — the thing that
    // refuses the fourth.
    clock.ms = Date.UTC(2026, 7, 25, 0, 0, 1);
    const allowed: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      allowed.push((await subject.check(capped, IDENTITY)).allowed);
      clock.ms += EIGHT_HOURS;
    }
    expect(allowed).toEqual([true, true, true]);

    // The fourth is inside the same UTC day and hits the hard cap.
    clock.ms = Date.UTC(2026, 7, 25, 23, 59, 0);
    const fourth = await subject.check(capped, IDENTITY);
    expect(fourth.allowed).toBe(false);
    expect(fourth.exhausted?.hardCap).toBe(true);

    // Midnight frees the WHOLE allowance at once, not gradually.
    clock.ms = Date.UTC(2026, 7, 26, 0, 0, 1);
    expect((await subject.check(capped, IDENTITY)).allowed).toBe(true);
  });

  it("names a hard-cap refusal as such, so the guard can render the right remediation", async () => {
    const { subject, clock } = buckets(RATE_LIMIT_DEFAULTS);
    const capped = "capture_backed_tools_capped_tiers" as const;
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;

    clock.ms = Date.UTC(2026, 7, 25, 0, 0, 1);
    for (let i = 0; i < 3; i++) {
      await subject.check(capped, IDENTITY);
      clock.ms += EIGHT_HOURS;
    }
    clock.ms = Date.UTC(2026, 7, 25, 23, 59, 0);

    const refused = await subject.check(capped, IDENTITY);
    expect(refused.allowed).toBe(false);
    expect(refused.exhausted?.hardCap, "a hard cap is not liftable by buying credits").toBe(true);
  });
});

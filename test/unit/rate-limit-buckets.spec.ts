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
  it("defines every one of the fourteen route classes, once each", () => {
    expect(RATE_LIMIT_DEFAULTS).toHaveLength(14);
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
    // STORY-184 — copied from the credit-pack purchase class (owner decision 2026-10-16).
    ["plan_change", "user", 5, 3_600_000],
    ["plan_change", "workspace", 10, 3_600_000],
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
    ["plan_change", 2],
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
      getMany: (keys) => inner.getMany(keys),
      set: (key, value, options) => inner.set(key, value, options),
      delete: (key) => inner.delete(key),
      deleteIf: (key, expected) => inner.deleteIf(key, expected),
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

  // ROW 9 / AC10 — a change to the Valkey-held document taking effect — is asserted in
  // test/unit/rate-limit-config-document.spec.ts, each case paired with a control. This one asserts the narrower
  // property that configuration is injected rather than reached for.
  it("takes its limits from injected configuration, not from a module-level constant", async () => {
    const strict = rateLimitConfigSchema.parse(
      rateLimitRouteClassSchema.options.map((routeClass) => ({
        route_class: routeClass,
        burst: 1,
        buckets: [{ scope: "user", limit: 1, window: "rolling", window_ms: 60_000 }],
      })),
    );
    const { subject } = buckets(strict);

    expect((await subject.check("writes", IDENTITY)).allowed).toBe(true);
    expect(
      (await subject.check("writes", IDENTITY)).allowed,
      "the injected limit, not RATE_LIMIT_DEFAULTS, must be what refuses",
    ).toBe(false);
  });

  it("row 10 — an allowed request reports the TIGHTEST applicable bucket, so a client paces itself against the real constraint", async () => {
    const { subject } = buckets(ONE_PER_MINUTE);
    const first = await subject.check("writes", IDENTITY);
    expect(first.allowed).toBe(true);
    // user 2/min is tighter than workspace 4/min.
    // Tokens, not the window rate — the two must be in one unit or a client
    // cannot subtract them. The tightest bucket here is the user one, and its
    // capacity is the class burst.
    expect(first.limit).toBe(2);
    expect(first.applied).toBe(true);
  });

  it("counts two workspaces separately on a WORKSPACE-scoped bucket", async () => {
    const workspaceOnly = rateLimitConfigSchema.parse(
      rateLimitRouteClassSchema.options.map((routeClass) => ({
        route_class: routeClass,
        burst: 2,
        buckets: [{ scope: "workspace" as const, limit: 2, window: "rolling" as const, window_ms: 60_000 }],
      })),
    );
    const { subject } = buckets(workspaceOnly);
    for (let i = 0; i < 3; i++) await subject.check("writes", IDENTITY);

    const other = await subject.check("writes", { ...IDENTITY, workspaceId: "0192f1a0-0000-7000-8000-00000000000b" });
    expect(other.allowed).toBe(true);
  });

  it("does NOT give one user a fresh per-user allowance in each workspace", async () => {
    // §12 says "60/min per user". Keyed under the workspace it became 60/min
    // per user PER WORKSPACE — and workspace creation is self-serve, so the
    // limit was multipliable at will by exactly the person it exists to limit.
    // Found by the dangerous-area audit.
    const { subject } = buckets(ONE_PER_MINUTE);
    await subject.check("writes", IDENTITY);
    await subject.check("writes", IDENTITY);

    const elsewhere = await subject.check("writes", {
      ...IDENTITY,
      workspaceId: "0192f1a0-0000-7000-8000-00000000000b",
    });
    expect(elsewhere.allowed, "a second workspace must not reset a per-user limit").toBe(false);
    expect(elsewhere.exhausted?.scope).toBe("user");
  });

  it("does NOT give one user a fresh allowance by dropping their workspace claim", async () => {
    // WorkspaceGuard permits `req.auth.ws === null`, so this is a reachable
    // token state rather than an edge case — and it used to be a third bucket.
    const { subject } = buckets(ONE_PER_MINUTE);
    await subject.check("writes", IDENTITY);
    await subject.check("writes", IDENTITY);

    const unscoped = await subject.check("writes", { env: "test", userId: IDENTITY.userId, ip: IDENTITY.ip });
    expect(unscoped.allowed).toBe(false);
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

  it("allows exactly the cap in a day, then frees the whole allowance at midnight", async () => {
    // ISOLATED from §12's real numbers deliberately. Under the literal reading
    // recorded in §12 — one Burst per row, applied to every bucket in it — the
    // capped tier's workspace `3/day` bucket holds ONE token and refills one
    // per eight hours, so within a single UTC day it permits three calls and
    // the cap can never be the binding constraint. That is asserted separately
    // above. This test is about the CAP's own behaviour, so the rolling bucket
    // beside it is generous and the cap is the only thing that can refuse.
    const generousRolling = rateLimitConfigSchema.parse(
      rateLimitRouteClassSchema.options.map((routeClass) => ({
        route_class: routeClass,
        burst: 50,
        buckets: [
          { scope: "user", limit: 1_000, window: "rolling", window_ms: 60_000 },
          { scope: "user", limit: 3, window: "utc_day", hard_cap: true },
        ],
      })),
    );
    const { subject, clock } = buckets(generousRolling);
    clock.ms = Date.UTC(2026, 7, 25, 6, 0, 0);

    const allowed: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      allowed.push((await subject.check("capture_backed_tools_capped_tiers", IDENTITY)).allowed);
    }
    expect(allowed).toEqual([true, true, true, false]);

    const refused = await subject.check("capture_backed_tools_capped_tiers", IDENTITY);
    expect(refused.exhausted?.hardCap, "a hard cap is not liftable by buying credits").toBe(true);

    // Midnight frees the WHOLE allowance at once, not gradually — which is the
    // difference between a calendar cap and a token bucket, and the reason the
    // day stamp is part of the key rather than a scheduled expiry.
    clock.ms = Date.UTC(2026, 7, 26, 0, 0, 1);
    expect((await subject.check("capture_backed_tools_capped_tiers", IDENTITY)).allowed).toBe(true);
  });

  it("does NOT spend the hard cap on a request a rolling bucket refused", async () => {
    // Found by the dangerous-area audit. Evaluated in §12's table order the cap
    // came BEFORE the workspace bucket, so a request the workspace bucket
    // refused had already burned a unit of a daily allowance that is, by
    // definition, not liftable by buying credits. The customer lost the
    // allowance with no remedy, for a request that never ran.
    const { subject, clock } = buckets(RATE_LIMIT_DEFAULTS);
    const capped = "capture_backed_tools_capped_tiers" as const;
    clock.ms = Date.UTC(2026, 7, 25, 0, 0, 1);

    // First call succeeds and spends one of the three.
    expect((await subject.check(capped, IDENTITY)).allowed).toBe(true);

    // Second call a minute later: the per-minute bucket has refilled, the
    // workspace 3/day bucket has not. It must be refused WITHOUT touching the
    // cap.
    clock.ms += 61_000;
    const refused = await subject.check(capped, IDENTITY);
    expect(refused.allowed).toBe(false);
    expect(refused.exhausted?.hardCap, "a rolling refusal is not a hard cap").toBe(false);

    // Nine hours on, the rolling buckets have capacity again — and the cap must
    // still have two of its three left, not one.
    clock.ms += 9 * 60 * 60 * 1000;
    expect((await subject.check(capped, IDENTITY)).allowed).toBe(true);
    clock.ms += 9 * 60 * 60 * 1000;
    expect((await subject.check(capped, IDENTITY)).allowed, "the refused request must not have cost a unit").toBe(true);
  });

});

// ---- unauthenticated traffic --------------------------------------------

describe("STORY-025 · the three §12 rows whose callers have no workspace", () => {
  const ANONYMOUS = { env: "test", ip: "203.0.113.7" };

  it("limits sign-in by IP even though there is no workspace or user", async () => {
    // The defect this replaced: an authenticated-only guard returned true for
    // every pre-authentication request, so `/auth/*` — the row §12 gives the
    // tightest numbers in the whole table — was completely unlimited.
    const { subject } = buckets();
    const outcomes: boolean[] = [];
    for (let i = 0; i < 7; i++) {
      outcomes.push((await subject.check("auth", ANONYMOUS)).allowed);
    }
    // auth bursts at 5 and the IP bucket is 30/min, so the sixth is refused.
    expect(outcomes.filter(Boolean)).toHaveLength(5);
    expect(outcomes[5]).toBe(false);
  });

  it("names the IP bucket as the one that refused", async () => {
    const { subject } = buckets();
    for (let i = 0; i < 5; i++) await subject.check("auth", ANONYMOUS);
    const refused = await subject.check("auth", ANONYMOUS);
    expect(refused.exhausted?.scope).toBe("ip");
  });

  it("counts two addresses separately", async () => {
    const { subject } = buckets();
    for (let i = 0; i < 6; i++) await subject.check("auth", ANONYMOUS);
    const other = await subject.check("auth", { ...ANONYMOUS, ip: "198.51.100.2" });
    expect(other.allowed).toBe(true);
  });

  it("SKIPS the user bucket rather than counting every anonymous caller against one key", async () => {
    // Falling back to a shared placeholder identity would let any one
    // unauthenticated caller exhaust the per-user limit for all of them.
    const consumed: string[] = [];
    const clock = { ms: Date.UTC(2026, 7, 25, 12, 0, 0) };
    const inner = new InMemoryCacheAdapter(() => clock.ms);
    const counting: Cache = {
      get: (key) => inner.get(key),
      getMany: (keys) => inner.getMany(keys),
      set: (key, value, options) => inner.set(key, value, options),
      delete: (key) => inner.delete(key),
      deleteIf: (key, expected) => inner.deleteIf(key, expected),
      increment: (key, ttlMs) => inner.increment(key, ttlMs),
      timeToLiveMs: (key) => inner.timeToLiveMs(key),
      consume: (key, bucket) => {
        consumed.push(key);
        return inner.consume(key, bucket);
      },
    };

    await new RateLimitBuckets(counting, RATE_LIMIT_DEFAULTS, () => clock.ms).check("auth", ANONYMOUS);

    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toContain(":ip:");
    expect(consumed.some((key) => key.includes(":user:"))).toBe(false);
  });

  it("keys an anonymous bucket globally, never under a workspace", async () => {
    const consumed: string[] = [];
    const inner = new InMemoryCacheAdapter();
    const counting: Cache = {
      get: (key) => inner.get(key),
      getMany: (keys) => inner.getMany(keys),
      set: (key, value, options) => inner.set(key, value, options),
      delete: (key) => inner.delete(key),
      deleteIf: (key, expected) => inner.deleteIf(key, expected),
      increment: (key, ttlMs) => inner.increment(key, ttlMs),
      timeToLiveMs: (key) => inner.timeToLiveMs(key),
      consume: (key, bucket) => {
        consumed.push(key);
        return inner.consume(key, bucket);
      },
    };

    await new RateLimitBuckets(counting).check("public_niche_reports", ANONYMOUS);

    // `{env}:global:…` — pre-authentication traffic is not attributable to a
    // tenant, so it must not sit under one.
    expect(consumed[0]).toBe("test:global:ratelimit:public_niche_reports:ip:r3600000:203.0.113.7");
  });
});

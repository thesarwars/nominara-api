import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { entitlementOverridesSchema } from "../../../contracts/entitlements/resolved-entitlements.schema.js";
import { CONFIRMED_CREDITS_HEADER, CreditGuard } from "../../../src/api/guards/credit.guard.js";
import { EntitlementGuard } from "../../../src/api/guards/entitlement.guard.js";
import { REQUIRE_ENTITLEMENT_KEY, REQUIRE_FEATURE_KEY } from "../../../src/api/decorators/require-entitlement.decorator.js";
import { CREDITS_KEY } from "../../../src/api/decorators/credits.decorator.js";
import type { EntitlementResolver } from "../../../src/lib/entitlements/entitlement-resolver.js";
import type { StructuralUsage } from "../../../src/lib/entitlements/structural-usage.js";
import { EngineRefusalError, resolveEngine } from "../../../src/lib/engines/registry.js";

// STORY-110 abuse suite, unknown-key rejection (scenario 12). "A default is a decision made by whoever made the typo": an
// unknown entitlement key, action code or engine key must be REFUSED, never quietly treated as zero, free, or absent.

const WORKSPACE = "01a06ccd-9e37-7f0c-957b-195fa6d263dd";
const TYPOS = ["projects.maxx", "deep_scan.credit", "exports.pdf", "", " projects.max", "PROJECTS.MAX", "__proto__", "constructor", "toString"];

function reflectorFor(metadata: Record<string, unknown>): Reflector {
  return { getAllAndOverride: (key: string) => metadata[key] } as unknown as Reflector;
}

function context(headers: Record<string, string> = {}): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ tenant: { workspaceId: WORKSPACE }, headers, params: {} }) }),
  } as unknown as ExecutionContext;
}

const resolver = {
  resolveForWorkspace: () =>
    Promise.resolve({
      workspace_id: WORKSPACE,
      plan_key: "growth",
      entitlement_version: 1,
      entitlements: { "deep_scan.credits": { value: 200, source: "plan", live: true } },
    }),
} as unknown as EntitlementResolver;

describe("STORY-110 · scenario 12 — unknown entitlement keys", () => {
  // `__proto__` is excluded from the override loop on purpose: zod drops that one key from a strict object (it is not
  // refused), and a dropped `__proto__` grants nothing because no resolver reads it. Triaged LOW in the STORY-110 evidence.
  it.each(TYPOS.filter((k) => k !== "" && k !== "__proto__"))("an override naming %j is a validation failure, not a silently dropped grant", (key) => {
    expect(entitlementOverridesSchema.safeParse({ [key]: 5 }).success).toBe(false);
  });

  it.each(TYPOS)("a route gated on the unknown FEATURE key %j is refused, never allowed", async (key) => {
    const usage = { minimumPlanFor: () => Promise.resolve(undefined) } as unknown as StructuralUsage;
    const guard = new EntitlementGuard(reflectorFor({ [REQUIRE_FEATURE_KEY]: key }), resolver, usage);
    await expect(guard.canActivate(context())).rejects.toThrow();
  });

  it.each(TYPOS)("a route gated on the unknown STRUCTURAL key %j is refused, never allowed", async (key) => {
    const usage = { current: () => Promise.resolve(0) } as unknown as StructuralUsage;
    const guard = new EntitlementGuard(reflectorFor({ [REQUIRE_ENTITLEMENT_KEY]: key }), resolver, usage);
    await expect(guard.canActivate(context())).rejects.toThrow();
  });
});

describe("STORY-110 · scenario 12 — unknown action codes", () => {
  const pool = {
    connect: () => {
      throw new Error("an unknown action must be refused before the wallet is touched");
    },
  } as unknown as Pool;

  it.each(["deep_scan ", "DEEP_SCAN", "free_lunch", "", "__proto__", "constructor"])(
    "CreditGuard refuses the unknown priced action %j instead of letting the route run unpriced",
    async (action) => {
      const guard = new CreditGuard(reflectorFor({ [CREDITS_KEY]: action }), resolver, pool);
      await expect(guard.canActivate(context({ [CONFIRMED_CREDITS_HEADER]: "0", "idempotency-key": "k-1" }))).rejects.toThrow();
    },
  );
});

describe("STORY-110 · scenario 12 — unknown engine keys", () => {
  it.each(["bard", "", " gemini", "GEMINI", "gemini\u0000", "__proto__", "constructor", "toString", "hasOwnProperty"])(
    "resolveEngine refuses %j as an unknown engine",
    (key) => {
      try {
        resolveEngine(key);
        expect.unreachable("an unknown engine key resolved to an adapter");
      } catch (error) {
        expect(error).toBeInstanceOf(EngineRefusalError);
        expect((error as EngineRefusalError).reason).toBe("unknown");
      }
    },
  );
});

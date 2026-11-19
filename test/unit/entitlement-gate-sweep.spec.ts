import "reflect-metadata";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { REQUIRE_FEATURE_KEY } from "../../src/api/decorators/require-entitlement.decorator.js";
import { FeatureNotInPlanError } from "../../src/api/errors/domain-errors.js";
import { EntitlementGuard } from "../../src/api/guards/entitlement.guard.js";
import { PLAN_ENTITLEMENTS } from "../../src/db/seed/plan-entitlements.js";
import { DEEP_SCAN_PRICE_KEY } from "../../src/lib/capture/deep-scan-price.js";
import { AUX_AUDITS_ENTITLEMENT } from "../../src/lib/aux/onboarding-audit.js";
import { entitlementGranted } from "../../src/lib/entitlements/granted.js";
import { isFeatureGranted } from "../../src/lib/entitlements/classification.js";
import { METRIC_SPECS } from "../../src/lib/usage/metrics.js";
import { featureNotInPlanDetailsSchema } from "../../contracts/common/error-details.schema.js";

// STORY-087 AC25 - "an entitlement gate is never hidden and never a generic error after the click". The API's half: a plan-gated action called without the entitlement
// answers `403 feature_not_in_plan` carrying `details.{key, min_plan}`, where `min_plan` is the LOWEST plan that really grants the key - never a generic 403/500, never
// a missing or placeholder plan - so the client's EntitlementGate can name the plan that unlocks it.
//
// THREE SWEEPS, because a gate lives in three places:
//   1. every route declaring `@RequireFeature` (EntitlementGuard) - exercised through the REAL guard against every plan that lacks the feature;
//   2. every gate a service enforces itself (AUX full audit, manual deep scan, multi-sample drift, CSV exports, usage-metric features) - each key must be one a public
//      plan grants, because those sites fall back to `min_plan: "unknown"` when none does, which tells the customer nothing;
//   3. an inventory of every `new FeatureNotInPlanError(` site, so a NEW gate cannot ship outside sweeps 1 and 2 unnoticed.

const TIER_ORDER = ["free", "starter", "growth", "business", "enterprise"] as const;
type Tier = (typeof TIER_ORDER)[number];

/** The lowest tier whose seeded value for `key` the given predicate grants - what `plans ORDER BY sort_order` + the predicate answer in production. */
function lowestGranting(key: string, granted: (value: never) => boolean): Tier | undefined {
  return TIER_ORDER.find((tier) => granted((PLAN_ENTITLEMENTS[tier][key]?.value ?? null) as never));
}

async function controllers(): Promise<{ name: string; cls: new (...args: never[]) => object }[]> {
  const modulesDir = fileURLToPath(new URL("../../src/modules", import.meta.url));
  const files = (readdirSync(modulesDir, { recursive: true }) as string[]).filter((entry) => entry.endsWith(".controller.ts")).sort();
  const found: { name: string; cls: new (...args: never[]) => object }[] = [];
  for (const file of files) {
    const module = (await import(pathToFileURL(resolve(modulesDir, file)).href)) as Record<string, unknown>;
    for (const [name, exported] of Object.entries(module)) {
      if (typeof exported === "function" && Reflect.getMetadata("path", exported) !== undefined) found.push({ name, cls: exported as never });
    }
  }
  return found;
}

interface GatedRoute {
  readonly route: string;
  readonly key: string;
  readonly handler: (...args: unknown[]) => unknown;
  readonly cls: new (...args: never[]) => object;
}

async function featureGatedRoutes(): Promise<GatedRoute[]> {
  const routes: GatedRoute[] = [];
  for (const { name, cls } of await controllers()) {
    const proto = cls.prototype as Record<string, unknown>;
    for (const method of Object.getOwnPropertyNames(proto)) {
      const handler = proto[method];
      if (method === "constructor" || typeof handler !== "function" || Reflect.getMetadata("path", handler) === undefined) continue;
      const key = (Reflect.getMetadata(REQUIRE_FEATURE_KEY, handler) ?? Reflect.getMetadata(REQUIRE_FEATURE_KEY, cls)) as string | undefined;
      if (key !== undefined) routes.push({ route: `${name}.${method}`, key, handler: handler as never, cls });
    }
  }
  return routes;
}

function guardFor(tier: Tier): EntitlementGuard {
  const entitlements = PLAN_ENTITLEMENTS[tier];
  const resolved = { plan_key: tier, entitlements };
  const resolver = { resolve: async () => resolved, resolveForWorkspace: async () => resolved };
  // The production lookup, over the seeded plans in sort order.
  const usage = { minimumPlanFor: async (key: string) => lowestGranting(key, isFeatureGranted as never), current: async () => 0 };
  return new EntitlementGuard(new Reflector(), resolver as never, usage as never);
}

function contextFor(route: GatedRoute): never {
  const request = { tenant: { workspaceId: "00000000-0000-7000-8000-000000000001", actorId: "a" }, params: {} };
  return { getHandler: () => route.handler, getClass: () => route.cls, switchToHttp: () => ({ getRequest: () => request }) } as never;
}

describe("STORY-087 AC25 sweep 1 - every @RequireFeature route", () => {
  it("finds the gated routes at all - a sweep over nothing passes vacuously", async () => {
    const routes = await featureGatedRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(9);
    expect(new Set(routes.map((route) => route.key))).toEqual(new Set(["share_links.enabled", "optimizer.enabled", "integrations.gsc"]));
  });

  it("without the entitlement, each answers feature_not_in_plan naming the key and the LOWEST plan that grants it; with it, the guard lets the request through", async () => {
    const failures: string[] = [];
    for (const route of await featureGatedRoutes()) {
      const unlocks = lowestGranting(route.key, isFeatureGranted as never);
      if (unlocks === undefined) {
        failures.push(`${route.route}: no seeded plan grants ${route.key} - the guard would answer a 500, and no upgrade would help`);
        continue;
      }
      for (const tier of TIER_ORDER) {
        const outcome = await guardFor(tier).canActivate(contextFor(route)).then(
          () => "allowed" as const,
          (error: unknown) => error,
        );
        const holds = isFeatureGranted((PLAN_ENTITLEMENTS[tier][route.key]?.value ?? null) as never);
        if (holds) {
          if (outcome !== "allowed") failures.push(`${route.route}: ${tier} grants ${route.key} but was refused`);
          continue;
        }
        if (!(outcome instanceof FeatureNotInPlanError)) {
          failures.push(`${route.route}: ${tier} lacks ${route.key} and got ${outcome === "allowed" ? "an allow" : String((outcome as Error)?.constructor?.name)}, not feature_not_in_plan`);
          continue;
        }
        const parsed = featureNotInPlanDetailsSchema.safeParse(outcome.details);
        if (!parsed.success) failures.push(`${route.route}: ${tier} - details do not match {key, min_plan}`);
        else if (parsed.data.key !== route.key) failures.push(`${route.route}: ${tier} - details.key is ${parsed.data.key}, expected ${route.key}`);
        else if (parsed.data.min_plan !== unlocks) failures.push(`${route.route}: ${tier} - min_plan is ${parsed.data.min_plan}, the lowest granting plan is ${unlocks}`);
        if (outcome.getStatus() !== 403 || outcome.code !== "feature_not_in_plan") failures.push(`${route.route}: ${tier} - wrong status/code`);
        if (outcome.remediation?.kind !== "upgrade_plan") failures.push(`${route.route}: ${tier} - remediation is not upgrade_plan`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("STORY-087 AC25 sweep 2 - the gates a service enforces itself", () => {
  // Each of these sites builds `min_plan` from a plans query that falls back to "unknown" (or, for exports.csv and auto-top-up, a constant): the answer is only
  // meaningful while some plan grants the key. Keys, not code paths - the sites themselves are covered by the integration specs named beside them.
  const SERVICE_GATES: ReadonlyArray<readonly [key: string, site: string]> = [
    [AUX_AUDITS_ENTITLEMENT, "requireAuxAudits: POST /tools/aux-audit (mode full), GET /tools/aux-audit/estimate, in-project AUX audit (test/integration/aux-audit-tool.spec.ts, aux-manual-audit-http.spec.ts)"],
    [DEEP_SCAN_PRICE_KEY, "deepScanPriceOrThrow: POST /projects/{id}/runs, the run estimate (tracking-run-estimate.spec.ts)"],
    ["drift_sampling.enabled", "ProjectEnginesService: sample_count above 1"],
    ["exports.csv", "ledgerExport and ExportService (billing-ledger-export.spec.ts, report-export-http.spec.ts)"],
    ["exports.pdf_per_cycle", "ExportService / QuotaGuard (quota-guard.spec.ts)"],
  ];

  it.each(SERVICE_GATES)("%s - a public plan grants it, so min_plan is never the \"unknown\" fallback (%s)", (key) => {
    expect(PLAN_ENTITLEMENTS.free[key], `${key} is not in the entitlement matrix`).toBeDefined();
    const lowest = lowestGranting(key, entitlementGranted as never);
    expect(lowest, `no plan grants ${key}: its gate would answer min_plan "unknown"`).toBeDefined();
    // And the plan that unlocks it is above the one that lacks it - a gate every plan passes (or none does) is not a gate.
    expect(TIER_ORDER.some((tier) => !entitlementGranted(PLAN_ENTITLEMENTS[tier][key]?.value ?? null)), `${key} is granted to every plan`).toBe(true);
  });

  it("every customer-facing usage metric with an entitlement key names a key the matrix has and some plan grants", () => {
    for (const [metric, spec] of Object.entries(METRIC_SPECS)) {
      if (spec.entitlementKey === null || !spec.customerFacing) continue;
      expect(PLAN_ENTITLEMENTS.free[spec.entitlementKey], `${metric}: ${spec.entitlementKey} is not in the matrix`).toBeDefined();
      expect(lowestGranting(spec.entitlementKey, isFeatureGranted as never), `${metric}: no plan grants ${spec.entitlementKey}`).toBeDefined();
    }
  });
});

describe("STORY-087 AC25 sweep 3 - no gate ships outside the sweeps", () => {
  // `new FeatureNotInPlanError(` per file under src (not specs). A new site fails this until its author puts the key in sweep 1 or 2 and bumps the count - the
  // decision is the point. Counts, not line numbers.
  const INVENTORY: Readonly<Record<string, number>> = {
    "src/api/guards/entitlement.guard.ts": 1,
    "src/api/guards/quota.guard.ts": 1,
    "src/lib/aux/plan-gate.ts": 1,
    "src/lib/capture/deep-scan-price.ts": 1,
    "src/modules/agency/agency.service.ts": 1,
    "src/modules/billing/billing-addons.service.ts": 1,
    "src/modules/billing/billing.service.ts": 4,
    "src/modules/billing/credit-packs.service.ts": 1,
    "src/modules/projects/project-engines.service.ts": 1,
    "src/modules/reports/export.service.ts": 1,
    "src/modules/reports/scheduled-reports.service.ts": 1,
    "src/modules/tracking/run-estimate.service.ts": 1,
  };

  function sources(dir: string): string[] {
    return (readdirSync(dir, { recursive: true }) as string[])
      .filter((entry) => entry.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(entry))
      .map((entry) => resolve(dir, entry));
  }

  it("matches the inventory exactly, and every site states a min_plan", () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const counts: Record<string, number> = {};
    const withoutPlan: string[] = [];
    for (const file of sources(resolve(root, "src"))) {
      const text = readFileSync(file, "utf8");
      const relative = file.slice(root.length);
      let from = 0;
      for (;;) {
        const at = text.indexOf("new FeatureNotInPlanError(", from);
        if (at < 0) break;
        counts[relative] = (counts[relative] ?? 0) + 1;
        // The constructor call's own argument text: up to the next blank line or 600 characters, whichever is first.
        const window = text.slice(at, at + 600).split(/\n\s*\n/)[0]!;
        if (!window.includes("min_plan")) withoutPlan.push(relative);
        from = at + 1;
      }
    }
    // The error class itself is declared (not constructed) in domain-errors.ts, so it never matches.
    expect(counts).toEqual(INVENTORY);
    expect(withoutPlan, "a gate that does not name the plan that unlocks it").toEqual([]);
  });
});

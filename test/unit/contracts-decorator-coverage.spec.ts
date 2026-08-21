import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HealthController } from "../../src/modules/health/health.controller.js";
import { IdentityController } from "../../src/modules/identity/identity.controller.js";
import { OauthController } from "../../src/modules/identity/oauth.controller.js";
import { discoverRealRoutes, isExemptFromContractCoverage } from "../support/discover-contract-routes.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-023 T2 (RED step) — ADR-0002's coverage gate, which the ADR calls
// "not optional hardening; it is what catches the failure mode this ADR
// cannot design away": a route missing `@ApiContract()` simply vanishes
// from the generated document while the drift check still passes, because
// generation is deterministic over what IS decorated. This file is that
// gate. The actual route walk lives in test/support/discover-contract-
// routes.ts (shared with contracts-openapi-generate.spec.ts's B1 fix and
// contracts-strictness.spec.ts's B4 fix) — never a stand-in list of routes
// that could itself go stale, and never re-implemented per file.
//
// Coordinator's code-review round 2, B2: `Reflector.getAllAndOverride(KEY,
// [handler, controllerClass])` returns the FIRST defined value across its
// targets — a single class-level `@ApiContract()` would satisfy this gate
// for every method on that controller, one operationId and one schema pair
// covering ten routes. `ApiContract` is now typed `MethodDecorator` ONLY
// (src/api/decorators/api-contract.decorator.ts, amended by the
// coordinator), which makes that specific shortcut a type error — but this
// gate does not rely on the type restriction alone: discoverRealRoutes()
// reads `Reflect.getMetadata(API_CONTRACT_KEY, handler)` directly, on the
// METHOD ONLY, never falling back to the class. See B2's own uniqueness
// test below for the second half of that fix.
describe("STORY-023 · @ApiContract() route-coverage gate (ADR-0002) — an undecorated route must fail the build", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // This test is a self-test of the exemption PREDICATE (isExemptFromContractCoverage)
  // against synthetic inputs — it never touches the real ApiModule and can
  // never turn red because of anything task T3 builds. It exists to pin the
  // exemption RULE itself, the same way contracts-strictness.spec.ts's PART A
  // characterizes zod's emission behaviour: true today, and load-bearing for
  // reading every other assertion in this file correctly.
  it("[predicate self-test, permanently green] the exemption predicate excludes ONLY the health probes and /v1/openapi.json — never @Public() alone", () => {
    expect(isExemptFromContractCoverage({ controllerClass: HealthController, fullPath: "health/live" })).toBe(true);
    expect(isExemptFromContractCoverage({ controllerClass: HealthController, fullPath: "health/ready" })).toBe(true);
    expect(isExemptFromContractCoverage({ controllerClass: HealthController, fullPath: "health" })).toBe(true);
    class FakeOpenApiController {}
    expect(isExemptFromContractCoverage({ controllerClass: FakeOpenApiController, fullPath: "openapi.json" })).toBe(
      true,
    );

    // All FIVE @Public() identity/OAuth routes are NOT exempt under this
    // predicate — @Public() alone never grants exemption.
    expect(
      isExemptFromContractCoverage({ controllerClass: IdentityController, fullPath: "auth/passkey/options" }),
    ).toBe(false);
    expect(
      isExemptFromContractCoverage({ controllerClass: IdentityController, fullPath: "auth/passkey/verify" }),
    ).toBe(false);
    expect(isExemptFromContractCoverage({ controllerClass: IdentityController, fullPath: "auth/refresh" })).toBe(
      false,
    );
    expect(
      isExemptFromContractCoverage({ controllerClass: OauthController, fullPath: "auth/oauth/:provider/start" }),
    ).toBe(false);
    expect(
      isExemptFromContractCoverage({ controllerClass: OauthController, fullPath: "auth/oauth/:provider/callback" }),
    ).toBe(false);
  });

  it("every currently-registered non-exempt route in the real ApiModule declares @ApiContract() (method-level metadata only)", async () => {
    const routes = await discoverRealRoutes();
    const nonExempt = routes.filter((route) => !isExemptFromContractCoverage(route));
    // Sanity floor, not a moving target: 21 non-exempt routes exist in the
    // tree today (7 IdentityController + 4 OauthController +
    // 10 WorkspacesController). This floor only ever rises as later
    // stories add routes — it must never fall, which `toBeGreaterThanOrEqual`
    // enforces without needing an update every time a new route lands.
    expect(nonExempt.length).toBeGreaterThanOrEqual(21);

    const undecorated = nonExempt.filter((route) => route.contract === undefined);

    expect(undecorated.map((route) => `${route.controllerName}.${route.methodName} (${route.fullPath})`)).toEqual(
      [],
    );
  });

  // B2, second half — a coverage gate that only checks "some contract is
  // present" cannot distinguish ten routes correctly decorated with ten
  // DISTINCT operationIds from ten routes all carrying a COPY-PASTED
  // operationId (or, before the decorator was narrowed to MethodDecorator,
  // ten routes covered by one class-level decoration reporting the SAME
  // operationId ten times). `operationId` is the generated document's
  // per-route identity (ADR-0002) — a collision means two routes silently
  // collapse into one entry.
  it("every non-exempt route's operationId is unique (guards against one decoration silently covering several routes)", async () => {
    const routes = await discoverRealRoutes();
    const nonExempt = routes.filter((route) => !isExemptFromContractCoverage(route));
    const decorated = nonExempt.filter((route) => route.contract !== undefined);

    const operationIds = decorated.map((route) => route.contract!.operationId);
    const duplicates = operationIds.filter((id, index) => operationIds.indexOf(id) !== index);

    expect(duplicates, `duplicate operationId(s): ${JSON.stringify(duplicates)}`).toEqual([]);
  });

  it("the five @Public() identity/OAuth routes are NOT exempt and must each declare @ApiContract() (identity.controller.ts:30,38,49; oauth.controller.ts:34,57)", async () => {
    const routes = await discoverRealRoutes();
    const publicButContractBearing: Array<{ controllerName: string; methodName: string }> = [
      { controllerName: "IdentityController", methodName: "options" }, // :30 — POST auth/passkey/options
      { controllerName: "IdentityController", methodName: "verify" }, // :38 — POST auth/passkey/verify
      { controllerName: "IdentityController", methodName: "refresh" }, // :49 — POST auth/refresh
      { controllerName: "OauthController", methodName: "start" }, // :34 — POST auth/oauth/:provider/start
      { controllerName: "OauthController", methodName: "callback" }, // :57 — GET auth/oauth/:provider/callback
    ];

    for (const target of publicButContractBearing) {
      const route = routes.find(
        (r) => r.controllerName === target.controllerName && r.methodName === target.methodName,
      );
      expect(route, `${target.controllerName}.${target.methodName} must be a discovered route`).toBeDefined();
      expect(isExemptFromContractCoverage(route!)).toBe(false);

      expect(
        route!.contract !== undefined,
        `${target.controllerName}.${target.methodName} is @Public() but must still declare @ApiContract()`,
      ).toBe(true);
    }
  });

  it("today's baseline — HealthController's 3 probe routes are the only ones the walk finds exempt", async () => {
    const routes = await discoverRealRoutes();
    const exempt = routes.filter((route) => isExemptFromContractCoverage(route));
    expect(exempt.map((route) => route.controllerName)).toEqual([
      "HealthController",
      "HealthController",
      "HealthController",
    ]);
  });
});

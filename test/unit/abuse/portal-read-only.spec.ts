import "reflect-metadata";
import { beforeAll, describe, expect, it } from "vitest";
import { CREDITS_KEY } from "../../../src/api/decorators/credits.decorator.js";
import { IDEMPOTENT_KEY } from "../../../src/api/decorators/idempotent.decorator.js";
import { PORTAL_ROUTE_KEY } from "../../../src/api/decorators/portal-route.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../../src/api/decorators/require-permission.decorator.js";
import { discoverRealRoutes, type DiscoveredRoute } from "../../support/discover-contract-routes.js";
import { applyFakeApiEnv } from "../../support/fake-env.js";

// STORY-110 abuse suite, portal read-only (scenario 13), LAYER 1: the application's route table, read from the metadata
// Nest itself routes by, not from the controllers' source. The other two layers are asserted with the application
// bypassed elsewhere and are listed here so the three-layer claim has one index:
//   layer 2 (transaction): test/integration/portal-context-http.spec.ts  "READ ONLY" (25006) on the portal transaction
//   layer 3 (database):    test/isolation/portal.spec.ts ISO-10          42501 on INSERT/UPDATE/DELETE, every tenant table
// Nest's RequestMethod enum, as stored under the "method" metadata key.
const METHOD_KEY = "method";
const GET = 0;
const MUTATING = new Map<number, string>([[1, "POST"], [2, "PUT"], [3, "DELETE"], [4, "PATCH"]]);
const SESSION_MINT = "portal/session";

describe("STORY-110 · scenario 13 — the portal is read-only in the application's route table", () => {
  let routes: DiscoveredRoute[] = [];
  beforeAll(async () => {
    applyFakeApiEnv();
    routes = await discoverRealRoutes();
  }, 60_000);

  const verbOf = (route: DiscoveredRoute): number => Reflect.getMetadata(METHOD_KEY, route.handler) as number;
  const isPortalRoute = (route: DiscoveredRoute): boolean => Reflect.getMetadata(PORTAL_ROUTE_KEY, route.handler) === true;

  it("the sweep sees the portal routes at all (a vacuous pass is the failure mode of every sweep)", () => {
    expect(routes.filter(isPortalRoute).length).toBeGreaterThanOrEqual(4);
    expect(routes.some((r) => r.fullPath === SESSION_MINT)).toBe(true);
  });

  it("every @PortalRoute handler is a GET", () => {
    const offenders = routes.filter((r) => isPortalRoute(r) && verbOf(r) !== GET).map((r) => `${MUTATING.get(verbOf(r)) ?? String(verbOf(r))} ${r.fullPath}`);
    expect(offenders).toEqual([]);
  });

  it("the only mutating verb under /portal is the session mint, and it is not a @PortalRoute (it is the gate, not a session)", () => {
    const mutating = routes.filter((r) => (r.fullPath === "portal" || r.fullPath.startsWith("portal/")) && MUTATING.has(verbOf(r)));
    expect(mutating.map((r) => `${MUTATING.get(verbOf(r))!} ${r.fullPath}`)).toEqual([`POST ${SESSION_MINT}`]);
    expect(mutating.every((r) => !isPortalRoute(r))).toBe(true);
  });

  it("a portal route carries no permission, credit or idempotency metadata: it has no user, no wallet and nothing to write", () => {
    for (const route of routes.filter(isPortalRoute)) {
      for (const key of [REQUIRE_PERMISSION_KEY, CREDITS_KEY, IDEMPOTENT_KEY]) {
        expect(Reflect.getMetadata(key, route.handler), `${route.fullPath} carries ${key}`).toBeUndefined();
      }
    }
  });
});

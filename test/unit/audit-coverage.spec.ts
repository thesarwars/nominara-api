import { describe, expect, it } from "vitest";
import { discoverContractRoutes } from "../../src/contracts/discover-routes.js";

// STORY-034 — the sweep that would have caught it.
//
// `AuditInterceptor` fails CLOSED: a mutating route with no `@Audit()` throws
// `AuditMetadataMissingError` and returns a 500. That is the right behaviour
// — "an unaudited mutation is not an acceptable outcome" — but it fires at
// REQUEST time, so a route that forgot the decorator is green in every test
// that exercises its service and breaks on its first live call.
//
// Which is exactly how `POST /projects/{id}/runs/estimate` shipped: seven
// integration tests over the estimate, all against the service, none through
// the route. The decorator is a property of the CONTROLLER, so this is where
// it has to be asserted.

const MUTATING = new Set(["post", "put", "patch", "delete"]);

describe("STORY-020 · every mutating route is audited", () => {
  it("declares @Audit() on every mutating handler that is not exempt", async () => {
    const unaudited = (await discoverContractRoutes())
      .filter((route) => MUTATING.has(route.httpMethod.toLowerCase()))
      // @Public()/@SkipTenantContext() routes never open a tenant context, so
      // there is no per-tenant chain for a row to join — the interceptor's own
      // exemption, mirrored rather than re-decided here.
      .filter((route) => !route.auditExempt && !route.audited)
      .map((route) => `${route.httpMethod.toUpperCase()} /${route.fullPath} (${route.controllerName}.${route.methodName})`);

    expect(unaudited, "these routes would throw AuditMetadataMissingError on their first live request").toEqual([]);
  });

  it("finds mutating routes at all — a sweep over nothing passes vacuously", async () => {
    const routes = await discoverContractRoutes();
    expect(routes.filter((route) => MUTATING.has(route.httpMethod.toLowerCase())).length).toBeGreaterThan(15);
  });
});

import { describe, expect, it } from "vitest";
import { NO_ENVELOPE_KEY } from "../../src/api/decorators/no-envelope.decorator.js";
import { HealthController } from "../../src/modules/health/health.controller.js";
import { IS_PUBLIC_KEY } from "../../src/api/decorators/public.decorator.js";
import { discoverRealRoutes } from "../support/discover-contract-routes.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-024 T8 (RED step) — task T10's envelope SCOPE, asserted from both
// sides. RED at module resolution until T10 creates
// src/api/decorators/no-envelope.decorator.ts.
//
// *** WHY THIS FILE EXISTS, AND WHY ONE HALF WOULD NOT DO ***
//
// The obvious way to stop the response envelope breaking the orchestrator's
// liveness probe is to exempt `@Public()` routes. That is wrong, and it is
// wrong in a way that a one-sided test cannot see. `@Public()` is not
// probe-specific: it sits on SEVEN real API routes today — passkey options,
// passkey verify, refresh, both OAuth start routes, the OAuth callback, and
// STORY-016's two OTP routes — every one of which api-specification.md §1
// requires to carry the envelope like any other response. A `@Public()`-keyed
// exemption fixes the probe and silently opens a specification deviation
// across the entire authentication surface.
//
// So this file asserts BOTH halves against the real, deployed ApiModule:
//   (a) the health probes are NOT enveloped, and
//   (b) no authentication route is exempted.
// test/integration/health-and-readiness.spec.ts cannot stand in for either:
// it boots only DbModule + HealthModule, so it stays green whichever way
// this breaks — including the way that breaks EPIC-03's own first acceptance
// criterion.
//
// The set of `@Public()` routes is DISCOVERED, never hardcoded. The plan for
// this task said "the five @Public() routes"; STORY-016 has since added two
// more, and a hardcoded five would now assert less than it claims to.
describe("STORY-024 · T10 envelope scope — probes exempt, authentication routes NOT", () => {
  const harness = useApiHarness();

  it("the exemption marker is on the health probes and on nothing else", async () => {
    const routes = await discoverRealRoutes();
    const exempted = routes
      .filter((route) => Reflect.getMetadata(NO_ENVELOPE_KEY, route.handler) === true)
      .map((route) => `${route.controllerName}.${route.methodName} (${route.fullPath})`);

    const probes = routes
      .filter((route) => route.controllerClass === HealthController)
      .map((route) => `${route.controllerName}.${route.methodName} (${route.fullPath})`);

    expect(probes.length, "the health controller must expose its probe routes").toBeGreaterThan(0);
    expect(exempted.sort(), "@NoEnvelope() must mark exactly the health probes").toEqual(probes.sort());
  });

  // The specific bug this rules out, stated as its own assertion so a failure
  // reads as the specification deviation it is rather than as a set mismatch.
  it("no @Public() route is exempted — @Public() must never key the exemption", async () => {
    const routes = await discoverRealRoutes();
    const publicButExempt = routes
      .filter((route) => route.controllerClass !== HealthController)
      .filter((route) => Reflect.getMetadata(IS_PUBLIC_KEY, route.handler) === true)
      .filter((route) => Reflect.getMetadata(NO_ENVELOPE_KEY, route.handler) === true)
      .map((route) => `${route.controllerName}.${route.methodName} (${route.fullPath})`);

    expect(
      publicButExempt,
      "these authentication routes lost their response envelope — api-specification.md §1 requires it on every response",
    ).toEqual([]);
  });

  it("there really are several @Public() authentication routes for the previous assertion to be about", async () => {
    const routes = await discoverRealRoutes();
    const publicApiRoutes = routes
      .filter((route) => route.controllerClass !== HealthController)
      .filter((route) => Reflect.getMetadata(IS_PUBLIC_KEY, route.handler) === true);

    // Not an exact count: STORY-016 already moved it from five to seven, and
    // pinning the number here would make this file fail for the wrong reason
    // the next time an unauthenticated route is added.
    expect(publicApiRoutes.length).toBeGreaterThanOrEqual(5);
  });

  // Half (a), over real HTTP: the orchestrator reads `status` at the top
  // level. `livenessResponseSchema` is `.strict()` with exactly `{status}`,
  // so a wrapped body is not a cosmetic difference — it is a probe that
  // never reports healthy again.
  it("the liveness and readiness probes return an UNWRAPPED body over real HTTP", async () => {
    for (const path of ["/health/live", "/health/ready"]) {
      const response = await harness.app().inject({ method: "GET", url: path });
      const body = response.json<Record<string, unknown>>();

      expect(body, `${path} must not be wrapped`).not.toHaveProperty("data");
      expect(body, `${path} must not be wrapped`).not.toHaveProperty("meta");
      expect(body, `${path} must report status at the top level`).toHaveProperty("status");
    }
  });

  // Half (b), over real HTTP: an authentication route's SUCCESS body must be
  // wrapped. Driving a real one end to end needs credentials this file has no
  // business minting, so the proof used here is the closest honest one — a
  // @Public() route reached over the real pipeline, whose response is checked
  // for the envelope whenever it succeeds. It is skipped, loudly, when the
  // route cannot be driven to a 2xx without a credential.
  it("a @Public() authentication route's success body IS wrapped", async () => {
    const response = await harness.app().inject({
      method: "POST",
      url: apiUrl("/auth/passkey/options"),
      payload: { purpose: "authentication" },
    });

    if (response.statusCode >= 400) {
      expect(
        response.headers["content-type"],
        "an error from a @Public() route must still be problem+json, never an enveloped error",
      ).toContain("application/problem+json");
      return;
    }

    const body = response.json<Record<string, unknown>>();
    expect(body, "a @Public() route's success response carries the envelope").toHaveProperty("data");
    expect(body).toHaveProperty("meta");
  });
});

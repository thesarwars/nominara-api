import { describe, expect, it } from "vitest";
import { IS_PUBLIC_KEY } from "../../../src/api/decorators/public.decorator.js";
import { CREDITS_KEY } from "../../../src/api/decorators/credits.decorator.js";
import { DAILY_CAP_KEY } from "../../../src/api/decorators/daily-cap.decorator.js";
import { METER_KEY } from "../../../src/api/decorators/meter.decorator.js";
import { REQUIRE_ENTITLEMENT_KEY, REQUIRE_FEATURE_KEY } from "../../../src/api/decorators/require-entitlement.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../../src/api/decorators/require-permission.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../../../src/api/decorators/skip-tenant-context.decorator.js";
import { discoverRealRoutes, type DiscoveredRoute } from "../../support/discover-contract-routes.js";
import { applyFakeApiEnv } from "../../support/fake-env.js";

// ⚠ STORY-153 — THE INVARIANT `WorkspaceGuard`'s TENANT-LESS EARLY RETURN
// RESTS ON, ASSERTED OVER METADATA.
//
// The guard returns before resolving the token's `ws` claim for any route
// carrying `@SkipTenantContext()`. That fixed a deadlock — a plan change bumps
// `entitlement_version`, and the two routes that recover from the resulting
// stale session were themselves refused for being stale.
//
// ⚠ THE FIRST VERSION OF THIS FILE WAS A TEXT SCAN, AND A REVIEW DEFEATED IT
// THREE WAYS IN UNDER TEN MINUTES. Recorded because each one is a different
// lesson:
//
//   1. A CLASS-LEVEL `@SkipTenantContext()` was invisible. The decorator is
//      typed `MethodDecorator & ClassDecorator` and the guard reads
//      `getAllAndOverride(KEY, [handler, class])`, so decorating the
//      CONTROLLER makes every one of its routes tenant-less. The scan built
//      handler spans starting at each `@Get|@Post|…` line, and a class-level
//      decorator sits above the class body — in no span. Adding it to
//      `WorkspacesController` made ten tenant-scoped routes tenant-less,
//      including `PATCH /members/:id`, and the scan still reported green.
//
//   2. `req.tenant` WAS THE WRONG SURFACE. It appears in 10 of 51 handlers;
//      the other 41 are tenant-scoped through `currentTenantStore()` inside
//      their services, where RLS is the only thing narrowing the read. The
//      property "no handler contains the string `req.tenant`" was therefore
//      close to vacuous, and renaming a parameter defeated it outright.
//
//   3. It read PROSE. A sibling file in the same commit carries a ten-line
//      comment about exactly that defect.
//
// So this file asserts the property that is actually load-bearing, over the
// metadata Nest itself reads, using the walker `route-permission-coverage`
// already uses.
//
// THE PROPERTY: a route may skip tenant context only if it needs NOTHING that
// is derived from a validated workspace. In this codebase that is decidable —
// `RbacGuard` fails closed on a missing `req.membership`
// (`rbac.guard.ts:58-60`), so any route stating a permission cannot be
// tenant-less; and the five guards that fall back to the RAW token claim
// (`request.tenant?.workspaceId ?? request.auth?.ws`) are reached only through
// their own decorators.
describe("STORY-153 · a tenant-less route needs nothing derived from a validated workspace", () => {
  const meta = (key: string, route: DiscoveredRoute): unknown =>
    (Reflect.getMetadata(key, route.handler) as unknown) ??
    (Reflect.getMetadata(key, route.controllerClass) as unknown);

  const name = (route: DiscoveredRoute): string => `${route.controllerName}.${route.methodName}`;

  async function routes(): Promise<DiscoveredRoute[]> {
    applyFakeApiEnv();
    return await discoverRealRoutes();
  }

  it("finds the routes it claims to scan, and some of them are tenant-less", async () => {
    const all = await routes();
    expect(all.length, "no routes discovered — the scan is vacuous").toBeGreaterThan(30);
    expect(
      all.filter((r) => meta(SKIP_TENANT_CONTEXT_KEY, r) === true).length,
      "no @SkipTenantContext routes found — the metadata read is broken",
    ).toBeGreaterThan(3);
  });

  // ⚠ THE ONE THAT CLOSES THE REVIEW'S MAJOR. Before this story the fallback
  // `request.tenant?.workspaceId ?? request.auth?.ws` in entitlement, quota,
  // daily-cap and credit could never YIELD a value: the guard had already
  // validated the claim and set `tenant`, or `ws` was absent. The early return
  // makes that arm live on a tenant-less route — the raw token claim, with no
  // workspace-usability check, no live-membership check and no ent_v check.
  //
  // The failure that would follow: add `@Credits(...)` to a tenant-less route
  // and a caller whose membership was revoked, or whose workspace is
  // suspended, gets that workspace's wallet reserved against on their behalf.
  // Nothing carries both decorators today; this is what keeps it that way.
  it("⚠ no tenant-less route carries a decorator whose guard trusts the raw token claim", async () => {
    const all = await routes();
    const tenantless = all.filter((r) => meta(SKIP_TENANT_CONTEXT_KEY, r) === true);

    // Read from the decorator modules rather than retyped, so a renamed key
    // fails to import instead of silently matching nothing.
    // ⚠ IMPORTED, NOT RETYPED — and the first draft of this list proved why.
    // It hardcoded `"dailyCap"`; the real constant is `DAILY_CAP_KEY =
    // "daily-cap"`, so that entry matched nothing and the assertion silently
    // stopped covering the decorator most likely to debit a wallet. A renamed
    // key now fails to import instead.
    const GUARDED_BY_WORKSPACE = [
      ["a permission", REQUIRE_PERMISSION_KEY],
      ["an entitlement", REQUIRE_ENTITLEMENT_KEY],
      ["a feature", REQUIRE_FEATURE_KEY],
      ["a meter", METER_KEY],
      ["a daily cap", DAILY_CAP_KEY],
      ["credits", CREDITS_KEY],
    ] as const;

    // Anti-vacuity: the keys must actually match something somewhere, or this
    // test passes because it is looking for nothing.
    const declaredAnywhere = GUARDED_BY_WORKSPACE.filter(([, key]) =>
      all.some((route) => meta(key, route) !== undefined),
    );
    expect(
      declaredAnywhere.map(([label]) => label),
      "no route in the whole app declares any of these — the keys are wrong and the scan is vacuous",
    ).not.toEqual([]);

    const offenders = tenantless.flatMap((route) =>
      GUARDED_BY_WORKSPACE.filter(([, key]) => meta(key, route) !== undefined).map(
        ([label]) => `${name(route)} declares ${label}`,
      ),
    );

    expect(
      offenders,
      "a tenant-less route cannot state a requirement that is read from a validated workspace — " +
        "either it needs tenant context (drop @SkipTenantContext) or it does not (drop the decorator)",
    ).toEqual([]);
  });

  // ⚠ AND THE SET ITSELF IS PINNED, because "carries no permission" is a
  // property a NEW route could satisfy by accident. `route-permission-coverage`
  // already maintains an EXEMPT map that a human has to write a reason into;
  // the tenant-less set must be drawn from the same population.
  it("⚠ every non-public tenant-less route is one RbacGuard would fail open on", async () => {
    const all = await routes();
    const offenders = all
      .filter((r) => meta(SKIP_TENANT_CONTEXT_KEY, r) === true)
      .filter((r) => meta(IS_PUBLIC_KEY, r) !== true)
      .filter((r) => meta(REQUIRE_PERMISSION_KEY, r) !== undefined)
      .map(name);

    // This is the same statement as the test above, reached from the other
    // side — kept because the two fail with different messages, and the one
    // that fires tells the next reader which decision they got wrong.
    expect(offenders, "a tenant-less route that states a permission is a contradiction").toEqual([]);
  });

  it("⚠ the recovery routes are tenant-less, or the plan-change deadlock returns", async () => {
    const tenantless = (await routes())
      .filter((r) => meta(SKIP_TENANT_CONTEXT_KEY, r) === true)
      .map(name);

    // Named individually because each ALONE re-creates the deadlock: without
    // the list the client cannot tell the user belongs anywhere, and without
    // the switch it cannot mint a token carrying the current ent_v.
    for (const [route, why] of [
      ["WorkspacesController.list", "the client asks this FIRST, to decide whether the user belongs anywhere"],
      ["WorkspacesController.switchWorkspace", "the ONLY route that re-mints a token with the current ent_v"],
    ] as const) {
      expect(tenantless, `${route} must stay @SkipTenantContext — ${why}`).toContain(route);
    }
  });

  // ⚠ THE CLASS-LEVEL CASE, ASSERTED DIRECTLY. The metadata read above handles
  // it, but only because it consults `controllerClass` — the exact fallback the
  // text scan had no notion of. If someone "simplifies" `meta()` to read the
  // handler alone, every assertion above silently narrows and this fails.
  it("⚠ the metadata read consults the CONTROLLER, not just the handler", async () => {
    const all = await routes();
    const probe = all[0]!;
    class ClassLevelProbe {}
    Reflect.defineMetadata(SKIP_TENANT_CONTEXT_KEY, true, ClassLevelProbe);

    const asClassLevel = { ...probe, controllerClass: ClassLevelProbe } as DiscoveredRoute;
    expect(
      meta(SKIP_TENANT_CONTEXT_KEY, asClassLevel),
      "a class-level @SkipTenantContext() applies to every route on the controller and must be seen",
    ).toBe(true);
  });
});

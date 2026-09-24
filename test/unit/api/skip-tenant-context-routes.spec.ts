import { describe, expect, it } from "vitest";
import { IDEMPOTENT_KEY } from "../../../src/api/decorators/idempotent.decorator.js";
import { IS_PUBLIC_KEY } from "../../../src/api/decorators/public.decorator.js";
import { CREDITS_KEY } from "../../../src/api/decorators/credits.decorator.js";
import { DAILY_CAP_KEY } from "../../../src/api/decorators/daily-cap.decorator.js";
import { METER_KEY } from "../../../src/api/decorators/meter.decorator.js";
import { REQUIRE_ENTITLEMENT_KEY, REQUIRE_FEATURE_KEY } from "../../../src/api/decorators/require-entitlement.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../../src/api/decorators/require-permission.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../../../src/api/decorators/skip-tenant-context.decorator.js";
import { executionContextForSocket } from "../../../src/gateway/ws-execution-context.js";
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
      // ⚠ A SEVENTH, FOUND BY REVIEW AGAINST THIS LIST'S OWN CRITERION.
      // `idempotency.interceptor.ts:100` resolves `request.auth?.ws` — the raw
      // claim, never `req.tenant` — and writes the record under a
      // tenant-scoped cache key. Before this story that claim had been
      // validated by WorkspaceGuard before any interceptor ran. A tenant-less
      // @Idempotent() route would let a caller removed from W read and write
      // idempotency records in W's namespace. Lower severity than a wallet
      // debit, but `idempotency/key.ts:69` records that @Idempotent() and
      // @Credits("deep_scan") travel together on POST /v1/projects/:id/runs,
      // so they arrive as a pair.
      //
      // RATE_LIMIT_CLASS_KEY also reaches `auth.ws` and is deliberately NOT
      // here: it always used the raw claim, its default class applies with or
      // without the decorator, and it refuses rather than grants.
      ["idempotency", IDEMPOTENT_KEY],
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

  // ⚠ THE REVERSE DIRECTION, WHICH WAS COMPLETELY UNPINNED.
  //
  // Everything above says "tenant-less ⇒ no forbidden decorator". Nothing said
  // "this route must STAY tenant-less", beyond the two recovery routes named
  // below. A review removed `@SkipTenantContext()` from `GET /me/passkeys` and
  // ran the whole unit suite: 2418 passed.
  //
  // That regression is STORY-153's own lockout shape one notch narrower. A user
  // with a stale `ent_v` after any plan change — or whose sole workspace is
  // suspended — could no longer list or manage their own passkeys or OAuth
  // links. Those are credentials belonging to a PERSON, not a workspace, and
  // they are exactly what an account-recovery flow reaches for.
  //
  // The nine mutating tenant-less routes are protected only INCIDENTALLY:
  // `audit-coverage.spec.ts` keys its audit exemption on
  // `@Public()`/`@SkipTenantContext()`, so dropping the decorator makes them
  // demand `@Audit()`. That is an accident of a different gate and it covers
  // no GET — which is why both routes the review broke are GETs.
  //
  // THE RULE, over metadata rather than another spec's hand-written list: a
  // route that is not public and states no permission is one `RbacGuard` fails
  // OPEN on (`rbac.guard.ts:45-50` returns true for want of metadata). Such a
  // route has no workspace-derived authority to lose, and must therefore be
  // tenant-less — otherwise it is gated on a `ws` claim it never uses.
  /**
   * Routes that state no permission and are deliberately NOT tenant-less.
   *
   * ⚠ THIS ESCAPE HATCH EXISTS BECAUSE THE RULE WITHOUT ONE STEERS YOU INTO A
   * REMEDY THAT BREAKS THE ROUTE. A review reproduced it: drop
   * `@RequirePermission` from a tenant-scoped route — a plausible shape for
   * one whose authority is RLS alone — and TWO gates fire, this one and
   * `route-permission-coverage`. Both are satisfied by adding
   * `@SkipTenantContext()` plus an EXEMPT entry, which passes 2419 tests while
   * the route 500s on EVERY call, because its service opens with
   * `currentTenantStore()` and the interceptor never set one.
   *
   * The two gates beside this one each let you write down a reason. This one
   * did not, so the next engineer had to choose between two red tests with no
   * way to say "neither, and here is why". Now they can — and the entry is a
   * decision a reviewer sees, which is the whole point of the pattern.
   */
  const NOT_TENANT_LESS: Readonly<Record<string, string>> = Object.freeze({});

  /** Routes the rule flags, BEFORE any suppression — the population the hatch draws from. */
  async function unsuppressedOffenders(): Promise<string[]> {
    return (await routes())
      .filter((r) => meta(IS_PUBLIC_KEY, r) !== true)
      .filter((r) => meta(REQUIRE_PERMISSION_KEY, r) === undefined)
      .filter((r) => meta(SKIP_TENANT_CONTEXT_KEY, r) !== true)
      .map(name);
  }

  it("⚠ a non-public route that states no permission MUST be tenant-less", async () => {
    const offenders = (await unsuppressedOffenders()).filter((route) => !(route in NOT_TENANT_LESS));

    expect(
      offenders,
      "this route is gated on a `ws` claim it never uses — after a plan change its caller is locked out of it " +
        "for a staleness that cannot matter to it. THREE options, not two: state a permission; mark it " +
        "@SkipTenantContext() (only if it needs nothing from a validated workspace — check its service does not " +
        "call currentTenantStore()); or add it to NOT_TENANT_LESS above with what gates it instead",
    ).toEqual([]);
  });

  it("⚠ the escape hatch stays honest — every entry is LIVE and still NEEDED", async () => {
    const live = new Set((await routes()).map(name));
    for (const route of Object.keys(NOT_TENANT_LESS)) {
      expect(live, `NOT_TENANT_LESS names ${route}, which is not a live route`).toContain(route);
    }

    // ⚠ AND STILL NEEDED, WHICH LIVENESS ALONE DOES NOT CATCH. A review
    // reproduced the gap: add an entry for a route that carries a permission,
    // and it is a live route so the check above is satisfied, while the rule
    // never flagged it so nothing notices it is unused. It sits there looking
    // like it exempts something.
    //
    // The damage comes later. When that route eventually LOSES its permission
    // — the exact scenario this hatch exists for — the dead entry suppresses
    // this gate silently. The engineer sees only `route-permission-coverage`
    // fire, takes its remedy, and never learns a tenant-context decision was
    // due. An exemption nobody re-decided is worse than no exemption.
    const flagged = new Set(await unsuppressedOffenders());
    for (const route of Object.keys(NOT_TENANT_LESS)) {
      expect(
        flagged,
        `NOT_TENANT_LESS names ${route}, but the rule does not flag it — the entry is unused. ` +
          "Remove it: a suppression that suppresses nothing today will suppress silently tomorrow",
      ).toContain(route);
    }
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

  // ⚠ THE SECOND CALLER OF THIS GUARD, WHICH THE ROUTE WALK CANNOT SEE.
  //
  // `room-authorization.service.ts:149` invokes `WorkspaceGuard.canActivate`
  // on a synthetic context built by `executionContextForSocket`, for
  // `join:project`. It is not a Nest HTTP controller, so `discoverRealRoutes()`
  // does not return it and every assertion above is silent about it.
  //
  // That matters here because the gateway DELIBERATELY DELETED its own
  // `getLiveMembership` call (`room-authorization.service.ts:203-212`) on the
  // grounds that "WorkspaceGuard, which ran three lines above, already
  // re-reads live membership". So this guard is the only place that read
  // happens on the socket path.
  //
  // ⚠ WHAT THE FAILURE ACTUALLY IS — CORRECTED. A first version of this
  // comment said it would be "a revoked member keeping a live socket". That
  // is wrong, and the mechanism disproves it: `executionContextForSocket`
  // sets `REQUIRE_PERMISSION_KEY` unconditionally
  // (`ws-execution-context.ts:173`), and if the early return fired
  // `req.membership` would never be set, so `RbacGuard` fails closed on every
  // join (`rbac.guard.ts:58-60`). NOBODY connects. It is a total realtime
  // outage, not a revocation bypass — louder, and easier to notice.
  //
  // ⚠ AND THE TEST THAT LOOKS LIKE IT COVERS THIS DOES NOT.
  // `realtime-room-authorization.spec.ts:309` — "refuses a member whose
  // membership was revoked AFTER the token was minted" — STILL PASSES under
  // that regression, because it expects a refusal and gets one for entirely
  // the wrong reason. Its own comment claims "ONLY the live-membership
  // re-read can refuse this", which would no longer be true. The tests that
  // actually catch it are the two HAPPY-PATH joins in that file.
  //
  // This assertion is therefore a fast local signal, not the only net. It has
  // a subject: injecting the metadata into `executionContextForSocket` fails
  // it.
  it("⚠ the socket join context is NOT tenant-less — it is where the live-membership re-read happens", () => {
    const context = executionContextForSocket({ auth: { ws: "w", sub: "u" } } as never, {
      permission: "workspace:read",
    } as never);

    for (const target of [context.getHandler(), context.getClass()]) {
      expect(
        Reflect.getMetadata(SKIP_TENANT_CONTEXT_KEY, target),
        "a tenant-less socket join would skip the live-membership re-read the gateway relies on",
      ).not.toBe(true);
    }

    // Anti-vacuity: the context must carry the metadata it is SUPPOSED to, or
    // this is asserting the absence of a key on an empty object.
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, context.getHandler()),
      "the socket context should carry its permission — otherwise this probe is inspecting nothing",
    ).toBe("workspace:read");
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

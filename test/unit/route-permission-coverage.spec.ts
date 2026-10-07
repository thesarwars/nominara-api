import { describe, expect, it } from "vitest";
import { IS_PUBLIC_KEY } from "../../src/api/decorators/public.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../src/api/decorators/require-permission.decorator.js";
import { PERMISSION_MATRIX, PERMISSIONS } from "../../src/tenancy/permission-matrix.js";
import { discoverRealRoutes } from "../support/discover-contract-routes.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-096A second-engineer review — RbacGuard is FAIL-OPEN BY DESIGN:
//
//   "No @RequirePermission on this route — nothing for this guard to
//    enforce"  → return true                      (rbac.guard.ts:46)
//
// which is correct for the routes below and catastrophic for any other. The
// review found that NOTHING asserted `GET /v1/billing/wallet` carries
// `billing:read`: deleting the decorator would have exposed the balance, the
// bucket split and `lifetime_spent` to `viewer`, and every gate would still
// have been green. The generated OpenAPI carries no security annotation
// either, so no contract gate derives it.
//
// This is that gate, over the REAL registered router — the same walk the
// @ApiContract() coverage gate uses, never a stand-in list that could go
// stale. A new route is a build failure unless it carries a permission, is
// @Public(), or is added to EXEMPT below WITH a reason.

/**
 * Routes that legitimately carry no `@RequirePermission`, each with the
 * reason it cannot.
 *
 * ⚠ EVERY ENTRY IS ACTOR-SCOPED, NOT WORKSPACE-SCOPED. `@RequirePermission`
 * resolves a role WITHIN a workspace, so it has nothing to check on a route
 * that runs before a workspace is chosen ("list my workspaces", "switch"),
 * that creates one, or that acts on the caller's own credentials rather than
 * on workspace data. Their control is `actor_id`, asserted by ISO-18..22 on
 * the actor-self-scoped policy class.
 *
 * This list is the point of the gate. A route lands here only by a human
 * writing down why, which is exactly the decision the fail-open guard makes
 * silently otherwise.
 */
const EXEMPT: Readonly<Record<string, string>> = Object.freeze({
  "IdentityController.logout": "ends the caller's OWN session; there is no workspace role to check",
  "IdentityController.list": "GET /me/passkeys — the caller's own credentials, scoped by actor_id",
  "IdentityController.rename": "PATCH /me/passkeys/:id — the caller's own credential",
  "IdentityController.revoke": "DELETE /me/passkeys/:id — the caller's own credential",
  "IdentityController.addOptions": "POST /me/passkeys/options — adds a credential to the caller's OWN account (STORY-173); gated by step-up and proof of the address in IdentityService, not by a workspace role",
  "IdentityController.addVerify": "POST /me/passkeys/verify — completes the caller's OWN registration ceremony (STORY-173); same gates",
  "OauthController.linkStart": "links a provider to the CALLER's identity, not to a workspace",
  "OauthController.listLinks": "GET /me/oauth — which providers can sign the CALLER in; a credential belongs to a person",
  "OauthController.unlink": "DELETE /me/oauth/:provider — the caller's own identity link",
  "WorkspacesController.create": "creates the workspace whose roles a permission would be read from",
  "WorkspacesController.list": "lists the caller's OWN memberships; runs before a workspace is chosen",
  "WorkspacesController.switchWorkspace": "chooses the workspace the rest of the session is scoped to",
  "WorkspacesController.acceptInvitation": "the caller is not yet a member, so they hold no role to require",
});

/**
 * `@Public()` routes whose absence of a permission is a decision, each with the
 * reason. `@Public()` already skips the gate above; this list exists so the
 * decision is written down, and the test below fails if one is no longer public
 * (a route that quietly gained a session requirement would lose its reason) or
 * if the list names a route that does not exist.
 */
const PUBLIC_WITH_REASON: Readonly<Record<string, string>> = Object.freeze({
  "StripeWebhookController.receive":
    "POST /v1/webhooks/stripe (NEW-D-2) — Stripe has no session; the caller is authenticated by an HMAC over the raw body (Stripe-Signature, 300 s tolerance), and the workspace is resolved from the re-fetched Stripe object, never from the caller",
});

describe("STORY-096A · every workspace-scoped route states the permission it needs", () => {
  it("⚠ no route reaches RbacGuard's fail-open branch unaccounted for", async () => {
    applyFakeApiEnv();
    const routes = await discoverRealRoutes();

    // The walk itself must not be vacuous: a discovery bug returning [] would
    // make every assertion below pass while proving nothing.
    expect(routes.length).toBeGreaterThan(40);

    const unaccounted: string[] = [];
    for (const route of routes) {
      const id = `${route.controllerName}.${route.methodName}`;
      const isPublic =
        (Reflect.getMetadata(IS_PUBLIC_KEY, route.handler) as boolean | undefined) ??
        (Reflect.getMetadata(IS_PUBLIC_KEY, route.controllerClass) as boolean | undefined);
      const permission = Reflect.getMetadata(REQUIRE_PERMISSION_KEY, route.handler) as string | undefined;

      if (isPublic === true || permission !== undefined || id in EXEMPT) continue;
      unaccounted.push(`${id} (${route.fullPath})`);
    }

    expect(unaccounted).toEqual([]);
  });

  it("every permission a route asks for is one the matrix actually defines", async () => {
    applyFakeApiEnv();
    const routes = await discoverRealRoutes();
    const known = new Set<string>(PERMISSIONS);

    const unknown = routes
      .map((route) => Reflect.getMetadata(REQUIRE_PERMISSION_KEY, route.handler) as string | undefined)
      .filter((permission): permission is string => permission !== undefined && !known.has(permission));

    expect(unknown).toEqual([]);
  });

  it("⚠ the wallet is behind `billing:read`, which only owner and admin hold", async () => {
    // The balance, the bucket split and `lifetime_spent` are the workspace's
    // financial position. `tracking:trigger` — which a manager holds — is not
    // the right bar for it, which is why the bucket breakdown came off the
    // run estimate in STORY-074's review.
    applyFakeApiEnv();
    const routes = await discoverRealRoutes();
    const wallet = routes.find((route) => route.fullPath === "billing/wallet" && route.contract?.operationId === "getWallet");

    expect(wallet).toBeDefined();
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, wallet!.handler)).toBe("billing:read");

    const billingRead = PERMISSION_MATRIX["billing:read"];
    expect(billingRead.owner.access).toBe("allow");
    expect(billingRead.admin.access).toBe("allow");
    for (const role of ["manager", "analyst", "viewer"] as const) {
      expect(billingRead[role].access, `${role} must not hold billing:read`).toBe("deny");
    }
  });
});

describe("NEW-D-2 · every deliberately public, permission-less route states why", () => {
  it("each PUBLIC_WITH_REASON entry names a real route that is still @Public()", async () => {
    applyFakeApiEnv();
    const routes = await discoverRealRoutes();
    for (const [id, reason] of Object.entries(PUBLIC_WITH_REASON)) {
      const route = routes.find((r) => `${r.controllerName}.${r.methodName}` === id);
      expect(route, `${id} is listed but no such route is registered`).toBeDefined();
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, route!.handler), `${id} (${reason})`).toBe(true);
      expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, route!.handler), `${id} must not also claim a permission`).toBeUndefined();
    }
  });
});

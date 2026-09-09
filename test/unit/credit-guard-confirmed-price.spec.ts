import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { CONFIRMED_CREDITS_HEADER, CreditGuard } from "../../src/api/guards/credit.guard.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";

// STORY-034 test scenarios 2 and 3 — "Trigger without the confirmed-price
// header → Refused" and "Trigger with a mismatched confirmed price →
// Price-changed conflict."
//
// §1's header table: `X-Nominara-Confirmed-Credits` "Echoes the exact figure
// shown to the operator. A mismatch is `409 price_changed`."
//
// Pure enough to test without a container: the guard's own logic is the
// header parse and one comparison, and everything it needs from a database
// arrives through the resolver.

const WORKSPACE = "01a06ccd-9e37-7f0c-957b-195fa6d263dd";

// `null` rather than `undefined` for "no decorator": a default parameter is
// applied when the argument IS undefined, so the sentinel has to be a value
// that survives the call and is mapped afterwards.
function guardWith(price: unknown, action: string | null = "deep_scan"): CreditGuard {
  const reflector = { getAllAndOverride: () => action ?? undefined } as unknown as Reflector;
  const resolver = {
    resolveForWorkspace: () =>
      Promise.resolve({
        workspace_id: WORKSPACE,
        plan_key: "growth",
        entitlement_version: 1,
        entitlements: { "deep_scan.credits": { value: price, source: "plan", live: true } },
      }),
  } as unknown as EntitlementResolver;
  return new CreditGuard(reflector, resolver);
}

function contextWith(headers: Record<string, string>): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ tenant: { workspaceId: WORKSPACE }, headers }) }),
  } as unknown as ExecutionContext;
}

describe("STORY-034 · CreditGuard confirms the quoted price", () => {
  it("passes a route that declares no price", async () => {
    // Every route in the application that is not `¢`. The guard must be
    // invisible to them — it is an APP_GUARD and runs on all of them.
    await expect(guardWith(200, null).canActivate(contextWith({}))).resolves.toBe(true);
  });

  it("passes when the confirmed figure matches the plan's price", async () => {
    await expect(
      guardWith(200).canActivate(contextWith({ [CONFIRMED_CREDITS_HEADER]: "200" })),
    ).resolves.toBe(true);
  });

  it("REFUSES a missing header rather than reading it as zero", async () => {
    // Treating an absent header as "confirmed 0" would let any caller execute
    // a priced action by omitting a header, which is the opposite of a guard
    // rail.
    await expect(guardWith(200).canActivate(contextWith({}))).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("refuses a header that is not exactly an integer", async () => {
    // `Number()` rather than `parseInt`: "200abc" must not read as 200. A
    // header that is not an integer was not echoed from a quote.
    for (const value of ["200abc", "2.5", "-1", "", "  "]) {
      await expect(
        guardWith(200).canActivate(contextWith({ [CONFIRMED_CREDITS_HEADER]: value })),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }
  });

  it("reports BOTH figures on a mismatch", async () => {
    // A client told only "it changed" has to guess whether to re-quote or
    // give up, and an operator staring at a modal saying 200 deserves to be
    // told the answer is now 500.
    await expect(
      guardWith(500).canActivate(contextWith({ [CONFIRMED_CREDITS_HEADER]: "200" })),
    ).rejects.toMatchObject({
      code: "price_changed",
      details: { shown: 200, recomputed: 500 },
    });
  });

  it("stands aside when the plan carries no numeric price", async () => {
    // null (the tier does not sell it) and "negotiated" (enterprise, no
    // override yet) are two different refusals with two different
    // remediations, and the module that knows which one applies raises them.
    // `price_changed` here would tell a free-tier customer their quote went
    // stale when they were never quoted anything.
    for (const price of [null, "negotiated"]) {
      await expect(
        guardWith(price).canActivate(contextWith({ [CONFIRMED_CREDITS_HEADER]: "200" })),
      ).resolves.toBe(true);
    }
  });
});

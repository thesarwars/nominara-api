import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { CREDITS_KEY, CREDIT_PRICE_KEY, type CreditAction } from "../decorators/credits.decorator.js";
import { PriceChangedError, ValidationFailedError } from "../errors/domain-errors.js";
import type { WorkspaceScopedRequest } from "./workspace.guard.js";

// STORY-022-E-2 composed this slot as a pass-through; STORY-034 fills in the
// HALF THAT DOES NOT NEED A WALLET.
//
// §5's chain gives this guard two jobs — reserve from `credit_wallets`, and
// confirm the price the caller was quoted. They have different dependencies:
//
//   RESERVE  → 402 insufficient_credits. Needs `credit_wallets`, which
//              EPIC-10 (STORY-072) builds. Still not here.
//   CONFIRM  → 409 price_changed. Needs the PRICE, which is a plan
//              entitlement and has been readable since STORY-069.
//
// Shipping the confirm half now is what makes the two-step guard rail real
// rather than decorative: without it, `POST /projects/{id}/runs` would
// happily execute against a figure the operator never saw. A route that
// cannot yet debit can still refuse to act on a stale quote.

interface CreditScopedRequest extends WorkspaceScopedRequest {
  headers?: Record<string, string | string[] | undefined>;
}

/** §1's header, verbatim. Lowercased because Node normalises incoming header names. */
export const CONFIRMED_CREDITS_HEADER = "x-nominara-confirmed-credits";

@Injectable()
export class CreditGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: EntitlementResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<CreditAction | undefined>(CREDITS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (action === undefined) return true;

    const request = context.switchToHttp().getRequest<CreditScopedRequest>();
    const workspaceId = request.tenant?.workspaceId ?? request.auth?.ws ?? undefined;
    if (!workspaceId) {
      // A price is a property of a plan, and a request with no workspace has
      // no plan. Refusing beats charging against a default.
      throw new ValidationFailedError({
        message: "a credit-priced route requires a workspace",
        details: { issues: [{ path: ["workspace"], message: "no workspace is resolved for this request" }] },
      });
    }

    const confirmed = this.confirmedCredits(request);
    const resolved =
      request.entitlementVersion === undefined
        ? await this.resolver.resolveForWorkspace(workspaceId)
        : await this.resolver.resolve(workspaceId, request.entitlementVersion);
    const price = resolved.entitlements[CREDIT_PRICE_KEY[action]]?.value ?? null;

    // NOT THIS GUARD'S REFUSAL. A price that is null or non-numeric means the
    // plan does not sell this action, or an enterprise figure was never
    // negotiated — two different answers with two different remediations, and
    // the module that knows which one applies raises them. Reporting
    // `price_changed` here would tell a free-tier customer their quote went
    // stale when they were never quoted anything.
    if (typeof price !== "number") return true;

    if (confirmed !== price) {
      throw new PriceChangedError({
        message: "the confirmed price does not match this action's current price",
        // BOTH FIGURES, which is what the taxonomy's own shape asks for. A
        // client told only "it changed" has to guess whether to re-quote or
        // give up, and an operator staring at a modal saying 200 deserves to
        // be told the answer is now 500.
        details: {
          shown: confirmed,
          recomputed: price,
          reason: `${CREDIT_PRICE_KEY[action]} resolved to ${String(price)} for this workspace`,
        },
      });
    }
    return true;
  }

  /**
   * MISSING IS A 400, NOT A ZERO.
   *
   * §1 lists the header as required on every credit-spending execution route.
   * Treating an absent header as "confirmed 0" would let any caller execute a
   * priced action by omitting a header, which is the opposite of a guard
   * rail; treating it as "confirmed whatever the price is" would make the
   * check unfalsifiable.
   */
  private confirmedCredits(request: CreditScopedRequest): number {
    const raw = request.headers?.[CONFIRMED_CREDITS_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value.trim() === "") {
      throw new ValidationFailedError({
        message: `this action is priced in credits and requires the ${CONFIRMED_CREDITS_HEADER} header`,
        details: { issues: [{ path: [CONFIRMED_CREDITS_HEADER], message: "required on a credit-priced route" }] },
      });
    }
    // `Number()` rather than `parseInt`: "200abc" must not read as 200. A
    // header that is not exactly an integer was not echoed from a quote.
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ValidationFailedError({
        message: `${CONFIRMED_CREDITS_HEADER} must be a non-negative integer`,
        details: { issues: [{ path: [CONFIRMED_CREDITS_HEADER], message: "must be a non-negative integer" }] },
      });
    }
    return parsed;
  }
}

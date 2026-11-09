import { SetMetadata } from "@nestjs/common";

// STORY-034 — security-and-tenancy.md §5's chain:
//
//   → CreditGuard  @Credits('deep_scan')
//                  → 402 insufficient_credits | 409 price_changed
//
// §3's route table marks a credit-spending execution route `¢`, and §1's
// header table pairs it with `X-Nominara-Confirmed-Credits`: "Echoes the
// exact figure shown to the operator. A mismatch is `409 price_changed`."
//
// THE ACTION CODE IS THE PRICE'S KEY, and the price comes from the plan.
// `deep_scan` reads `deep_scan.credits`; a future action reads its own. The
// guard resolves it rather than the route declaring a number, because a
// price written at a call site is a copy of the schedule that goes stale the
// first time the schedule moves — the same argument `structural-usage.ts`
// makes against a hardcoded `min_plan`.

/**
 * The credit-priced actions.
 *
 * A union rather than a string so a typo is a compile error, and so the set
 * of things that can charge is greppable in one place. It grows one member
 * per priced route; `plans-and-entitlements.md` §4's schedule is the source.
 */
export const CREDIT_ACTIONS = ["deep_scan"] as const;

export type CreditAction = (typeof CREDIT_ACTIONS)[number];

/** The entitlement key each action's price is read from. */
export const CREDIT_PRICE_KEY: Readonly<Record<CreditAction, string>> = Object.freeze({
  deep_scan: "deep_scan.credits",
});

export const CREDITS_KEY = "credits";

/**
 * STORY-085 (decision 79) - POST /command/execute prices whatever its single-use parse id names: a deep scan
 * (priced) or a task (free). The route cannot declare one action statically, so it declares THIS marker and
 * `CreditGuard` resolves the action from the parse record the caller presented, then runs the very same
 * confirm-and-reserve path as `@Credits("deep_scan")`. It is the guard's own path, not a second pricing path.
 */
export const CREDITS_FROM_COMMAND_PARSE = "from_command_parse";

export const CreditsFromCommandParse = (): MethodDecorator => SetMetadata(CREDITS_KEY, CREDITS_FROM_COMMAND_PARSE);

export const Credits = (action: CreditAction): MethodDecorator & ClassDecorator =>
  SetMetadata(CREDITS_KEY, action);

import { SetMetadata } from "@nestjs/common";

// STORY-071 — security-and-tenancy.md §5's chain:
//
//   → DailyCapGuard  @DailyCap('lookup') — ABUSE control, not a cost allowance
//                    → 429 daily_limit_reached
//
// ⚠ ONE CODE PER FAMILY, NOT ONE PER ROUTE, and that is AC5.
//
// "All capture-backed tools share one counter under a single action code, so
// the cap binds across the set rather than per tool. WITHOUT THIS, AN ACCOUNT
// DEFEATS THE CONTROL BY ALTERNATING TOOLS." Per-tool caps would let an
// account run its daily limit on each of three tools and triple the exposure
// with no extra effort.
//
// The union is `credit_daily_counters.action_code`'s own CHECK constraint, so
// a route cannot invent a fourth family and quietly get its own allowance —
// `@DailyCap('visibility_scan')` is a compile error, not a bypass.

/** `credit_daily_counters.action_code`, verbatim. */
export type DailyCapAction = "lookup" | "nlp_command";

export const DAILY_CAP_KEY = "daily-cap";

/**
 * The entitlement each family's limit is read from — §2's table.
 *
 * A MAP RATHER THAN A CONVENTION. Deriving the key from the action code by
 * string manipulation would break silently the day the two naming schemes
 * diverge, and they already have: `lookup` reads `credits.lookups_per_day_max`.
 */
export const DAILY_CAP_ENTITLEMENT: Readonly<Record<DailyCapAction, string>> = Object.freeze({
  lookup: "credits.lookups_per_day_max",
  nlp_command: "credits.nlp_parses_per_day_max",
});

export const DailyCap = (action: DailyCapAction): MethodDecorator & ClassDecorator =>
  SetMetadata(DAILY_CAP_KEY, action);

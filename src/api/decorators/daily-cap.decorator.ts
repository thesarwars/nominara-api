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

// The action union and the entitlement map live in lib/usage/daily-cap.ts (the service layer reads them too); re-exported here for the guard and routes.
export { DAILY_CAP_ENTITLEMENT, type DailyCapAction } from "../../lib/usage/daily-cap.js";
import type { DailyCapAction } from "../../lib/usage/daily-cap.js";

export const DAILY_CAP_KEY = "daily-cap";

export const DailyCap = (action: DailyCapAction): MethodDecorator & ClassDecorator =>
  SetMetadata(DAILY_CAP_KEY, action);

import { SetMetadata } from "@nestjs/common";
import type { UsageMetric } from "../../lib/usage/metrics.js";

// STORY-070 AC12 — security-and-tenancy.md §5's chain:
//
//   → QuotaGuard  @Meter('pdf_exports', n) — non-credit TIER CAPS only
//                 → 429 quota_exceeded
//
// The reference writes the decorator's name and its two arguments verbatim, so
// this is a transcription rather than a design.
//
// "NON-CREDIT TIER CAPS ONLY" IS THE WHOLE CONTRACT OF THIS FILE. `UsageMetric`
// is the four-value union from `usage_counters`' own CHECK constraint, so a
// route cannot meter something the wallet owns: `@Meter('deep_scan')` is a
// compile error, not a request that returns "wait for the cycle" where the
// customer needed "buy credits".

export interface MeterSpec {
  readonly metric: UsageMetric;
  /** How many units this route consumes. §5's `n`. */
  readonly quantity: number;
  /**
   * NEW-E-100b — an optional condition on the REQUEST for the cap to apply.
   *
   * For a route whose one path serves a metered and an unmetered variant
   * (the on-demand export: a PDF consumes a `pdf_exports` unit, a CSV does
   * not). Absent = always metered, which is every other route. It reads the
   * request BEFORE the validation pipe runs, so a predicate must be total and
   * must agree with the route's own schema: it answers "is this a request
   * the handler will treat as the metered variant?", never "is it valid".
   */
  readonly when?: (request: unknown) => boolean;
}

export const METER_KEY = "meter";

/**
 * `quantity` defaults to 1 — one export, one run. A route whose consumption is
 * not known until the handler runs should reserve inside the handler rather
 * than declare a number here that is a guess.
 */
export const Meter = (
  metric: UsageMetric,
  quantity = 1,
  when?: (request: unknown) => boolean,
): MethodDecorator & ClassDecorator =>
  SetMetadata(METER_KEY, (when === undefined ? { metric, quantity } : { metric, quantity, when }) satisfies MeterSpec);

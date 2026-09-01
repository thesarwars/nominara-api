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
}

export const METER_KEY = "meter";

/**
 * `quantity` defaults to 1 — one export, one run. A route whose consumption is
 * not known until the handler runs should reserve inside the handler rather
 * than declare a number here that is a guess.
 */
export const Meter = (metric: UsageMetric, quantity = 1): MethodDecorator & ClassDecorator =>
  SetMetadata(METER_KEY, { metric, quantity } satisfies MeterSpec);

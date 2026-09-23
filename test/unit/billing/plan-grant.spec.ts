import { describe, expect, it } from "vitest";
import { proRataTopUp } from "../../../src/lib/billing/plan-grant.js";

// STORY-151 — §5's mid-cycle upgrade rule, as arithmetic.
//
// plans-and-entitlements.md §5:
//   "Upgrade mid-cycle | included_balance topped up PRO RATA:
//    (new_grant − old_grant) × days_remaining / cycle_days, floored at 0.
//    NEVER REDUCED. Daily caps lift immediately"
//
// ⚠ THE SECOND §5 LINE IS NOT A SECOND RULE. "Free → paid conversion |
// Remaining credits carry into included_balance UP TO THE NEW GRANT" reads
// like a competing formula, and three independent designs deferred the whole
// top-up to a human because of it. It cannot bind: `included_balance` is reset
// to the grant at cycle end and only ever spent down in between, so
// `included ≤ oldGrant` always, and therefore
// `included + (newGrant − oldGrant) × f ≤ newGrant` for every f ≤ 1. The
// pro-rata rule satisfies both lines for every upgrade, free→paid included.
//
// The seeded grants, read from the live database rather than assumed:
// free 60 · starter 450 · growth 1200 · business 3000 · enterprise 0.
const DAY = 24 * 60 * 60 * 1000;
const CYCLE_START = new Date("2026-09-01T00:00:00.000Z");
const CYCLE_END = new Date("2026-10-01T00:00:00.000Z"); // 30 days

function at(dayOffset: number): Date {
  return new Date(CYCLE_START.getTime() + dayOffset * DAY);
}

describe("STORY-151 · proRataTopUp", () => {
  it("grants the WHOLE difference at the first instant of a cycle", () => {
    // 30 of 30 days remain, so the factor is 1 and the customer gets the
    // full uplift — they have paid for a cycle they have not started using.
    expect(proRataTopUp(60, 1200, CYCLE_START, CYCLE_END, CYCLE_START)).toBe(1140);
  });

  it("grants half the difference at the halfway point", () => {
    expect(proRataTopUp(60, 1200, CYCLE_START, CYCLE_END, at(15))).toBe(570);
  });

  it("grants a single day's worth on the last day", () => {
    // 1140 × 1/30 = 38.
    expect(proRataTopUp(60, 1200, CYCLE_START, CYCLE_END, at(29))).toBe(38);
  });

  // ⚠ FLOORED, NOT ROUNDED. A credit is an integer and the wallet is an
  // integer column; rounding up would mint a credit nobody paid for, and
  // `credits:verify` replays the ledger against the wallet, so a minted
  // credit is a reconciliation failure rather than a rounding pleasantry.
  it("floors a fractional result rather than rounding it", () => {
    // ⚠ THIS TEST FIRST SHIPPED UNFALSIFIABLE, and the mutation caught it:
    // `Math.round` in place of `Math.floor` passed all nine assertions. With
    // a 30-day cycle every seeded uplift divides evenly (1140/30 = 38,
    // 390/30 = 13, 750/30 = 25), so floor and round AGREE on every case and
    // the assertion could not see the difference.
    //
    // A 31-day cycle is both the discriminating case and the realistic one —
    // `workspaces.service.ts` writes `current_period_end = now() + interval
    // '1 month'`, which is 31 days for eight months of the year.
    const thirtyOne = new Date("2026-10-01T00:00:00.000Z");
    const start = new Date("2026-08-31T00:00:00.000Z");
    // 390 × 1/31 = 12.58…  → floor 12, round 13.
    const oneDayLeft = new Date(thirtyOne.getTime() - DAY);
    expect(proRataTopUp(60, 450, start, thirtyOne, oneDayLeft), "rounding here mints a credit").toBe(12);
    // 1140 × 5/31 = 183.87… → floor 183, round 184.
    expect(proRataTopUp(60, 1200, start, thirtyOne, new Date(thirtyOne.getTime() - 5 * DAY))).toBe(183);
    expect(Number.isInteger(proRataTopUp(60, 450, start, thirtyOne, oneDayLeft))).toBe(true);
  });

  // ⚠ "NEVER REDUCED" IS THE WHOLE SAFETY PROPERTY OF THIS FUNCTION. It can
  // only ever return a non-negative number, so no call path can turn a plan
  // change into a credit removal — which would be a silent, unrecoverable
  // theft from a wallet the customer may have paid into.
  it("returns 0 rather than a negative number when the new grant is smaller", () => {
    expect(proRataTopUp(1200, 60, CYCLE_START, CYCLE_END, at(15))).toBe(0);
    expect(proRataTopUp(3000, 450, CYCLE_START, CYCLE_END, CYCLE_START)).toBe(0);
  });

  it("returns 0 when the grant does not move", () => {
    expect(proRataTopUp(1200, 1200, CYCLE_START, CYCLE_END, at(15))).toBe(0);
  });

  // Enterprise is seeded at credits_per_cycle 0 — verified against the live
  // plans table — so an upgrade TO it reduces the grant to nothing. The floor
  // is what stops that becoming a debit.
  it("returns 0 for an upgrade to a plan seeded with no cycle grant", () => {
    expect(proRataTopUp(3000, 0, CYCLE_START, CYCLE_END, at(10))).toBe(0);
  });

  // ⚠ THE CLOCK IS AN ARGUMENT, NOT AN AMBIENT. Nothing here calls Date.now():
  // a top-up that depends on wall-clock time cannot be tested at a boundary,
  // and the boundaries are where this is wrong.
  it("clamps outside the cycle rather than extrapolating", () => {
    // Before the cycle opened: a full cycle remains, never more than one.
    expect(proRataTopUp(60, 1200, CYCLE_START, CYCLE_END, at(-5))).toBe(1140);
    // At or past the end: nothing remains. A lapsed cycle tops up nothing —
    // the next provisioning grants the new plan in full.
    expect(proRataTopUp(60, 1200, CYCLE_START, CYCLE_END, CYCLE_END)).toBe(0);
    expect(proRataTopUp(60, 1200, CYCLE_START, CYCLE_END, at(45))).toBe(0);
  });

  // A zero-length or inverted cycle is corrupt data, not a division to attempt.
  it("returns 0 for a cycle of zero or negative length rather than dividing by it", () => {
    expect(proRataTopUp(60, 1200, CYCLE_START, CYCLE_START, CYCLE_START)).toBe(0);
    expect(proRataTopUp(60, 1200, CYCLE_END, CYCLE_START, CYCLE_START)).toBe(0);
  });
});

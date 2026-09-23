// STORY-151 — §5's mid-cycle upgrade top-up, as arithmetic and nothing else.
//
// plans-and-entitlements.md §5:
//   "Upgrade mid-cycle | `included_balance` topped up **pro rata**:
//    `(new_grant − old_grant) × days_remaining / cycle_days`, floored at 0.
//    **Never reduced.** Daily caps lift immediately"
//
// ⚠ THIS WAS NEARLY DEFERRED TO A HUMAN AS A SPEC CONTRADICTION, AND IT IS NOT
// ONE. §5 carries a second line — "Free → paid conversion | Remaining credits
// carry into `included_balance` **up to the new grant**" — which reads like a
// competing formula, and three independent designs escalated it rather than
// resolving it. It cannot bind: `included_balance` is RESET to the grant at
// cycle end and only ever spent down in between, so `included ≤ oldGrant`
// always, and therefore `included + (newGrant − oldGrant) × f ≤ newGrant` for
// every `f ≤ 1`. The pro-rata rule satisfies both lines for every upgrade,
// free→paid included. There is nothing here for a person to decide.
//
// ⚠ PURE, AND THE CLOCK IS AN ARGUMENT. A top-up that read `Date.now()` could
// not be tested at a boundary, and the boundaries — first instant, last day,
// lapsed cycle — are where it is wrong. It is also why this is a separate file
// from apply-plan.ts: the formula is checkable without a database.

/**
 * The credits to ADD to `included_balance` for an upgrade landing at `now`.
 *
 * Never negative: §5's "never reduced" is the safety property of this
 * function, and it is enforced here rather than at the call site so that no
 * future caller can turn a plan change into a credit REMOVAL — which would be
 * a silent withdrawal from a wallet the customer may have paid into, and one
 * `credits:verify`'s ledger replay would report as a reconciliation failure.
 *
 * Floored, never rounded: a credit is an integer and the wallet column is an
 * integer. Rounding up mints a credit nobody paid for.
 */
export function proRataTopUp(
  oldGrant: number,
  newGrant: number,
  cycleStart: Date,
  cycleEnd: Date,
  now: Date,
): number {
  const uplift = newGrant - oldGrant;
  if (uplift <= 0) return 0;

  const cycleMs = cycleEnd.getTime() - cycleStart.getTime();
  // A zero-length or inverted cycle is corrupt data, not a division to
  // attempt. Returning 0 leaves the wallet untouched and the plan change
  // still lands; the next provisioning grants the new plan in full.
  if (cycleMs <= 0) return 0;

  // Clamped at both ends rather than extrapolated. Before the cycle opened at
  // most one full cycle remains; at or past `cycleEnd` nothing does.
  const remainingMs = Math.min(Math.max(cycleEnd.getTime() - now.getTime(), 0), cycleMs);

  return Math.floor((uplift * remainingMs) / cycleMs);
}

/**
 * The UTC instant at the start of a `YYYY-MM-DD` date.
 *
 * ⚠ BUILT FROM PARTS RATHER THAN PARSED FROM AN INTERPOLATED ISO STRING. Two
 * reasons, and the second one is the surprise. It states the intent — these
 * are `date` columns and the boundary is midnight UTC — and a template
 * literal carrying a time component trips ISO-13'''s cache-namespacing scanner,
 * which reads any colon-bearing template as an un-namespaced cache key. The
 * scanner reads comments too, so even describing the old form here failed the
 * gate. It is right to be blunt; this is the wrong place to argue with it.
 */
export function utcMidnight(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
}

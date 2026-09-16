// STORY-074 AC7 — `plans-and-entitlements.md` §7's escalation thresholds,
// in one place, computed on the server.
//
// ⚠ THE SERVER DECIDES, NOT THE MODAL. Every threshold below is a comparison
// against the wallet, the price and the plan — three things the client would
// have to be told in order to evaluate them, and would then evaluate with its
// own copy of the numbers. Two implementations of "is this big enough to
// need a click" drift, and the failure is silent in the direction that
// matters: a client whose copy says 25 while the server says 50 stops asking
// for confirmation on debits the product promised would always be confirmed.
//
// So the estimate answers the question and the client renders the answer.
// AC10's "every figure comes from one shared schedule constant, no hardcoded
// number in any component or modal" is satisfied by the component never
// holding the figure at all.

/** §7's table, verbatim. The only place these numbers appear. */
export const ESCALATION = Object.freeze({
  /** "A small action should not need a confirmation click." */
  creditsAbove: 25,
  /** "Protects a nearly-empty wallet at any absolute size." */
  fractionOfAvailableAbove: 0.1,
  /** "Cross-project blast radius always needs confirmation." */
  projectsAbove: 1,
  /** "Prevents accidental depletion." */
  balanceAfterBelow: 50,
});

/**
 * Why a confirmation is required. One per threshold that holds, in §7's own
 * order.
 *
 * ⚠ REASONS, NOT A BOOLEAN, because the modal has something to say. "This
 * would leave you under 50 credits" and "this is more than a tenth of your
 * balance" are different warnings, and a client given only `true` has to
 * invent copy for a condition it cannot see. It is also what makes the
 * thresholds testable from the outside: a test can assert WHICH rule fired,
 * so a change to one cannot hide behind another that happens to fire too.
 */
export type EscalationReason =
  | "credits_above_threshold"
  | "large_share_of_balance"
  | "multiple_projects"
  | "balance_after_below_floor"
  | "zero_project_tier";

export interface ConfirmationInput {
  /** What the action would debit. */
  readonly credits: number;
  /** What the wallet can draw on now — balances minus what is already reserved. */
  readonly available: number;
  /** How many projects the action touches. One for a deep scan. */
  readonly projectCount: number;
  /**
   * `projects.max` for the caller's plan.
   *
   * ⚠ ZERO IS THE POINT, and `null` means unlimited rather than none —
   * enterprise carries a custom figure that resolves to no numeric cap. A
   * plan that permits no projects has no billing relationship, so §7 makes
   * confirmation unconditional there: "such a user must never be surprised."
   */
  readonly maxProjects: number | null;
}

export interface ConfirmationVerdict {
  readonly required: boolean;
  readonly reasons: readonly EscalationReason[];
}

/**
 * Whether §7's cost modal is mandatory for this action.
 *
 * Pure, so the whole threshold matrix is a unit test rather than a fixture-
 * loading integration test — and so the one place these numbers live has no
 * database to hide behind.
 */
export function confirmationFor(input: ConfirmationInput): ConfirmationVerdict {
  const reasons: EscalationReason[] = [];

  // ⚠ FIRST, AND UNCONDITIONALLY. A zero-project tier confirms whatever the
  // figures say — including for an action of zero credits, which is why this
  // is not folded into the comparisons below.
  if (input.maxProjects === 0) reasons.push("zero_project_tier");

  if (input.credits > ESCALATION.creditsAbove) reasons.push("credits_above_threshold");

  // A PRODUCT RATHER THAN A DIVISION, and the two are behaviourally the same
  // — including on an empty wallet, where IEEE gives `1/0 > 0.1` as true and
  // `0/0 > 0.1` as false, which is exactly what the product gives. Written
  // this way so the empty-wallet case reads as ordinary arithmetic instead of
  // resting on Infinity and NaN comparing the way one hopes. A mutation test
  // confirms the division form passes every case here; this is a legibility
  // choice, not a correctness one, and saying otherwise would be inventing a
  // reason.
  //
  // What IS load-bearing: an empty wallet fires the rule for any positive
  // debit. Every credit of nothing is still all of it.
  if (input.credits > input.available * ESCALATION.fractionOfAvailableAbove) {
    reasons.push("large_share_of_balance");
  }

  if (input.projectCount > ESCALATION.projectsAbove) reasons.push("multiple_projects");

  // ⚠ ONLY WHEN THE ACTION ACTUALLY SPENDS. §7's wording is that the balance
  // "would FALL below 50" and the rationale is "prevents accidental
  // depletion" — a zero-credit action depletes nothing, so an already-empty
  // wallet must not make a free action ask for confirmation. Without the
  // guard the rule fired on `credits: 0`, which is a warning about a
  // condition the action did not cause.
  if (input.credits > 0 && input.available - input.credits < ESCALATION.balanceAfterBelow) {
    reasons.push("balance_after_below_floor");
  }

  return { required: reasons.length > 0, reasons };
}

/**
 * How many more actions at this price the balance affords.
 *
 * ⚠ THE WIREFRAME'S OWN ARITHMETIC IS AMBIGUOUS AND THIS PICKS THE READING
 * IT MATCHES. §7 shows "2,400 available → 1,900 after · 4 more scans this
 * cycle", and 2400/500 is 4 while 1900/500 is 3 — so the figure is what the
 * CURRENT balance affords, not what is left afterwards. Recorded here rather
 * than silently chosen, because the two differ by one on every render and a
 * customer counting scans will notice.
 *
 * There is no per-cycle scan CAP to report: no entitlement key limits deep
 * scans by count, only by what the wallet holds.
 */
export function actionsAffordable(available: number, credits: number): number {
  if (credits <= 0) return 0;
  return Math.max(0, Math.floor(available / credits));
}


/**
 * `projects.max` as `confirmationFor` wants it — a number, or null for a plan
 * with no numeric cap.
 *
 * ⚠ `null` AND `0` ARE OPPOSITE ANSWERS HERE, and conflating them breaks §7
 * in one direction or the other. Enterprise carries `"custom"`, which is
 * unlimited; free carries a literal `0`, which is none. Read a missing value
 * as unlimited and the free tier stops confirming — the one tier §7 says must
 * ALWAYS confirm. Read `"custom"` as 0 and the most expensive plan confirms
 * every action.
 *
 * An unparseable value resolves to 0, because the safe direction is an extra
 * click. Not reachable with the seeded matrix — every plan's `projects.max`
 * parses — which is exactly why it is pinned by a test rather than left to
 * be right by accident.
 */
export function maxProjectsFrom(limit: { kind: "finite"; limit: number } | { kind: "unlimited" } | undefined): number | null {
  if (limit === undefined) return 0;
  return limit.kind === "unlimited" ? null : limit.limit;
}

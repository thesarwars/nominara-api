import { describe, expect, it } from "vitest";
import {
  actionsAffordable,
  confirmationFor,
  ESCALATION,
  maxProjectsFrom,
  type ConfirmationInput,
} from "../../../src/lib/credits/confirmation.js";

// STORY-074 scenarios 6 and 7 — "each escalation threshold → confirmation
// required", and "zero-project tier, small action → confirmation STILL
// required".
//
// ⚠ EACH TEST ISOLATES ONE RULE, which takes more setup than a few combined
// cases and is the whole point: five thresholds that all fire on a big debit
// against an empty wallet prove nothing about any individual one. A test that
// asserts only `required: true` passes against an implementation where four
// of the five are broken.

/** A comfortable baseline: nothing fires. Each test moves one thing. */
const CALM: ConfirmationInput = {
  credits: 10,
  available: 5_000,
  projectCount: 1,
  maxProjects: 5,
};

describe("STORY-074 · the escalation thresholds", () => {
  it("⚠ pins §7's numbers as LITERALS, because every other test here is written against the constant", () => {
    // ⚠ WITHOUT THIS THE NUMBERS ARE UNTESTED. The boundary cases below read
    // `ESCALATION.creditsAbove` and assert around it, which is true for ANY
    // value of it — a threshold of 100 passed all 2,337 tests in this
    // repository, meaning a server that stopped confirming every debit
    // between 26 and 99 credits would have shipped green. AC7 is "the
    // escalation thresholds are implemented exactly", and exactly is a claim
    // about the operands, not only the comparisons.
    //
    // Transcribed by hand from plans-and-entitlements.md §7's table:
    //   Estimated debit > 25 credits
    //   Estimated debit > 10% of available balance
    //   The action fans out to more than one project
    //   The balance after the action would fall below 50
    expect(ESCALATION).toEqual({
      creditsAbove: 25,
      fractionOfAvailableAbove: 0.1,
      projectsAbove: 1,
      balanceAfterBelow: 50,
    });
  });

  it("asks for nothing when every threshold is clear", () => {
    expect(confirmationFor(CALM)).toEqual({ required: false, reasons: [] });
  });

  it("fires on a debit above 25, and not at it", () => {
    // ⚠ LITERALS, NOT `ESCALATION.creditsAbove`. Written against the constant
    // this asserted nothing about the constant — see the pin above. "> 25",
    // not ">= 25": a small action should not need a click, and 25 is still
    // small.
    expect(confirmationFor({ ...CALM, credits: 24 }).reasons).toEqual([]);
    expect(confirmationFor({ ...CALM, credits: 25 }).reasons).toEqual([]);
    expect(confirmationFor({ ...CALM, credits: 26 }).reasons).toEqual(["credits_above_threshold"]);
  });

  it("fires on more than a tenth of the balance, whatever the absolute size", () => {
    // 20 credits is under the absolute threshold and over a tenth of 150 —
    // which is exactly the case this rule exists for.
    const verdict = confirmationFor({ ...CALM, credits: 20, available: 150 });
    expect(verdict.reasons).toContain("large_share_of_balance");
    expect(verdict.reasons).not.toContain("credits_above_threshold");
  });

  it("does not fire at exactly a tenth, and does one credit past it", () => {
    // Literal: a tenth of 200 is 20. 20 is clear, 21 is not.
    expect(confirmationFor({ ...CALM, credits: 20, available: 200 }).reasons).not.toContain("large_share_of_balance");
    expect(confirmationFor({ ...CALM, credits: 21, available: 200 }).reasons).toContain("large_share_of_balance");
  });

  it("⚠ holds the tenth at a size where a wrong fraction would be invisible", () => {
    // A threshold of 0.13 instead of 0.1 passed every other test here. At
    // 1,000 available, a tenth is 100 and a thirteenth-and-a-bit is 130 — so
    // 110 separates them and nothing else in this file does.
    expect(confirmationFor({ ...CALM, credits: 110, available: 1_000 }).reasons).toContain("large_share_of_balance");
  });

  it("⚠ treats any debit against an EMPTY wallet as a large share", () => {
    // Every credit of nothing is still all of it, so the rule must fire —
    // and it must not throw or return NaN on the way. (The implementation
    // uses a product rather than a division; both forms agree here, which a
    // mutation test showed, so this asserts the behaviour and not the shape.)
    const verdict = confirmationFor({ ...CALM, credits: 1, available: 0 });
    expect(verdict.reasons).toContain("large_share_of_balance");
  });

  it("does not fire the share rule for a zero-credit action on an empty wallet", () => {
    // 0/0 is NaN and NaN comparisons are false; nothing is being spent, so
    // nothing should warn. The only reason here is the relationship one.
    expect(confirmationFor({ credits: 0, available: 0, projectCount: 1, maxProjects: 5 })).toEqual({
      required: false,
      reasons: [],
    });
  });

  it("fires when the action fans out beyond one project", () => {
    expect(confirmationFor({ ...CALM, projectCount: 1 }).reasons).not.toContain("multiple_projects");
    expect(confirmationFor({ ...CALM, projectCount: 2 }).reasons).toContain("multiple_projects");
  });

  it("fires when the balance afterwards would fall under 50, and not at it", () => {
    // Literal boundaries: 51 left is clear, 50 is the floor itself and clear,
    // 49 fires.
    const leaving = (remaining: number) =>
      confirmationFor({ ...CALM, credits: 5_000 - remaining, available: 5_000 }).reasons;

    expect(leaving(51)).not.toContain("balance_after_below_floor");
    expect(leaving(50)).not.toContain("balance_after_below_floor");
    expect(leaving(49)).toContain("balance_after_below_floor");
  });

  it("⚠ scenario 7 — a zero-project tier confirms a SMALL action too", () => {
    // ⚠ THE ASYMMETRY §7 ARGUES FOR: "such a user has no billing
    // relationship and must never be surprised." Every figure here is calm —
    // 1 credit against 5,000 — and the confirmation is still required.
    const verdict = confirmationFor({ ...CALM, credits: 1, maxProjects: 0 });
    expect(verdict).toEqual({ required: true, reasons: ["zero_project_tier"] });
  });

  it("confirms a ZERO-credit action on a zero-project tier, which no comparison would catch", () => {
    // Nothing is being spent, so no threshold on an amount can fire. The
    // rule is about the relationship, not the number.
    expect(confirmationFor({ ...CALM, credits: 0, maxProjects: 0 }).reasons).toEqual(["zero_project_tier"]);
  });

  it("does not treat an unlimited plan as a zero-project one", () => {
    // Enterprise carries a custom figure that resolves to no numeric cap.
    // `null` is unlimited; reading it as 0 would make the most expensive plan
    // confirm every action.
    expect(confirmationFor({ ...CALM, maxProjects: null }).reasons).toEqual([]);
  });

  it("reports every rule that holds, in the reference's own order", () => {
    // A modal saying "this is over 25 credits" when the real problem is that
    // it empties the wallet has told the customer the least useful of two
    // true things.
    const verdict = confirmationFor({ credits: 500, available: 520, projectCount: 3, maxProjects: 0 });
    expect(verdict.reasons).toEqual([
      "zero_project_tier",
      "credits_above_threshold",
      "large_share_of_balance",
      "multiple_projects",
      "balance_after_below_floor",
    ]);
  });
});

describe("STORY-074 · maxProjectsFrom", () => {
  it("passes a finite cap through", () => {
    expect(maxProjectsFrom({ kind: "finite", limit: 5 })).toBe(5);
  });

  it("⚠ reports ZERO as zero, which is the tier that must always confirm", () => {
    expect(maxProjectsFrom({ kind: "finite", limit: 0 })).toBe(0);
  });

  it("⚠ reports unlimited as NULL, not as zero", () => {
    // Enterprise carries "custom". Read as 0 it would make the most
    // expensive plan confirm every single action.
    expect(maxProjectsFrom({ kind: "unlimited" })).toBeNull();
  });

  it("⚠ reports an unparseable entitlement as UNREADABLE, not as zero", () => {
    // Not reachable from the seeded matrix — which is why it is pinned here
    // rather than left to be right by accident. `entitlementValueSchema`
    // accepts strings, so a hand-typed override of {"projects.max": "5"} gets
    // here.
    //
    // The safe DIRECTION is still an extra click, and the first version got
    // that right by returning 0 — but 0 emits `zero_project_tier`, which told
    // a Business workspace they were on a tier with no projects. The client
    // renders remediation from the code, so the code has to be true.
    expect(maxProjectsFrom(undefined)).toBe("unreadable");
  });

  it("⚠ still confirms on an unreadable cap, under its own reason", () => {
    const verdict = confirmationFor({ ...CALM, maxProjects: "unreadable" });
    expect(verdict.required).toBe(true);
    expect(verdict.reasons).toEqual(["project_cap_unreadable"]);
    expect(verdict.reasons).not.toContain("zero_project_tier");
  });
});

describe("STORY-074 · actionsAffordable", () => {
  it("matches the reference wireframe's own figure", () => {
    // §7 shows "2,400 available → 1,900 after · 4 more scans this cycle".
    // 2400/500 is 4; 1900/500 is 3. The figure is what the CURRENT balance
    // affords — chosen to match the reference rather than guessed.
    expect(actionsAffordable(2_400, 500)).toBe(4);
  });

  it("floors rather than rounds, because a partial scan cannot be bought", () => {
    expect(actionsAffordable(2_499, 500)).toBe(4);
  });

  it("reports none when the balance cannot cover one", () => {
    expect(actionsAffordable(499, 500)).toBe(0);
  });

  it("reports none rather than infinity for a free action", () => {
    // A zero price divides to Infinity, which is not a count anybody can
    // render. A free action has no scan budget to report.
    expect(actionsAffordable(2_400, 0)).toBe(0);
  });
});

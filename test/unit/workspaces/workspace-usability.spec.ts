import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isWorkspaceUsable } from "../../../src/modules/workspaces/membership.service.js";

// ⚠ STORY-153 — THE PREDICATE THAT DECIDES WHETHER A WORKSPACE MAY BE ACTED ON.
//
// `WorkspaceGuard.assertWorkspaceIsUsable` and `WorkspacesService.switchTo`
// each carried a literal copy of these five conditions. They agreed — a review
// checked them condition for condition — but they agreed BY HAND.
//
// STORY-153 stopped the guard running on `POST /workspaces/{id}/switch`, which
// makes the service's path the only usability check on switch. A sixth
// unusable status added to one copy and not the other would let a session
// switch into a workspace every other route refuses. There is now one
// definition, and this pins it against the DOMAIN rather than against a list
// somebody retypes here.
describe("STORY-153 · isWorkspaceUsable, over the whole status domain", () => {
  /**
   * The statuses read out of the migration that defines them.
   *
   * ⚠ PARSED, NOT TYPED OUT. A hardcoded list fails in the worst direction:
   * add an eighth status and a retyped list simply would not mention it, so
   * this test would keep passing while saying nothing about the new value —
   * on the exact day someone needed it to speak up.
   */
  const STATUSES = (() => {
    const sql = readFileSync(
      fileURLToPath(new URL("../../../src/db/migrations/sql/0002_identity_tenancy_billing.up.sql", import.meta.url)),
      "utf8",
    );
    const start = sql.indexOf("CREATE TABLE workspaces");
    if (start === -1) throw new Error("workspaces CREATE TABLE not found — the domain would be empty");
    // Bounded at the next CREATE TABLE: this file declares several `status`
    // CHECKs and an unbounded slice would inherit a neighbour's vocabulary.
    const next = sql.indexOf("\nCREATE TABLE", start + 1);
    const table = sql.slice(start, next === -1 ? undefined : next);
    const check = /CHECK\s*\(status IN\s*\(([\s\S]*?)\)\)/u.exec(table);
    if (check === null) throw new Error("workspaces' status CHECK not found — the domain would be empty");
    return [...check[1]!.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
  })();

  /**
   * The ones that must be refused. Everything else in the domain must be allowed.
   *
   * ⚠ RETYPED ON PURPOSE, AND ONLY CORRECT BECAUSE THE PREDICATE IS AN
   * ALLOW-LIST. While `isWorkspaceUsable` was a deny-list this list made the
   * test vacuous in the worst way: an eighth status was absent from BOTH, so
   * both said "usable", they agreed, and the test was silent — which is the
   * failure this file's header says it exists to prevent. A review proved it
   * with `fraud_hold`.
   *
   * Inverted, the two disagree about an unclassified status — the predicate
   * refuses it, this list expects it allowed — so the test FAILS naming the
   * value. That is the point: this is the ORACLE, and updating it is the
   * deliberate act of classifying a new workspace state.
   */
  const UNUSABLE = ["suspended", "pending_deletion", "deleted"];

  it("the domain was parsed, and it is the one the schema declares", () => {
    expect(STATUSES).toEqual(
      expect.arrayContaining(["trialing", "active", "past_due", "soft_capped", "suspended", "pending_deletion", "deleted"]),
    );
    expect(STATUSES.length, "seven today — an eighth should EXTEND this, not slip past it").toBeGreaterThanOrEqual(7);
    // Not a neighbouring table's vocabulary.
    expect(STATUSES).not.toContain("retiring");
    expect(STATUSES).not.toContain("unverified");
  });

  it("⚠ every status in the domain is classified, and the split is the expected one", () => {
    for (const status of STATUSES) {
      const usable = isWorkspaceUsable({ status, entitlementVersion: 1, deletedAt: null });
      expect(usable, `${status} classified wrongly`).toBe(!UNUSABLE.includes(status));
    }
    // Anti-vacuity in both directions: the predicate must actually say yes to
    // something and no to something, or the loop above proves nothing.
    expect(STATUSES.some((s) => !UNUSABLE.includes(s)), "no usable status — the predicate refuses everything").toBe(true);
    expect(STATUSES.some((s) => UNUSABLE.includes(s)), "no unusable status — the predicate allows everything").toBe(true);
  });

  it("⚠ deletedAt refuses INDEPENDENTLY of status", () => {
    // RLS on `workspaces` filters by id only — never by status or deleted_at —
    // so this predicate is the only thing standing between a deleted workspace
    // id and a request that still names it. A soft-deleted row can still read
    // `active`.
    for (const status of STATUSES) {
      expect(
        isWorkspaceUsable({ status, entitlementVersion: 1, deletedAt: new Date() }),
        `${status} with deleted_at set must be refused`,
      ).toBe(false);
    }
  });

  it("a missing workspace is not usable", () => {
    expect(isWorkspaceUsable(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { replayLedger, type ReplayRow } from "../../../src/lib/credits/replay.js";

// STORY-073 scenario 5 — "Replay the wallet from the ledger → matches
// exactly" — and scenario 6's deliberate discrepancy.
//
// ⚠ EVERY `after` IN THIS FILE IS HAND-COMPUTED, never produced by the code
// under test or by a helper that applies the same rules. A fixture builder
// that maintained the running balance would agree with `replayLedger` by
// construction and would pass against a replay that added where it should
// subtract. These are an independent transcription of what the wallet
// statements in `wallet.ts` actually do, read off those statements.

function row(partial: Partial<ReplayRow> & Pick<ReplayRow, "seq" | "entryType" | "credits" | "after">): ReplayRow {
  return {
    bucket: null,
    idempotencyKey: "req",
    attempt: 1,
    ...partial,
  };
}

const at = (included: number, purchased: number, reserved: number): ReplayRow["after"] => ({
  included,
  purchased,
  reserved,
});

describe("STORY-073 · replayLedger — a clean history", () => {
  it("replays a grant, a reservation and its commit to the balance the wallet holds", () => {
    // 600 granted; 40 reserved; 40 committed, drawn from the included bucket
    // because that is the only one with anything in it.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "reserve", credits: 40, after: at(600, 0, 40) }),
      row({ seq: "3", entryType: "commit", credits: 40, after: at(560, 0, 0) }),
    ];

    const result = replayLedger(rows);

    expect(result.divergence).toBeNull();
    expect(result.entries).toBe(3);
    expect(result.balance).toEqual(at(560, 0, 0));
  });

  it("replays an empty ledger to an empty balance rather than refusing", () => {
    // A workspace that has never touched a priced route. Not a discrepancy.
    expect(replayLedger([])).toEqual({
      balance: at(0, 0, 0),
      lifetime: { granted: 0, purchased: 0, spent: 0 },
      entries: 0,
      divergence: null,
    });
  });
});

describe("STORY-073 · replayLedger — the commit split", () => {
  it("draws from the included bucket first and spills the remainder onto purchased", () => {
    // ⚠ THE MUTANT THIS CATCHES: drawing from `purchased` first. The TOTAL
    // is 130 either way, so a replay that got the order wrong still
    // reconciles against a wallet total — and disagrees with every
    // after-column, which is why they are checked per entry rather than once
    // at the end. `commitCredits` is
    // `LEAST(included_balance, $2)` then the remainder, and the customer-
    // favouring reason is that included credits expire at cycle end.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 100, after: at(100, 0, 0) }),
      row({ seq: "2", entryType: "purchase", bucket: "purchased", credits: 500, after: at(100, 500, 0) }),
      row({ seq: "3", entryType: "reserve", credits: 130, after: at(100, 500, 130) }),
      // 100 from included (all of it), 30 from purchased.
      row({ seq: "4", entryType: "commit", credits: 130, after: at(0, 470, 0) }),
    ];

    expect(replayLedger(rows).divergence).toBeNull();
  });

  it("releases the WHOLE reservation when the commit consumed less than was held", () => {
    // `commitCredits(committed, reserved)` releases the full reservation in
    // the same statement — a per-unit action that used less than it reserved
    // does not leave the difference held.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "reserve", credits: 100, after: at(600, 0, 100) }),
      row({ seq: "3", entryType: "commit", credits: 25, after: at(575, 0, 0) }),
    ];

    expect(replayLedger(rows).divergence).toBeNull();
  });

  it("applies a commit of zero as a pure release of the hold", () => {
    // `commitCredits` accepts 0 and `ck_credit_ledger_credits_sign` permits
    // it for this one type: an action that consumed nothing still settles
    // through the commit path.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "reserve", credits: 40, after: at(600, 0, 40) }),
      row({ seq: "3", entryType: "commit", credits: 0, after: at(600, 0, 0) }),
    ];

    expect(replayLedger(rows).divergence).toBeNull();
  });

  it("refuses a commit with no reservation behind it, naming what is missing", () => {
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "commit", credits: 40, after: at(560, 0, 0) }),
    ];

    const divergence = replayLedger(rows).divergence;
    expect(divergence?.seq).toBe("2");
    expect(divergence?.reason).toContain("nothing authorised this charge");
  });

  it("matches a commit to its OWN attempt, not to another attempt under the same key", () => {
    // The reservation under attempt 1 was released; attempt 2 is the live
    // one. A replay that looked up reserves by key alone would settle
    // attempt 2's commit against attempt 1's 400, and `reserved` would go
    // negative against a wallet that is perfectly correct.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "reserve", credits: 400, attempt: 1, after: at(600, 0, 400) }),
      row({ seq: "3", entryType: "release", credits: 400, attempt: 1, after: at(600, 0, 0) }),
      row({ seq: "4", entryType: "reserve", credits: 40, attempt: 2, after: at(600, 0, 40) }),
      row({ seq: "5", entryType: "commit", credits: 40, attempt: 2, after: at(560, 0, 0) }),
    ];

    expect(replayLedger(rows).divergence).toBeNull();
  });
});

describe("STORY-073 · replayLedger — the movements that are not commits", () => {
  it("clamps a release at zero exactly as releaseCredits does", () => {
    // ⚠ `releaseCredits` is `GREATEST(reserved - $2, 0)` — a double release
    // is a retry, and the second one is CORRECT to be a no-op. A replay that
    // subtracted without the clamp would go to -40 and report a divergence
    // against a wallet sitting at a perfectly correct 0.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "reserve", credits: 40, after: at(600, 0, 40) }),
      row({ seq: "3", entryType: "release", credits: 40, after: at(600, 0, 0) }),
      row({ seq: "4", entryType: "release", credits: 40, idempotencyKey: "other", after: at(600, 0, 0) }),
    ];

    expect(replayLedger(rows).divergence).toBeNull();
  });

  it("moves expire down and grant, purchase and refund up", () => {
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "purchase", bucket: "purchased", credits: 1000, after: at(600, 1000, 0) }),
      row({ seq: "3", entryType: "expire", bucket: "included", credits: 600, after: at(0, 1000, 0) }),
      row({ seq: "4", entryType: "refund", bucket: "purchased", credits: 250, after: at(0, 1250, 0) }),
    ];

    const result = replayLedger(rows);
    expect(result.divergence).toBeNull();
    expect(result.balance).toEqual(at(0, 1250, 0));
  });

  it("reads an adjustment's direction from the sign, in both directions", () => {
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "adjustment", bucket: "included", credits: -40, after: at(560, 0, 0) }),
      row({ seq: "3", entryType: "adjustment", bucket: "purchased", credits: 15, after: at(560, 15, 0) }),
    ];

    expect(replayLedger(rows).divergence).toBeNull();
  });

  it("refuses a balance entry that does not say which bucket it moved", () => {
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: null, credits: 600, after: at(600, 0, 0) }),
    ];

    const divergence = replayLedger(rows).divergence;
    expect(divergence?.seq).toBe("1");
    expect(divergence?.reason).toContain("which balance it moved is unrecorded");
  });
});

describe("STORY-073 · replayLedger — scenario 6, a deliberate discrepancy", () => {
  it("localises the divergence to the entry that first disagrees, not to the last one", () => {
    // ⚠ THIS IS THE WHOLE POINT OF THE `after` COLUMNS. Entry 3's recorded
    // balance is 40 credits richer than the movement it describes produces.
    // Entries 4 and 5 are each internally consistent with the wrong balance
    // that 3 established, so a check that only compared the END of the
    // ledger to the wallet would report "somewhere in this history, 40
    // credits" — an investigation. This reports entry 3.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "reserve", credits: 40, after: at(600, 0, 40) }),
      row({ seq: "3", entryType: "commit", credits: 40, after: at(600, 0, 0) }),
      row({ seq: "4", entryType: "reserve", credits: 10, idempotencyKey: "b", after: at(600, 0, 10) }),
      row({ seq: "5", entryType: "commit", credits: 10, idempotencyKey: "b", after: at(590, 0, 0) }),
    ];

    const result = replayLedger(rows);

    expect(result.divergence?.seq).toBe("3");
    expect(result.divergence?.recorded).toEqual(at(600, 0, 0));
    expect(result.divergence?.replayed).toEqual(at(560, 0, 0));
    expect(result.divergence?.reason).toContain("is not the balance replaying the ledger produces");
    // And it stops there: two entries were verified before the bad one.
    expect(result.entries).toBe(2);
    expect(result.balance).toEqual(at(600, 0, 40));
  });

  it("names the request key and attempt the divergence belongs to", () => {
    // What the person woken up needs to grep for.
    const rows: ReplayRow[] = [
      row({ seq: "9", entryType: "grant", bucket: "included", credits: 100, idempotencyKey: "cycle:2026-09", after: at(0, 0, 0) }),
    ];

    const divergence = replayLedger(rows).divergence;
    expect(divergence?.idempotencyKey).toBe("cycle:2026-09");
    expect(divergence?.attempt).toBe(1);
    expect(divergence?.entryType).toBe("grant");
  });
});


describe("STORY-073 · replayLedger — the lifetime totals", () => {
  it("counts grants, purchases and commits into the totals that only go up", () => {
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "purchase", bucket: "purchased", credits: 1000, after: at(600, 1000, 0) }),
      row({ seq: "3", entryType: "reserve", credits: 40, after: at(600, 1000, 40) }),
      row({ seq: "4", entryType: "commit", credits: 40, after: at(560, 1000, 0) }),
    ];

    expect(replayLedger(rows).lifetime).toEqual({ granted: 600, purchased: 1000, spent: 40 });
  });

  it("does NOT net a refund off lifetime_spent", () => {
    // ⚠ `refundCredits` passes no lifetime counter, so the wallet's
    // `lifetime_spent` does not go down when money comes back. These are
    // totals of what has ever happened, not a net position — a replay that
    // netted them would disagree with the wallet on every refunded
    // workspace, and page a human about a refund working correctly.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "reserve", credits: 40, after: at(600, 0, 40) }),
      row({ seq: "3", entryType: "commit", credits: 40, after: at(560, 0, 0) }),
      row({ seq: "4", entryType: "refund", bucket: "purchased", credits: 40, after: at(560, 40, 0) }),
    ];

    expect(replayLedger(rows).lifetime).toEqual({ granted: 600, purchased: 0, spent: 40 });
  });

  it("counts nothing for a reservation that was released rather than committed", () => {
    // Money held and handed back was never spent.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "reserve", credits: 40, after: at(600, 0, 40) }),
      row({ seq: "3", entryType: "release", credits: 40, after: at(600, 0, 0) }),
    ];

    expect(replayLedger(rows).lifetime).toEqual({ granted: 600, purchased: 0, spent: 0 });
  });

  it("counts nothing for an expiry or an adjustment", () => {
    // Neither is a grant, a purchase or a spend, and `expireCredits` and
    // `adjustCredits` both pass a null lifetime counter.
    const rows: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 600, after: at(600, 0, 0) }),
      row({ seq: "2", entryType: "expire", bucket: "included", credits: 100, after: at(500, 0, 0) }),
      row({ seq: "3", entryType: "adjustment", bucket: "included", credits: -50, after: at(450, 0, 0) }),
    ];

    expect(replayLedger(rows).lifetime).toEqual({ granted: 600, purchased: 0, spent: 0 });
  });
});

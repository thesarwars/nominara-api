import { describe, expect, it } from "vitest";
import { replayLedger, type ReplayRow } from "../../../src/lib/credits/replay.js";

// STORY-072 AC13 · option B: the replay must model a hold that is carried across the cycle roll.
//
// ⚠ EVERY `after` IS HAND-COMPUTED from the rule, not from the code under test (replay.spec.ts's own warning).
//
// The rule being transcribed: at the roll (the first entry keyed `cycle_roll:<start>`) min(included, reserved)
// credits stay with the holds open at that moment, oldest hold first. A commit of a carried hold spends its carry
// first, then the part of the bucket that is NOT any hold's carry, then purchased; whatever the carry still holds
// when the hold settles is expired by the entry keyed `hold_carry:<attempt>:<key>`.

function row(partial: Partial<ReplayRow> & Pick<ReplayRow, "seq" | "entryType" | "credits" | "after">): ReplayRow {
  return { bucket: null, idempotencyKey: "req", attempt: 1, ...partial };
}
const at = (included: number, purchased: number, reserved: number): ReplayRow["after"] => ({ included, purchased, reserved });
const ROLL = "cycle_roll:2026-10-01";

describe("STORY-072 AC13 · replayLedger with a carried hold", () => {
  const partial: ReplayRow[] = [
    row({ seq: "1", entryType: "grant", bucket: "included", credits: 1000, idempotencyKey: "grant:provision:2026-09-01", after: at(1000, 0, 0) }),
    row({ seq: "2", entryType: "reserve", credits: 200, idempotencyKey: "a", after: at(1000, 0, 200) }),
    row({ seq: "3", entryType: "grant", bucket: "included", credits: 1200, idempotencyKey: ROLL, after: at(2200, 0, 200) }),
    // min(1000, 200) = 200 stays held, so 800 expire.
    row({ seq: "4", entryType: "expire", bucket: "included", credits: 800, idempotencyKey: ROLL, after: at(1400, 0, 200) }),
  ];

  it("replays a partial commit of a carried hold, and the expiry of the carry's unused remainder", () => {
    const rows = [
      ...partial,
      row({ seq: "5", entryType: "commit", credits: 150, idempotencyKey: "a", after: at(1250, 0, 0) }),
      row({ seq: "6", entryType: "expire", bucket: "included", credits: 50, idempotencyKey: "hold_carry:1:a", after: at(1200, 0, 0) }),
    ];
    const result = replayLedger(rows);
    expect(result.divergence).toBeNull();
    expect(result.balance).toEqual(at(1200, 0, 0));
  });

  it("replays a release of a carried hold followed by the expiry of its whole carry", () => {
    const rows = [
      ...partial,
      row({ seq: "5", entryType: "release", credits: 200, idempotencyKey: "a", after: at(1400, 0, 0) }),
      row({ seq: "6", entryType: "expire", bucket: "included", credits: 200, idempotencyKey: "hold_carry:1:a", after: at(1200, 0, 0) }),
    ];
    expect(replayLedger(rows).divergence).toBeNull();
  });

  it("flags a settled hold whose carry was never expired, naming the settling entry", () => {
    const rows = [
      ...partial,
      row({ seq: "5", entryType: "release", credits: 200, idempotencyKey: "a", after: at(1400, 0, 0) }),
    ];
    const divergence = replayLedger(rows).divergence;
    expect(divergence?.seq).toBe("5");
    expect(divergence?.reason).toMatch(/carry/);
  });

  it("flags a carry expiry of the wrong size", () => {
    const rows = [
      ...partial,
      row({ seq: "5", entryType: "release", credits: 200, idempotencyKey: "a", after: at(1400, 0, 0) }),
      row({ seq: "6", entryType: "expire", bucket: "included", credits: 150, idempotencyKey: "hold_carry:1:a", after: at(1250, 0, 0) }),
    ];
    expect(replayLedger(rows).divergence?.seq).toBe("6");
  });

  it("flags a carry expiry that no settled hold accounts for", () => {
    const rows = [
      ...partial,
      row({ seq: "5", entryType: "expire", bucket: "included", credits: 10, idempotencyKey: "hold_carry:1:a", after: at(1390, 0, 200) }),
    ];
    expect(replayLedger(rows).divergence?.seq).toBe("5");
  });

  describe("a hold taken after the roll does not eat a carry", () => {
    // included 100 (all held by `old`), purchased 500; the roll grants 50 and expires nothing (nothing is unheld).
    const base: ReplayRow[] = [
      row({ seq: "1", entryType: "grant", bucket: "included", credits: 100, idempotencyKey: "grant:provision:2026-09-01", after: at(100, 0, 0) }),
      row({ seq: "2", entryType: "purchase", bucket: "purchased", credits: 500, idempotencyKey: "pack", after: at(100, 500, 0) }),
      row({ seq: "3", entryType: "reserve", credits: 100, idempotencyKey: "old", after: at(100, 500, 100) }),
      row({ seq: "4", entryType: "grant", bucket: "included", credits: 50, idempotencyKey: ROLL, after: at(150, 500, 100) }),
      row({ seq: "5", entryType: "reserve", credits: 200, idempotencyKey: "new", after: at(150, 500, 300) }),
    ];

    it("draws the new hold from the grant (50) and purchased (150), leaving the old hold's 100 where they are", () => {
      const rows = [
        ...base,
        row({ seq: "6", entryType: "commit", credits: 200, idempotencyKey: "new", after: at(100, 350, 100) }),
        row({ seq: "7", entryType: "release", credits: 100, idempotencyKey: "old", after: at(100, 350, 0) }),
        row({ seq: "8", entryType: "expire", bucket: "included", credits: 100, idempotencyKey: "hold_carry:1:old", after: at(0, 350, 0) }),
      ];
      const result = replayLedger(rows);
      expect(result.divergence).toBeNull();
      expect(result.balance).toEqual(at(0, 350, 0));
    });

    it("rejects the aggregate draw (all 150 from the bucket), which would have eaten the old hold's carry", () => {
      const rows = [
        ...base,
        row({ seq: "6", entryType: "commit", credits: 200, idempotencyKey: "new", after: at(0, 450, 100) }),
      ];
      expect(replayLedger(rows).divergence?.seq).toBe("6");
    });
  });
});

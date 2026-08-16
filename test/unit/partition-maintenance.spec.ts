import { describe, expect, it } from "vitest";
import {
  computePartitionMonths,
  GOLDEN_QUERY_VECTORS,
  parsePartitionBound,
  resolveMaxRetentionDays,
} from "../../src/workers/rollup/maintenance.js";

describe("STORY-013 · computePartitionMonths — pure, no wall-clock dependency", () => {
  it("computes current month plus N months ahead, inclusive, as UTC month boundaries", () => {
    const referenceDate = new Date("2026-08-16T12:34:56.000Z");
    const months = computePartitionMonths(referenceDate, 3);
    expect(months).toHaveLength(4);
    expect(months.map((m) => m.suffix)).toEqual(["2026_08", "2026_09", "2026_10", "2026_11"]);
    expect(months[0]!.start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(months[0]!.end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("rolls over a year boundary correctly", () => {
    const referenceDate = new Date("2026-11-15T00:00:00.000Z");
    const months = computePartitionMonths(referenceDate, 3);
    expect(months.map((m) => m.suffix)).toEqual(["2026_11", "2026_12", "2027_01", "2027_02"]);
  });

  it("monthsAhead = 0 yields exactly the current month", () => {
    const months = computePartitionMonths(new Date("2026-01-01T00:00:00.000Z"), 0);
    expect(months).toHaveLength(1);
    expect(months[0]!.suffix).toBe("2026_01");
  });
});

describe("STORY-013 · parsePartitionBound", () => {
  it("parses a FOR VALUES FROM/TO bound", () => {
    const bound = parsePartitionBound(
      "answer_captures_2026_08",
      "answer_captures",
      "FOR VALUES FROM ('2026-08-01 00:00:00+00') TO ('2026-09-01 00:00:00+00')",
    );
    expect(bound.isDefault).toBe(false);
    expect(bound.from?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(bound.to?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("parses a DEFAULT partition bound", () => {
    const bound = parsePartitionBound("answer_captures_default", "answer_captures", "DEFAULT");
    expect(bound.isDefault).toBe(true);
    expect(bound.from).toBeNull();
    expect(bound.to).toBeNull();
  });

  it("throws on an unrecognized bound rather than silently misclassifying it", () => {
    expect(() => parsePartitionBound("weird", "answer_captures", "garbage")).toThrow(/unrecognized partition bound/);
  });
});

describe("STORY-013 · resolveMaxRetentionDays — null/unlimited/zero/numeric branching (should-fix #7)", () => {
  it("any null value means never drop — returns null", () => {
    expect(resolveMaxRetentionDays([30, null, 90])).toBeNull();
  });

  it('any "unlimited" value means never drop — returns null', () => {
    expect(resolveMaxRetentionDays([30, "unlimited"])).toBeNull();
  });

  it("returns the platform-wide MAX across every active workspace", () => {
    expect(resolveMaxRetentionDays([30, 90, 15])).toBe(90);
  });

  it("a zero-day entitlement is a valid, distinct numeric case — NOT collapsed into null", () => {
    expect(resolveMaxRetentionDays([0])).toBe(0);
  });

  it("an empty set (no active workspaces) is conservative — returns null, nothing is ever dropped", () => {
    expect(resolveMaxRetentionDays([])).toBeNull();
  });
});

describe("STORY-013 · GOLDEN_QUERY_VECTORS — the fixed nightly recall query set", () => {
  it("is deterministic (same seeds every run) and dimensioned for halfvec(1536)", () => {
    expect(GOLDEN_QUERY_VECTORS.length).toBeGreaterThan(0);
    for (const vector of GOLDEN_QUERY_VECTORS) {
      expect(vector).toHaveLength(1536);
    }
  });

  it("every query vector is a unit vector (normalized)", () => {
    for (const vector of GOLDEN_QUERY_VECTORS) {
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    }
  });
});

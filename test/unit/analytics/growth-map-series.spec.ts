import { describe, expect, it } from "vitest";
import {
  bucketFailures,
  calendarDays,
  dataGaps,
  extendGapsToBucketEnds,
  fingerprintTransitions,
  hourBuckets,
  isMaterialPromptSetChange,
  parseCadenceChange,
  pickScoringVersion,
  PROMPT_SET_CHANGE_THRESHOLD,
  resampleWeekly,
  versionChanges,
  weekBuckets,
  type VersionedSeriesRow,
} from "../../../src/lib/analytics/growth-map.js";
import { nameUuid } from "../../../src/lib/ids/name-uuid.js";
import type { GrowthMapPoint } from "../../../contracts/analytics/index.js";

// STORY-066 — the pure halves of the series contract: §13's week resampling,
// the hour buckets, the cadence parser, the scoring-version boundary, and the
// detectors behind the configuration pins.

const day = (d: string, visibility: number | null, cells = visibility === null ? 0 : 10): GrowthMapPoint => ({
  d,
  visibility_score: visibility,
  sov: visibility === null ? null : visibility / 200,
  cells,
  live_ratio: visibility === null ? null : 1,
});

describe("STORY-066 AC2 · week buckets", () => {
  it("cuts the window into seven-day buckets that END on the window's last day", () => {
    const buckets = weekBuckets(calendarDays("2026-10-01", "2026-10-20"));
    expect(buckets.map((b) => [b.start, b.end])).toEqual([
      ["2026-10-01", "2026-10-06"],
      ["2026-10-07", "2026-10-13"],
      ["2026-10-14", "2026-10-20"],
    ]);
    expect(buckets.map((b) => b.label)).toEqual(["2026-10-01", "2026-10-07", "2026-10-14"]);
    expect(buckets[0]!.days).toHaveLength(6);
  });

  it("scenario 2 — a week is the MEAN OF ITS DAILY VALUES, not a resampled last value", () => {
    const days = calendarDays("2026-10-14", "2026-10-20");
    const points = days.map((d, i) => day(d, i === 0 ? 10 : i === 1 ? 20 : i === 6 ? 90 : null));
    const [week] = resampleWeekly(weekBuckets(days), points);
    expect(week!.visibility_score).toBeCloseTo(40, 9);
    expect(week!.visibility_score).not.toBe(90);
    expect(week!.sov).toBeCloseTo(40 / 200, 9);
    expect(week!.cells).toBe(30);
  });

  it("a week with no measured day is null with zero cells — never interpolated", () => {
    const days = calendarDays("2026-10-07", "2026-10-20");
    const points = days.map((d, i) => day(d, i < 7 ? null : 50));
    const weeks = resampleWeekly(weekBuckets(days), points);
    expect(weeks[0]).toEqual({ d: "2026-10-07", visibility_score: null, sov: null, cells: 0, live_ratio: null });
    expect(weeks[1]!.visibility_score).toBe(50);
  });

  it("names the engines behind a missing WEEK, and the gap runs to the bucket's last day", () => {
    const days = calendarDays("2026-10-07", "2026-10-20");
    const buckets = weekBuckets(days);
    const points = resampleWeekly(buckets, days.map((d, i) => day(d, i < 7 ? null : 50)));
    const gaps = extendGapsToBucketEnds(dataGaps(points, bucketFailures([{ metricDate: "2026-10-09", engineKey: "gemini" }], buckets)), buckets);
    expect(gaps).toEqual([{ from: "2026-10-07", to: "2026-10-13", reason: "engine_unavailable", engines: ["gemini"] }]);
  });
});

describe("STORY-066 AC1 · hour buckets", () => {
  it("is the 24 UTC hours ending with the current one, labelled as instants", () => {
    const hours = hourBuckets(Date.parse("2026-10-26T13:47:12Z"));
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-10-25T14:00:00Z");
    expect(hours[23]).toBe("2026-10-26T13:00:00Z");
  });
});

describe("STORY-066 AC5 · the cadence-change detail parser is strict", () => {
  it("reads the trigger's own 'X to Y' format", () => {
    expect(parseCadenceChange("weekly to daily")).toEqual({ from: "weekly", to: "daily" });
    expect(parseCadenceChange("twice_weekly to hourly")).toEqual({ from: "twice_weekly", to: "hourly" });
  });

  it("refuses anything else rather than guessing", () => {
    for (const detail of [null, "", "weekly", "weekly to", "weekly -> daily", "Weekly to daily", "weekly to daily ", "monthly to daily", "daily to daily to weekly"]) {
      expect(parseCadenceChange(detail)).toBeNull();
    }
  });
});

describe("STORY-066 AC12 · scoring-version boundary", () => {
  const row = (entityId: string, metricDate: string, scoringVersion: string, computedAt: number, visibilityScore = 50): VersionedSeriesRow => ({
    entityId,
    metricDate,
    visibilityScore,
    sov: 0.2,
    cellsTotal: 10,
    liveCaptureRatio: 1,
    scoringVersion,
    computedAt,
  });

  it("plots the current version where a day has it, and the most recent older version otherwise", () => {
    const picked = pickScoringVersion(
      [row("b", "2026-10-01", "v0", 1, 40), row("b", "2026-10-02", "v0", 1, 41), row("b", "2026-10-02", "v1", 2, 60), row("b", "2026-10-01", "v0b", 5, 42)],
      "v1",
    );
    expect(picked.map((r) => [r.metricDate, r.scoringVersion, r.visibilityScore])).toEqual([
      ["2026-10-01", "v0b", 42],
      ["2026-10-02", "v1", 60],
    ]);
  });

  it("marks each change between consecutive MEASURED buckets, at the first bucket under the new version", () => {
    expect(versionChanges(["d1", "d2", "d3", "d4", "d5"], ["v0", null, "v1", "v1", "v2"])).toEqual([
      { at: "d3", from: "v0", to: "v1" },
      { at: "d5", from: "v1", to: "v2" },
    ]);
    expect(versionChanges(["d1", "d2"], ["v1", "v1"])).toEqual([]);
    expect(versionChanges(["d1", "d2"], [null, null])).toEqual([]);
  });
});

describe("STORY-066 AC8/AC9 · configuration-pin detectors", () => {
  it("prompt_set_change fires at ≥ 10% of the set added or removed in one day", () => {
    expect(PROMPT_SET_CHANGE_THRESHOLD).toBe(0.1);
    expect(isMaterialPromptSetChange({ before: 10, added: 1, removed: 0 })).toBe(true);
    expect(isMaterialPromptSetChange({ before: 10, added: 0, removed: 1 })).toBe(true);
    expect(isMaterialPromptSetChange({ before: 20, added: 1, removed: 0 })).toBe(false);
    expect(isMaterialPromptSetChange({ before: 20, added: 1, removed: 1 })).toBe(true);
  });

  it("a project's first prompt set is not a change to it", () => {
    expect(isMaterialPromptSetChange({ before: 0, added: 25, removed: 0 })).toBe(false);
  });

  it("engine_model_change: one transition per fingerprint change, none for the first fingerprint ever seen", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 26, h));
    expect(fingerprintTransitions(null, [{ fingerprint: "a", at: at(1) }])).toEqual([]);
    expect(fingerprintTransitions("a", [{ fingerprint: "a", at: at(1) }])).toEqual([]);
    expect(
      fingerprintTransitions("a", [
        { fingerprint: "a", at: at(1) },
        { fingerprint: "b", at: at(2) },
        { fingerprint: "b", at: at(3) },
        { fingerprint: "c", at: at(4) },
      ]),
    ).toEqual([
      { from: "a", to: "b", at: at(2) },
      { from: "b", to: "c", at: at(4) },
    ]);
  });
});

describe("STORY-066 AC7 · deterministic milestone source ids", () => {
  it("the same parts always name the same source, so a re-run cannot double-pin", () => {
    const one = nameUuid("engine_model_change", "p", "gemini", "a", "b", "2026-10-26");
    expect(nameUuid("engine_model_change", "p", "gemini", "a", "b", "2026-10-26")).toBe(one);
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("different parts — or the same text split differently — name different sources", () => {
    const base = nameUuid("prompt_set_change", "p", "2026-10-26");
    expect(nameUuid("prompt_set_change", "p", "2026-10-27")).not.toBe(base);
    expect(nameUuid("prompt_set_change", "q", "2026-10-26")).not.toBe(base);
    expect(nameUuid("ab", "c")).not.toBe(nameUuid("a", "bc"));
  });
});

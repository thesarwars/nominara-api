import { describe, expect, it } from "vitest";
import {
  baselinePoints,
  calendarDays,
  dataGaps,
  firstAndLastScored,
  median,
  pointsFor,
  type DailySeriesRow,
} from "../../../src/lib/analytics/growth-map.js";
import type { GrowthMapPoint, GrowthMapSeries } from "../../../contracts/analytics/index.js";

// STORY-137 — the two rules that make the chart honest: a gap is a gap, and
// the baseline is the median.

const row = (over: Partial<DailySeriesRow> = {}): DailySeriesRow => ({
  entityId: "11111111-1111-4111-8111-111111111111",
  metricDate: "2026-09-01",
  visibilityScore: 60,
  sov: 0.3,
  cellsTotal: 100,
  liveCaptureRatio: 1,
  ...over,
});

const series = (points: GrowthMapPoint[]): GrowthMapSeries => ({
  series_id: "competitor:x",
  label: "X",
  entity_type: "competitor",
  color_role: "comparison",
  points,
  data_source: null,
});

describe("STORY-137 · calendarDays", () => {
  it("emits every day inclusive of both ends", () => {
    expect(calendarDays("2026-09-01", "2026-09-04")).toEqual(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"]);
  });

  it("emits one day for a single-day window", () => {
    expect(calendarDays("2026-09-01", "2026-09-01")).toEqual(["2026-09-01"]);
  });

  it("crosses a month boundary", () => {
    expect(calendarDays("2026-08-30", "2026-09-01")).toEqual(["2026-08-30", "2026-08-31", "2026-09-01"]);
  });
});

describe("STORY-137 scenario 1 · a missing day is null, never interpolated", () => {
  const days = calendarDays("2026-09-01", "2026-09-03");

  it("renders the day as a null point that still carries its date", () => {
    const points = pointsFor(days, [row({ metricDate: "2026-09-01" }), row({ metricDate: "2026-09-03" })]);
    expect(points).toHaveLength(3);
    expect(points[1]).toEqual({ d: "2026-09-02", visibility_score: null, sov: null, cells: 0, live_ratio: null });
  });

  it("does NOT carry the previous day's value across, and does not use zero", () => {
    // Zero would draw the brand collapsing to nothing on a day nobody
    // measured; carrying the value across is the same lie with a flat line.
    const points = pointsFor(days, [row({ metricDate: "2026-09-01", visibilityScore: 74 })]);
    expect(points[1]!.visibility_score).toBeNull();
    expect(points[2]!.visibility_score).toBeNull();
  });

  it("keeps a REAL zero as zero", () => {
    const points = pointsFor(["2026-09-01"], [row({ visibilityScore: 0, sov: 0 })]);
    expect(points[0]).toMatchObject({ visibility_score: 0, sov: 0, cells: 100 });
  });
});

describe("STORY-137 scenarios 2, 3 and 4 · the competitor baseline", () => {
  it("scenario 2 — the baseline is the MEDIAN, not the mean", () => {
    // One category giant is enough to make the mean represent nobody.
    expect(median([10, 20, 300])).toBe(20);
    expect(median([10, 20, 300])).not.toBe((10 + 20 + 300) / 3);
  });

  it("averages the middle pair on an even set", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
  });

  it("scenario 3 — with one competitor the baseline IS that competitor", () => {
    const days = ["2026-09-01"];
    const baseline = baselinePoints(days, [series([{ d: "2026-09-01", visibility_score: 42, sov: 0.2, cells: 10, live_ratio: 1 }])]);
    expect(baseline[0]!.visibility_score).toBe(42);
  });

  it("scenario 4 — with no competitors every baseline point is null", () => {
    // The caller drops the series entirely; this proves the function does not
    // invent a zero line if it is ever called with an empty set.
    expect(baselinePoints(["2026-09-01"], [])[0]!.visibility_score).toBeNull();
  });

  it("excludes a competitor's GAP DAY from the median rather than counting it as zero", () => {
    const days = ["2026-09-01"];
    const baseline = baselinePoints(days, [
      series([{ d: "2026-09-01", visibility_score: 40, sov: null, cells: 10, live_ratio: 1 }]),
      series([{ d: "2026-09-01", visibility_score: null, sov: null, cells: 0, live_ratio: null }]),
    ]);
    expect(baseline[0]!.visibility_score).toBe(40);
  });

  it("is null on a day NO competitor measured — the gap rule applies to it too", () => {
    const baseline = baselinePoints(["2026-09-01"], [
      series([{ d: "2026-09-01", visibility_score: null, sov: null, cells: 0, live_ratio: null }]),
    ]);
    expect(baseline[0]!.visibility_score).toBeNull();
  });

  it("returns null for an empty value set rather than 0", () => {
    expect(median([])).toBeNull();
  });
});

describe("STORY-137 · data gaps", () => {
  const point = (d: string, score: number | null): GrowthMapPoint => ({
    d,
    visibility_score: score,
    sov: null,
    cells: score === null ? 0 : 10,
    live_ratio: null,
  });

  it("collapses a run of missing days into ONE contiguous range", () => {
    // A ninety-day chart on a paused project would otherwise carry ninety
    // annotations, where the finding is "this stopped in June".
    const gaps = dataGaps(
      [point("2026-09-01", 60), point("2026-09-02", null), point("2026-09-03", null), point("2026-09-04", 61)],
      [],
    );
    expect(gaps).toEqual([{ from: "2026-09-02", to: "2026-09-03", reason: "no_capture", engines: [] }]);
  });

  it("names the engines that failed, and calls it an outage rather than a silence", () => {
    const gaps = dataGaps(
      [point("2026-09-02", null)],
      [
        { metricDate: "2026-09-02", engineKey: "gemini" },
        { metricDate: "2026-09-02", engineKey: "chatgpt" },
      ],
    );
    expect(gaps).toEqual([
      { from: "2026-09-02", to: "2026-09-02", reason: "engine_unavailable", engines: ["chatgpt", "gemini"] },
    ]);
  });

  it("does NOT merge an outage into a silence — they are different findings", () => {
    const gaps = dataGaps(
      [point("2026-09-01", null), point("2026-09-02", null)],
      [{ metricDate: "2026-09-02", engineKey: "gemini" }],
    );
    expect(gaps).toHaveLength(2);
    expect(gaps[0]!.reason).toBe("no_capture");
    expect(gaps[1]).toMatchObject({ reason: "engine_unavailable", engines: ["gemini"] });
  });

  it("closes a gap that runs to the end of the window", () => {
    const gaps = dataGaps([point("2026-09-01", 60), point("2026-09-02", null)], []);
    expect(gaps).toEqual([{ from: "2026-09-02", to: "2026-09-02", reason: "no_capture", engines: [] }]);
  });

  it("reports no gaps on a complete window", () => {
    expect(dataGaps([point("2026-09-01", 60), point("2026-09-02", 61)], [])).toEqual([]);
  });
});

describe("STORY-137 · summary ends", () => {
  const point = (d: string, score: number | null): GrowthMapPoint => ({
    d,
    visibility_score: score,
    sov: null,
    cells: 0,
    live_ratio: null,
  });

  it("takes the first and last days that CARRY A SCORE, not the window edges", () => {
    // A window opening and closing on a gap has a start and an end; they are
    // just not the first and last dates.
    const ends = firstAndLastScored([
      point("2026-09-01", null),
      point("2026-09-02", 60),
      point("2026-09-03", 74),
      point("2026-09-04", null),
    ]);
    expect(ends).toEqual({ start: 60, end: 74 });
  });

  it("reports null at both ends when nothing was measured at all", () => {
    expect(firstAndLastScored([point("2026-09-01", null)])).toEqual({ start: null, end: null });
  });
});

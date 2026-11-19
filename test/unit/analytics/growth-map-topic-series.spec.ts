import { describe, expect, it } from "vitest";
import { GrowthMapService } from "../../../src/modules/analytics/growth-map.service.js";

// Batch 19 fix - the topic series is ONE grouped query for the window, not one aggregation per day, and it reads scoring versions as the unfiltered
// series does. A scripted transaction: statements are matched by text and counted.

const PROJECT = "00000000-0000-7000-8000-0000000000a1";
const BRAND_LABEL = "Acme";

function dayList(count: number): string[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

interface GroupedRow {
  readonly day: string;
  readonly version: string;
  readonly engine?: string;
  readonly newestMs?: number;
  readonly cells?: number;
  readonly present?: number;
}

function aggregateRow(row: GroupedRow): Record<string, string> {
  return {
    engine_key: row.engine ?? "chatgpt", entity_type: "brand", entity_id: PROJECT, metric_date: row.day, scoring_version: row.version,
    newest_ms: String(row.newestMs ?? 1_000), cells_total: String(row.cells ?? 4), live_cells: String(row.cells ?? 4), weight_total: String(row.cells ?? 4),
    cells_present: String(row.present ?? 2), sov_weighted: "0", prominence_sum: "0", mention_rows: "0", rank_sum: "0", rank_rows: "0", mentions_total: "0",
    pos: "0", neu: "0", neg: "0", sent_weighted: "0", render_weighted: "0", render_weight_total: "0", render_mention_rows: "0",
    cit_total: "0", cit_owned: "0", cit_owned_pw: "0", cit_pw_total: "0",
  };
}

function harness(rows: readonly GroupedRow[]) {
  const statements: string[] = [];
  const tx = {
    query: async (text: string) => {
      statements.push(text);
      if (/FROM project_engines/.test(text)) return { rows: [] };
      if (/FROM competitors/.test(text)) return { rows: [] };
      if (/WITH day_cells AS/.test(text)) return { rows: rows.map(aggregateRow) };
      throw new Error(`unscripted statement: ${text.slice(0, 60)}`);
    },
  };
  const service = new GrowthMapService();
  const topicSeries = (days: readonly string[]) =>
    (service as unknown as { topicSeries: (...a: unknown[]) => Promise<{ rows: Array<{ metricDate: string; scoringVersion: string; entityType: string; cellsTotal: number }> }> }).topicSeries(
      tx, PROJECT, days, "UTC", null, ["cluster-1"], BRAND_LABEL,
    );
  return { statements, topicSeries };
}

describe("batch 19 fix - growth map topic series", () => {
  it("STORY-090 AC8: the number of queries does not depend on the window - a 365-day window costs what a 7-day window costs", async () => {
    const week = harness([]);
    await week.topicSeries(dayList(7));
    const year = harness([]);
    await year.topicSeries(dayList(365));
    expect(year.statements.length).toBe(week.statements.length);
    expect(year.statements.length).toBeLessThanOrEqual(3);
    expect(year.statements.filter((s) => /WITH day_cells AS/.test(s))).toHaveLength(1);
  });

  it("STORY-090 AC8: the single query covers the whole window (first day to last day) and groups by local day and scoring version", async () => {
    const calls: unknown[][] = [];
    const tx = { query: async (text: string, values?: unknown[]) => { calls.push([text, values]); return { rows: [] }; } };
    const service = new GrowthMapService();
    await (service as unknown as { topicSeries: (...a: unknown[]) => Promise<unknown> }).topicSeries(tx, PROJECT, dayList(365), "Asia/Dhaka", null, ["c1"], BRAND_LABEL);
    const aggregate = calls.find(([text]) => /WITH day_cells AS/.test(text as string))!;
    expect(aggregate[1]).toEqual(expect.arrayContaining([PROJECT, "2026-01-01", "Asia/Dhaka", "2026-12-31"]));
    expect(aggregate[0]).toMatch(/AT TIME ZONE \$3\)::date::text \|\| '\|' \|\| c\.scoring_version/);
  });

  it("STORY-090 AC8: a day with no cell has no row (a gap, never a zero)", async () => {
    const h = harness([{ day: "2026-01-02", version: "v1" }]);
    const { rows } = await h.topicSeries(dayList(3));
    expect(rows.map((r) => r.metricDate)).toEqual(["2026-01-02"]);
  });

  it("STORY-066 AC12: a day with cells under the current AND an older scoring version takes the current one, and the two are never blended", async () => {
    const h = harness([
      { day: "2026-01-01", version: "v0", cells: 10, present: 10, newestMs: 9_000 },
      { day: "2026-01-01", version: "v1", cells: 4, present: 2, newestMs: 1_000 },
    ]);
    const { rows } = await h.topicSeries(dayList(1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scoringVersion: "v1", cellsTotal: 4 });
  });

  it("STORY-066 AC12: a day measured only under an older version is plotted under it (not a gap), the most recent of several older versions winning", async () => {
    const h = harness([
      { day: "2026-01-01", version: "v-1", newestMs: 1_000 },
      { day: "2026-01-01", version: "v0", newestMs: 5_000 },
      { day: "2026-01-02", version: "v1" },
    ]);
    const { rows } = await h.topicSeries(dayList(2));
    expect(rows.map((r) => [r.metricDate, r.scoringVersion])).toEqual([["2026-01-01", "v0"], ["2026-01-02", "v1"]]);
  });

  it("an engine outside the selection contributes nothing", async () => {
    const tx = { query: async (text: string) => ({ rows: /WITH day_cells AS/.test(text) ? [aggregateRow({ day: "2026-01-01", version: "v1", engine: "claude" })] : [] }) };
    const { rows } = await (new GrowthMapService() as unknown as { topicSeries: (...a: unknown[]) => Promise<{ rows: unknown[] }> }).topicSeries(
      tx, PROJECT, dayList(1), "UTC", ["chatgpt"], ["c1"], BRAND_LABEL,
    );
    expect(rows).toEqual([]);
  });
});

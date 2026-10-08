import { describe, expect, it } from "vitest";
import { geoFindingSchema, type GeoFinding, type GeoSlug } from "../../../contracts/analytics/index.js";
import { rankLevers, type LeverRow } from "../../../src/lib/geo/lever-rank.js";

// NEW-C-13 (STORY-062 AC8/9) — the Top Three Levers: at most three, ranked by
// impact across every sufficient analysis, never a generic checklist.
// Impact = finding severity, then the analysis's evidence base, then the
// stable slug order (no impact formula exists in the reference; recorded in
// docs/plans/evidence/NEW-C-13.md).

const act = (id: string, severity: GeoFinding["severity"], extra: Partial<GeoFinding> = {}): GeoFinding => ({
  id,
  severity,
  headline: `headline ${id}`,
  evidence: [{ url: "https://acme.com/", snippet: "s" }],
  task_rule_code: "RULE",
  ...extra,
});
const noAct = (id: string, severity: GeoFinding["severity"]): GeoFinding => ({
  id,
  severity,
  headline: `headline ${id}`,
  evidence: [{ url: "https://acme.com/", snippet: "s" }],
  no_action: true,
});
const row = (analysis: GeoSlug, findings: GeoFinding[], over: Partial<LeverRow> = {}): LeverRow => ({
  analysis,
  sufficient: true,
  evidenceCells: 10,
  findings,
  ...over,
});
const rankOf = (out: ReturnType<typeof rankLevers>, a: GeoSlug) => out.find((x) => x.analysis === a)!.leverRank;

describe("NEW-C-13 · lever ranking (pure)", () => {
  it("[L1] ranks analyses by the severity of their best actionable finding, 1 = highest impact", () => {
    const out = rankLevers([
      row("sentiment", [act("a", "medium")]),
      row("entity", [act("b", "critical")]),
      row("topics", [act("c", "high")]),
    ]);
    expect(rankOf(out, "entity")).toBe(1);
    expect(rankOf(out, "topics")).toBe(2);
    expect(rankOf(out, "sentiment")).toBe(3);
  });

  it("[L2] promotes at most three however many analyses have levers", () => {
    const slugs: GeoSlug[] = ["alignment", "entity", "structure", "divergence", "topics", "sentiment", "freshness"];
    const out = rankLevers(slugs.map((s) => row(s, [act(`f-${s}`, "high")])));
    const ranks = out.map((x) => x.leverRank).filter((r) => r !== null);
    expect(ranks.sort()).toEqual([1, 2, 3]);
    expect(out.filter((x) => x.leverRank === null)).toHaveLength(4);
  });

  it("[L3] a no-action finding is never promoted, even at critical severity", () => {
    const out = rankLevers([row("structure", [noAct("n", "critical")]), row("sentiment", [act("a", "low")])]);
    expect(rankOf(out, "structure")).toBeNull();
    expect(rankOf(out, "sentiment")).toBe(1);
  });

  it("[L4] an insufficient analysis is never promoted and carries no lever", () => {
    const out = rankLevers([row("sentiment", [], { sufficient: false }), row("entity", [act("a", "info")])]);
    expect(rankOf(out, "sentiment")).toBeNull();
    expect(rankOf(out, "entity")).toBe(1);
  });

  it("[L5] one lever per analysis: its best finding carries lever_rank, its other findings carry none", () => {
    const out = rankLevers([row("sentiment", [act("low", "low"), act("hi", "high"), act("hi2", "high")])]);
    const f = out[0]!.findings;
    expect(f.find((x) => x.id === "hi")!.lever_rank).toBe(1);
    expect(f.filter((x) => x.lever_rank !== undefined)).toHaveLength(1);
  });

  it("[L6] ties break on evidence base, then slug order, whatever the input order", () => {
    const rows = [
      row("topics", [act("t", "high")], { evidenceCells: 5 }),
      row("entity", [act("e", "high")], { evidenceCells: 50 }),
      row("alignment", [act("a", "high")], { evidenceCells: 5 }),
    ];
    for (const input of [rows, [...rows].reverse()]) {
      const out = rankLevers(input);
      expect(rankOf(out, "entity")).toBe(1);
      expect(rankOf(out, "alignment")).toBe(2);
      expect(rankOf(out, "topics")).toBe(3);
    }
  });

  it("[L7] a stale rank is stripped: findings carry no lever_rank once the analysis is not promoted", () => {
    const stale = act("a", "low", { lever_rank: 1 });
    const slugs: GeoSlug[] = ["alignment", "entity", "topics"];
    const out = rankLevers([row("sentiment", [stale]), ...slugs.map((s) => row(s, [act(s, "critical")]))]);
    expect(rankOf(out, "sentiment")).toBeNull();
    expect(out.find((x) => x.analysis === "sentiment")!.findings[0]!.lever_rank).toBeUndefined();
  });

  it("[L8] no rows, or no actionable finding, ranks nothing", () => {
    expect(rankLevers([])).toEqual([]);
    expect(rankLevers([row("structure", [noAct("n", "high")])]).map((x) => x.leverRank)).toEqual([null]);
  });

  it("[L9] every returned finding still satisfies the finding contract", () => {
    const out = rankLevers([row("sentiment", [act("a", "high"), noAct("b", "info")])]);
    for (const f of out[0]!.findings) expect(geoFindingSchema.safeParse(f).success).toBe(true);
  });

  it("[L10] ranking its own output changes nothing (idempotent)", () => {
    const once = rankLevers([row("sentiment", [act("a", "high")]), row("entity", [act("b", "medium")])]);
    const twice = rankLevers(once.map((x) => row(x.analysis, x.findings)));
    expect(twice).toEqual(once);
  });

  it("[L11] does not mutate its input", () => {
    const input = [row("sentiment", [act("a", "high", { lever_rank: 2 })])];
    const snapshot = structuredClone(input);
    rankLevers(input);
    expect(input).toEqual(snapshot);
  });
});

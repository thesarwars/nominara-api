import { describe, expect, it } from "vitest";
import { geoAnalysisWriteSchema, geoStructureDetailSchema } from "../../../contracts/analytics/index.js";
import { buildStructure, STRUCTURE_MIN_ANSWERS, type StructureInput } from "../../../src/lib/geo/structure.js";

// STORY-060 — A3 answer structure. Scenario numbers refer to the story's
// table; #8 is deliberately NOT the story's "gap fires": the plan overrides it
// (no page crawl exists, so the gap is never asserted).

type FormRow = StructureInput["forms"][number];
const f = (engine: string, form: FormRow["form"], answers: number, dataSource: FormRow["dataSource"] = "live"): FormRow => ({
  engine,
  form,
  answers,
  dataSource,
});
const input = (over: Partial<StructureInput> = {}): StructureInput => ({
  windowStart: "2026-09-08",
  windowDays: 30,
  rootDomain: "acme.com",
  forms: [f("gemini", "comparison_table", 20), f("gemini", "narrative", 10)],
  position: [],
  priorPosition: [],
  ...over,
});

describe("STORY-060 · A3 answer structure (pure)", () => {
  it("#7 · the dominant form is identified, with counts for all five forms (zeros included)", () => {
    const { detail } = buildStructure(input());
    expect(detail!.dominant_form).toBe("comparison_table");
    expect(detail!.total).toBe(30);
    expect(detail!.forms.map((x) => x.form)).toEqual([
      "ranked_list",
      "comparison_table",
      "single_recommendation",
      "neutral_enumeration",
      "narrative",
    ]);
    expect(detail!.forms.find((x) => x.form === "ranked_list")!.count).toBe(0);
    expect(geoStructureDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("per engine: each engine carries its own distribution and total", () => {
    const { detail } = buildStructure(
      input({ forms: [f("gemini", "comparison_table", 20), f("claude", "narrative", 12, "demo"), f("claude", "ranked_list", 3, "demo")] }),
    );
    const claude = detail!.engines.find((e) => e.engine === "claude")!;
    expect(claude.total).toBe(15);
    expect(claude.forms.find((x) => x.form === "narrative")!.count).toBe(12);
    expect(detail!.engines.map((e) => e.engine)).toEqual(["claude", "gemini"]);
  });

  it("data_source is per engine, in the one live/demo/mixed vocabulary: mixed when an engine has both kinds of row", () => {
    const { detail } = buildStructure(
      input({
        forms: [
          f("gemini", "comparison_table", 30),
          f("claude", "narrative", 5, "demo"),
          f("claude", "ranked_list", 5, "live"),
          f("grok", "narrative", 5, "demo"),
        ],
      }),
    );
    expect(Object.fromEntries(detail!.engines.map((e) => [e.engine, e.data_source]))).toEqual({
      claude: "mixed",
      gemini: "live",
      grok: "demo",
    });
  });

  it("a tie for dominant breaks on the fixed form order, never on input order", () => {
    const a = buildStructure(input({ forms: [f("gemini", "narrative", 15), f("gemini", "ranked_list", 15)] }));
    const b = buildStructure(input({ forms: [f("gemini", "ranked_list", 15), f("gemini", "narrative", 15)] }));
    expect(a.detail!.dominant_form).toBe("ranked_list");
    expect(b.detail!.dominant_form).toBe("ranked_list");
  });

  it("#8 · a table-dominant cluster never fabricates a gap: page_forms [], template null, verdict no_action with its reason", () => {
    const { write, detail } = buildStructure(input());
    expect(detail!.page_forms).toEqual([]);
    expect(detail!.template).toBeNull();
    expect(detail!.rationale).toMatch(/no page crawl/i);
    expect(write.findings).toHaveLength(1);
    const finding = write.findings[0]!;
    expect(finding.no_action).toBe(true);
    expect(finding.task_rule_code).toBeUndefined();
    expect(finding.evidence[0]!.url).toBe("https://acme.com/");
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  it("the analysis publishes no score and promotes no lever", () => {
    const { write } = buildStructure(input());
    expect(write.score).toBeNull();
    expect(write.lever_rank).toBeNull();
    expect(write.analysis).toBe("structure");
    expect(write.sufficient).toBe(true);
    expect(write.evidence_cells).toBe(30);
  });

  it("#9 · position class movement is trended against the prior window", () => {
    const { detail, write } = buildStructure(
      input({
        position: [
          { cls: "recommendation", answers: 4 },
          { cls: "also_consider", answers: 6 },
        ],
        priorPosition: [
          { cls: "recommendation", answers: 8 },
          { cls: "also_consider", answers: 2 },
        ],
      }),
    );
    const rec = detail!.position.find((p) => p.cls === "recommendation")!;
    expect(rec.share).toBe(0.4);
    expect(rec.prior).toBe(0.8);
    expect(detail!.position.find((p) => p.cls === "also_consider")!.share).toBe(0.6);
    expect(detail!.brand_answers).toBe(10);
    expect(detail!.prior_brand_answers).toBe(10);
    expect(write.findings[0]!.headline).toMatch(/recommendation/i);
    expect(write.findings[0]!.headline).toMatch(/80%/);
    expect(write.findings[0]!.headline).toMatch(/40%/);
  });

  it("a class that vanished keeps a real 0 share, distinct from a null prior", () => {
    const { detail } = buildStructure(
      input({ position: [{ cls: "ranked", answers: 5 }], priorPosition: [{ cls: "caveat", answers: 5 }] }),
    );
    const caveat = detail!.position.find((p) => p.cls === "caveat")!;
    expect(caveat.share).toBe(0);
    expect(caveat.prior).toBe(1);
  });

  it("no prior brand answers: prior is null, not 0", () => {
    const { detail } = buildStructure(input({ position: [{ cls: "ranked", answers: 5 }], priorPosition: [] }));
    expect(detail!.position.every((p) => p.prior === null)).toBe(true);
    expect(detail!.prior_brand_answers).toBe(0);
  });

  it("the brand in no answer: position is [], not five zeros", () => {
    const { detail } = buildStructure(input());
    expect(detail!.position).toEqual([]);
    expect(detail!.brand_answers).toBe(0);
  });

  it("#10 · below the minimum the analysis suppresses itself with a stated reason, and publishes nothing", () => {
    const { write, detail } = buildStructure(input({ forms: [f("gemini", "comparison_table", STRUCTURE_MIN_ANSWERS - 1)] }));
    expect(write.sufficient).toBe(false);
    expect(write.suppression_reason).toMatch(/30/);
    expect(write.suppression_reason).toMatch(/29/);
    expect(write.findings).toEqual([]);
    expect(write.score).toBeNull();
    expect(write.evidence_cells).toBe(29);
    expect(detail).toBeNull();
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  it("boundary: exactly the minimum is sufficient", () => {
    expect(buildStructure(input({ forms: [f("gemini", "narrative", STRUCTURE_MIN_ANSWERS)] })).write.sufficient).toBe(true);
  });

  it("empty input: insufficient with 0 cells, no throw", () => {
    const { write, detail } = buildStructure(input({ forms: [] }));
    expect(write.sufficient).toBe(false);
    expect(write.evidence_cells).toBe(0);
    expect(detail).toBeNull();
  });

  it("the minimum is the catalogue's stated 30", () => {
    expect(STRUCTURE_MIN_ANSWERS).toBe(30);
  });
});

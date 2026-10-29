import { describe, expect, it } from "vitest";
import { geoAnalysisWriteSchema, geoStructureDetailSchema } from "../../../contracts/analytics/index.js";
import { buildStructure, STRUCTURE_MIN_ANSWERS, structurePageFrom, type StructureInput } from "../../../src/lib/geo/structure.js";

// STORY-060 — A3 answer structure. Scenario numbers refer to the story's
// table; #8 is deliberately NOT the story's "gap fires": the plan overrides it
// (no page crawl exists, so the gap is never asserted).

type FormRow = StructureInput["forms"][number];
const f = (
  engine: string,
  form: FormRow["form"],
  answers: number,
  dataSource: FormRow["dataSource"] = "live",
  cluster?: FormRow["cluster"],
): FormRow => ({
  engine,
  form,
  answers,
  dataSource,
  ...(cluster === undefined ? {} : { cluster }),
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

  // STORY-040 AC8 — the answer-form distribution per PROMPT CLUSTER (topic_clusters), not only per project and engine.
  describe("STORY-040 AC8 · per prompt cluster", () => {
    const pricing = { id: "00000000-0000-4000-8000-0000000000a1", label: "Pricing" };
    const features = { id: "00000000-0000-4000-8000-0000000000a2", label: "Features" };

    it("[AC8] each cluster carries its own distribution, dominant form and total", () => {
      const { detail } = buildStructure(
        input({
          forms: [
            f("gemini", "comparison_table", 25, "live", pricing),
            f("claude", "narrative", 8, "live", pricing),
            f("gemini", "narrative", 31, "live", features),
          ],
        }),
      );
      const byLabel = (label: string) => detail!.clusters!.find((c) => c.label === label)!;
      expect(byLabel("Pricing")).toMatchObject({ cluster_id: pricing.id, total: 33, dominant_form: "comparison_table", sufficient: true });
      expect(byLabel("Pricing")!.forms.find((x) => x.form === "narrative")!.count).toBe(8);
      expect(byLabel("Features")).toMatchObject({ total: 31, dominant_form: "narrative" });
      expect(geoStructureDetailSchema.safeParse(detail).success).toBe(true);
    });

    it("[AC8] and per engine inside each cluster", () => {
      const { detail } = buildStructure(
        input({ forms: [f("gemini", "comparison_table", 25, "live", pricing), f("claude", "narrative", 8, "live", pricing)] }),
      );
      const cluster = detail!.clusters![0]!;
      expect(cluster.engines.map((e) => [e.engine, e.total])).toEqual([["claude", 8], ["gemini", 25]]);
      expect(cluster.engines[1]!.forms.find((x) => x.form === "comparison_table")!.count).toBe(25);
    });

    it("[AC8] answers whose prompt has no cluster are reported as an unclustered entry, never dropped — the entries sum to the total", () => {
      const { detail } = buildStructure(
        input({ forms: [f("gemini", "narrative", 20, "live", pricing), f("gemini", "ranked_list", 12), f("gemini", "narrative", 3, "live", null)] }),
      );
      const unclustered = detail!.clusters!.find((c) => c.cluster_id === null)!;
      expect(unclustered).toMatchObject({ label: null, total: 15 });
      expect(detail!.clusters!.reduce((n, c) => n + c.total, 0)).toBe(detail!.total);
    });

    it("[AC8] a cluster under the evidence minimum is insufficient and names NO dominant form, even when the project as a whole is sufficient", () => {
      const { detail } = buildStructure(
        input({ forms: [f("gemini", "narrative", 40, "live", features), f("gemini", "comparison_table", STRUCTURE_MIN_ANSWERS - 1, "live", pricing)] }),
      );
      const thin = detail!.clusters!.find((c) => c.label === "Pricing")!;
      expect(thin).toMatchObject({ total: STRUCTURE_MIN_ANSWERS - 1, sufficient: false, dominant_form: null });
      expect(thin.forms.find((x) => x.form === "comparison_table")!.count).toBe(STRUCTURE_MIN_ANSWERS - 1);
    });

    it("[AC8] boundary: exactly the minimum is sufficient", () => {
      const { detail } = buildStructure(input({ forms: [f("gemini", "comparison_table", STRUCTURE_MIN_ANSWERS, "live", pricing)] }));
      expect(detail!.clusters![0]).toMatchObject({ sufficient: true, dominant_form: "comparison_table" });
    });

    it("[AC8] clusters are ordered by size, then id, so the output never depends on input order", () => {
      const a = buildStructure(input({ forms: [f("gemini", "narrative", 30, "live", pricing), f("gemini", "narrative", 40, "live", features), f("gemini", "narrative", 2)] }));
      const b = buildStructure(input({ forms: [f("gemini", "narrative", 2), f("gemini", "narrative", 40, "live", features), f("gemini", "narrative", 30, "live", pricing)] }));
      expect(a.detail!.clusters!.map((c) => c.label)).toEqual(["Features", "Pricing", null]);
      expect(b.detail!.clusters).toEqual(a.detail!.clusters);
    });

    it("[AC8] a detail persisted before clusters existed still validates (the member is optional, not required)", () => {
      const { detail } = buildStructure(input());
      const { clusters: _omitted, ...legacy } = detail!;
      expect(geoStructureDetailSchema.safeParse(legacy).success).toBe(true);
    });
  });
});

describe("STORY-060 · A3 structure-match gap (pure)", () => {
  const tableDominant = (): StructureInput["forms"] => [f("gemini", "comparison_table", 24, "live", { id: "11111111-1111-4111-8111-111111111111", label: "CRM pricing" }), f("gemini", "narrative", 6, "live", { id: "11111111-1111-4111-8111-111111111111", label: "CRM pricing" })];
  const prose = { url: "https://acme.com/pricing", tables: 0, lists: { ordered: 0, unordered: 2, definition: 0 } };

  it("#8 · prose-only brand page against a table-dominant cluster: the gap fires with a template and a task rule", () => {
    const { write, detail } = buildStructure(input({ forms: tableDominant(), pages: [prose] }));
    const gap = write.findings.find((x) => x.id.startsWith("structure-gap-"))!;
    expect(gap.task_rule_code).toBe("TG-STRUCTURE-TEMPLATE");
    expect(gap.no_action).toBeUndefined();
    expect(gap.evidence[0]!.url).toBe("https://acme.com/pricing");
    expect(gap.headline).toMatch(/CRM pricing/u);
    expect(detail!.template).toMatch(/\| .* \|/u);
    expect(detail!.template).toMatch(/CRM pricing/u);
    expect(detail!.page_forms).toEqual(["unordered_list"]);
    expect(detail!.rationale).toMatch(/neither a table nor a spec list/u);
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
    expect(geoStructureDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("no gap when any assessed page provides a table, or a definition (spec) list", () => {
    for (const page of [{ ...prose, tables: 1 }, { ...prose, lists: { ordered: 0, unordered: 0, definition: 1 } }]) {
      const { write } = buildStructure(input({ forms: tableDominant(), pages: [prose, page] }));
      expect(write.findings.some((x) => x.id.startsWith("structure-gap-"))).toBe(false);
    }
  });

  it("no gap when the dominant form is not a table, or the cluster is below the evidence minimum", () => {
    const narrative = buildStructure(input({ forms: [f("gemini", "narrative", 30)], pages: [prose] }));
    expect(narrative.write.findings.some((x) => x.id.startsWith("structure-gap-"))).toBe(false);
    const thin = buildStructure(input({ forms: [f("gemini", "comparison_table", 29, "live", { id: "11111111-1111-4111-8111-111111111111", label: "Thin" }), f("gemini", "narrative", 1)], pages: [prose] }));
    expect(thin.write.findings.some((x) => x.id.startsWith("structure-gap-"))).toBe(false);
  });

  it("one gap per table-dominant cluster, each with its own template", () => {
    const other = { id: "22222222-2222-4222-8222-222222222222", label: "CRM integrations" };
    const { write } = buildStructure(input({ forms: [...tableDominant(), f("gemini", "comparison_table", 30, "live", other)], pages: [prose] }));
    expect(write.findings.filter((x) => x.id.startsWith("structure-gap-")).map((x) => x.id).sort()).toEqual([
      "structure-gap-11111111-1111-4111-8111-111111111111",
      "structure-gap-22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("pages not assessed (undefined, null or an empty list) never fabricate a gap", () => {
    for (const pages of [undefined, null, []] as const) {
      const { write, detail } = buildStructure(input({ forms: tableDominant(), ...(pages === undefined ? {} : { pages }) }));
      expect(write.findings.some((x) => x.id.startsWith("structure-gap-"))).toBe(false);
      expect(detail!.template).toBeNull();
      expect(detail!.rationale).toMatch(/No page crawl/u);
    }
  });
});

describe("STORY-060 · a document model becomes an assessed page", () => {
  it("sums tables and each list kind over every block, and keeps the URL", () => {
    const block = (tables: number, ordered: number, unordered: number, definition: number) => ({ tables, lists: { ordered, unordered, definition } });
    expect(structurePageFrom({ url: "https://acme.com/p", blocks: [block(1, 0, 2, 0), block(0, 3, 0, 1), block(2, 0, 0, 0)] })).toEqual({
      url: "https://acme.com/p",
      tables: 3,
      lists: { ordered: 3, unordered: 2, definition: 1 },
    });
  });

  it("a page with no blocks is an assessed page with nothing on it (zeros, not null)", () => {
    expect(structurePageFrom({ url: "https://acme.com/", blocks: [] })).toEqual({ url: "https://acme.com/", tables: 0, lists: { ordered: 0, unordered: 0, definition: 0 } });
  });
});

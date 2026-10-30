import { describe, expect, it } from "vitest";
import { geoAnalysisWriteSchema, geoDivergenceDetailSchema } from "../../../contracts/analytics/index.js";
import {
  buildDivergence,
  compareLicensedSurfaces,
  DIVERGENCE_ALERT_MIN_PROMPTS,
  DIVERGENCE_ALERT_THRESHOLD,
  DIVERGENCE_MIN_PROMPTS,
  type DivergenceGeoInput,
  type DivergenceGeoPrompt,
} from "../../../src/lib/geo/divergence.js";

// STORY-061 - A4 divergence (pure). Scenario numbers are the story's table. The alert gate (>= 0.45 over >= 10 qualifying prompts) and
// the live-only mean are the NEW-C-12 owner-pending decision in the story's technical notes.

type R = DivergenceGeoPrompt["results"][number];
const live = (engine: string, positionClass: string | null, citedDomains: string[] = []): R => ({ engine, positionClass, dataSource: "live", citedDomains });
const demo = (engine: string, positionClass: string | null, citedDomains: string[] = []): R => ({ engine, positionClass, dataSource: "demo", citedDomains });
const prompt = (id: string, results: R[], stabilityScore: number | null = 1): DivergenceGeoPrompt => ({ promptId: id, stabilityScore, results });

/** n prompts where gemini recommends (citing docs.acme.com + g2.com) and perplexity omits (citing only g2.com). */
const divergent = (n: number, stability = 1): DivergenceGeoPrompt[] =>
  Array.from({ length: n }, (_, i) =>
    prompt(`p${String(i)}`, [live("gemini", "recommendation", ["docs.acme.com", "g2.com"]), live("perplexity", null, ["g2.com"])], stability),
  );

const input = (prompts: DivergenceGeoPrompt[], over: Partial<DivergenceGeoInput> = {}): DivergenceGeoInput => ({
  windowStart: "2026-09-02",
  windowDays: 30,
  rootDomain: "acme.com",
  prompts,
  contextWeights: { "docs.acme.com": 0.9, "g2.com": 0.4 },
  affinity: [],
  ...over,
});

describe("STORY-061 / A4 divergence (pure)", () => {
  it("[#1] one engine recommends and another omits: high divergence (1.0 - 0.0)", () => {
    const { detail } = buildDivergence(input(divergent(10)));
    expect(detail!.project_divergence).toBe(1);
    expect(detail!.prompts[0]).toMatchObject({ winning_engine: "gemini", losing_engine: "perplexity", divergence: 1 });
  });

  it("[#2] the same prompts, unstable: divergence is discounted by stability_score", () => {
    const { detail } = buildDivergence(input(divergent(10, 0.4)));
    expect(detail!.project_divergence).toBeCloseTo(0.4, 10);
    expect(detail!.prompts[0]!.stability_score).toBe(0.4);
  });

  it("[#3] a prompt with only one live engine result is excluded and counted, even beside a demo result", () => {
    const prompts = [...divergent(10), prompt("solo", [live("gemini", "ranked")]), prompt("mixed", [live("gemini", "ranked"), demo("perplexity", null)])];
    const { detail } = buildDivergence(input(prompts));
    expect(detail!.qualifying_prompts).toBe(10);
    expect(detail!.excluded.fewer_than_two_live_engines).toBe(2);
    expect(detail!.excluded.demo_results).toBe(1);
  });

  it("[AC2] a demo result never enters the mean: ten demo-only prompts are insufficient, not measured", () => {
    const demoOnly = Array.from({ length: 12 }, (_, i) => prompt(`d${String(i)}`, [demo("gemini", "recommendation"), demo("perplexity", null)]));
    const { write, detail } = buildDivergence(input(demoOnly));
    expect(write.sufficient).toBe(false);
    expect(write.suppression_reason).toMatch(/10 prompts/);
    expect(detail).toBeNull();
  });

  it("[#4] the divergent prompt names the domains the winner cited and the loser did not, ranked by context_weight", () => {
    const p = prompt("p", [live("gemini", "recommendation", ["a.com", "docs.acme.com", "g2.com"]), live("perplexity", null, ["g2.com"])]);
    const { detail } = buildDivergence(input([p, ...divergent(9)], { contextWeights: { "docs.acme.com": 0.9, "a.com": 0.2, "g2.com": 0.4 } }));
    const named = detail!.prompts.find((x) => x.prompt_id === "p")!;
    expect(named.missing_domains).toEqual([
      { domain: "docs.acme.com", context_weight: 0.9 },
      { domain: "a.com", context_weight: 0.2 },
    ]);
  });

  it("[#5] a divergence finding is engine-targeted: it names the losing engine and the missing domain, and carries the task rule", () => {
    const { write } = buildDivergence(input(divergent(10)));
    const f = write.findings[0]!;
    expect(f.id).toBe("divergence-perplexity-docs.acme.com");
    expect(f.task_rule_code).toBe("TG-DIVERGENCE");
    expect(f.engine).toBe("perplexity");
    expect(f.headline).toContain("perplexity");
    expect(f.headline).toContain("docs.acme.com");
    expect(geoAnalysisWriteSchema.safeParse(write).success).toBe(true);
  });

  it("[#5] below the alert (mean < 0.45) the same engines disagree but no task is asked for", () => {
    const { write, detail } = buildDivergence(input(divergent(10, 0.4)));
    expect(detail!.alert.crossed).toBe(false);
    expect(write.findings.every((f) => f.task_rule_code === undefined && f.no_action === true)).toBe(true);
  });

  it("[#5] the alert needs 10 qualifying prompts AND a mean at the threshold; the threshold itself crosses", () => {
    expect(DIVERGENCE_ALERT_THRESHOLD).toBe(0.45);
    expect(DIVERGENCE_ALERT_MIN_PROMPTS).toBe(10);
    expect(DIVERGENCE_MIN_PROMPTS).toBe(10);
    // 0.45 exactly: stability 0.45 on a 1.0 spread.
    expect(buildDivergence(input(divergent(10, 0.45))).detail!.alert.crossed).toBe(true);
    expect(buildDivergence(input(divergent(10, 0.449))).detail!.alert.crossed).toBe(false);
  });

  it("[AC4] the affinity map is rates over the engine's own answers, from the supplied history", () => {
    const { detail } = buildDivergence(
      input(divergent(10), {
        affinity: [
          { engine: "perplexity", answers: 4, domains: [{ domain: "g2.com", answersCiting: 3, sourceClass: "review_marketplace" }], citationsByClass: { review_marketplace: 3, blog: 1 } },
        ],
      }),
    );
    expect(detail!.affinity[0]).toMatchObject({ engine: "perplexity", answers: 4 });
    expect(detail!.affinity[0]!.domains[0]).toMatchObject({ domain: "g2.com", presence_rate: 0.75, source_class: "review_marketplace" });
    expect(detail!.affinity[0]!.source_classes).toEqual([
      { source_class: "review_marketplace", share: 0.75 },
      { source_class: "blog", share: 0.25 },
    ]);
  });

  it("[#6] the two licensed surfaces are compared on answers-citing-domain / answers, never on raw citation counts", () => {
    const out = compareLicensedSurfaces(
      { engine: "google_aio", answers: 10, domains: [{ domain: "g2.com", answersCiting: 5 }] },
      { engine: "google_ai_mode", answers: 20, domains: [{ domain: "g2.com", answersCiting: 5 }, { domain: "x.com", answersCiting: 20 }] },
    );
    expect(out).toEqual({
      status: "normalised",
      engines: ["google_aio", "google_ai_mode"],
      basis: "answers_citing_domain / answers",
      domains: [
        { domain: "g2.com", rate_a: 0.5, rate_b: 0.25 },
        { domain: "x.com", rate_a: 0, rate_b: 1 },
      ],
    });
  });

  it("[#6] the comparison is refused when a surface has no live answers, or the pair is not the two licensed surfaces", () => {
    const aio = { engine: "google_aio", answers: 10, domains: [] };
    expect(compareLicensedSurfaces(aio, { engine: "google_ai_mode", answers: 0, domains: [] })).toMatchObject({ status: "refused" });
    expect(compareLicensedSurfaces(aio, { engine: "gemini", answers: 10, domains: [] })).toMatchObject({ status: "refused" });
    expect(compareLicensedSurfaces(aio, aio)).toMatchObject({ status: "refused" });
  });

  it("[#13] below 10 qualifying prompts the analysis is suppressed with its reason and publishes nothing", () => {
    const { write, detail } = buildDivergence(input(divergent(9)));
    expect(write).toMatchObject({ sufficient: false, score: null, findings: [], lever_rank: null, evidence_cells: 9 });
    expect(write.suppression_reason).toMatch(/10 prompts.*live.*2 engines.*has 9/);
    expect(detail).toBeNull();
  });

  it("a null stability_score excludes the prompt and is counted, never assumed stable", () => {
    const { detail } = buildDivergence(input([...divergent(10), prompt("ns", [live("gemini", "ranked"), live("perplexity", null)], null)]));
    expect(detail!.qualifying_prompts).toBe(10);
    expect(detail!.excluded.no_stability).toBe(1);
  });

  it("null and zero stay distinct: engines that agree are a divergence of 0, not null", () => {
    const agree = Array.from({ length: 10 }, (_, i) => prompt(`a${String(i)}`, [live("gemini", "ranked"), live("perplexity", "ranked")]));
    const { detail, write } = buildDivergence(input(agree));
    expect(detail!.project_divergence).toBe(0);
    expect(write.score).toBe(0);
    expect(write.findings[0]).toMatchObject({ no_action: true });
  });

  it("a stored class with no o(e) (also_consider, caveat) is dropped and counted, not guessed", () => {
    const p = prompt("u", [live("gemini", "also_consider"), live("perplexity", "ranked")]);
    const { detail } = buildDivergence(input([p, ...divergent(10)]));
    expect(detail!.excluded.unscored_results).toBe(1);
    expect(detail!.excluded.fewer_than_two_live_engines).toBe(1);
  });

  it("the detail satisfies its contract and the finding that carries it is the first", () => {
    const { write, detail } = buildDivergence(input(divergent(10)));
    expect(geoDivergenceDetailSchema.safeParse(detail).success).toBe(true);
    expect(write.findings[0]!.divergence).toEqual(detail);
    expect(write.findings.slice(1).every((f) => f.divergence === undefined)).toBe(true);
  });

  it("targets aggregate across prompts per (losing engine, domain), ranked by context_weight then prompts", () => {
    const { detail } = buildDivergence(input(divergent(10)));
    expect(detail!.targets[0]).toMatchObject({ losing_engine: "perplexity", domain: "docs.acme.com", prompts: 10, winning_engines: ["gemini"] });
  });
});

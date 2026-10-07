import { describe, expect, it } from "vitest";
import {
  DIVERGENCE_OUTCOME,
  crossEngineDivergence,
  divergenceClassFor,
  type DivergenceEngineResult,
  type DivergencePromptInput,
} from "../../../src/lib/scoring/index.js";

// NEW-C-12 / STORY-061 "Divergence" — `scoring-models.md` §10 (A4).
// Every expected value below is computed by hand from the reference, not
// by running the function:
//   o: absent 0.0 · neutral 0.4 · ranked 0.7 · recommendation 1.0
//   divergence(p) = (max o − min o) · stability_score(p)
//   project       = mean over prompts with >= 2 engines returning a result

const r = (
  engine: string,
  positionClass: DivergenceEngineResult["positionClass"],
  citedDomains: string[] = [],
  dataSource: DivergenceEngineResult["dataSource"] = "live",
): DivergenceEngineResult => ({ engine, positionClass, citedDomains, dataSource });

const prompt = (
  promptId: string,
  stabilityScore: number | null,
  engines: DivergenceEngineResult[],
): DivergencePromptInput => ({ promptId, stabilityScore, engines });

const run = (prompts: DivergencePromptInput[], contextWeights: Record<string, number> = {}) =>
  crossEngineDivergence({ prompts, contextWeights });

describe("NEW-C-12 · A4 outcome mapping", () => {
  it("[A4-1] o(e) is exactly 0 / 0.4 / 0.7 / 1.0 for absent / neutral / ranked / recommendation", () => {
    expect(DIVERGENCE_OUTCOME).toEqual({ absent: 0, neutral: 0.4, ranked: 0.7, recommendation: 1 });
  });
});

describe("NEW-C-12 · per-prompt divergence", () => {
  it("[A4-2] recommendation vs absent on a perfectly stable prompt = (1.0 − 0.0)·1 = 1.0", () => {
    const out = run([prompt("p1", 1, [r("gemini", "recommendation"), r("chatgpt", "absent")])]);
    expect(out.prompts[0]!.divergence).toBe(1);
    expect(out.projectDivergence).toBe(1);
  });

  it("[A4-3] the same prompt at stability 0.5 is discounted by (1 − 0.5): 1.0·0.5 = 0.5", () => {
    const out = run([prompt("p1", 0.5, [r("gemini", "recommendation"), r("chatgpt", "absent")])]);
    expect(out.prompts[0]!.divergence).toBeCloseTo(0.5, 12);
  });

  it("[A4-4] ranked vs neutral at stability 0.8 = (0.7 − 0.4)·0.8 = 0.24", () => {
    const out = run([prompt("p1", 0.8, [r("gemini", "ranked"), r("chatgpt", "neutral")])]);
    expect(out.prompts[0]!.divergence).toBeCloseTo(0.24, 12);
  });

  it("[A4-5] a prompt at stability 0 diverges for its own reasons: 0, and no attribution", () => {
    const out = run([prompt("p1", 0, [r("gemini", "recommendation", ["a.com"]), r("chatgpt", "absent")])], { "a.com": 1 });
    expect(out.prompts[0]!.divergence).toBe(0);
    expect(out.prompts[0]!.attribution).toBeNull();
  });

  it("[A4-6] the spread uses max and min across THREE engines: (1.0 − 0.4)·1 = 0.6", () => {
    const out = run([prompt("p1", 1, [r("a", "ranked"), r("b", "recommendation"), r("c", "neutral")])]);
    expect(out.prompts[0]!.divergence).toBeCloseTo(0.6, 12);
  });

  it("[A4-7] engines that agree: divergence 0 (a real zero, not null)", () => {
    const out = run([prompt("p1", 1, [r("a", "ranked"), r("b", "ranked")])]);
    expect(out.prompts[0]!.divergence).toBe(0);
    expect(out.projectDivergence).toBe(0);
  });
});

describe("NEW-C-12 · which prompts qualify", () => {
  it("[A4-8] a prompt with only one engine result is excluded, and counted", () => {
    const out = run([
      prompt("solo", 1, [r("gemini", "recommendation")]),
      prompt("pair", 1, [r("gemini", "ranked"), r("chatgpt", "neutral")]),
    ]);
    expect(out.prompts.map((p) => p.promptId)).toEqual(["pair"]);
    expect(out.qualifyingPrompts).toBe(1);
    expect(out.excluded).toEqual({ fewerThanTwoEngines: 1, noStability: 0, unscoredResults: 0 });
    // The excluded solo prompt must not dilute the mean: (0.7 - 0.4) * 1 = 0.3, over ONE prompt.
    expect(out.projectDivergence).toBeCloseTo(0.3, 12);
  });

  it("[A4-8b] a null-stability prompt does not dilute the mean: it equals the qualifying prompt's value alone", () => {
    const out = run([
      prompt("stable", 1, [r("a", "recommendation"), r("b", "absent")]),
      prompt("unmeasured", null, [r("a", "recommendation"), r("b", "absent")]),
    ]);
    expect(out.qualifyingPrompts).toBe(1);
    expect(out.projectDivergence).toBeCloseTo(1, 12);
  });

  it("[A4-9] no qualifying prompt = null (nothing measured), never 0", () => {
    expect(run([]).projectDivergence).toBeNull();
    expect(run([prompt("solo", 1, [r("gemini", "ranked")])]).projectDivergence).toBeNull();
  });

  it("[A4-10] a prompt with no stability score cannot be discounted, so it is excluded and counted, not assumed stable", () => {
    const out = run([prompt("p1", null, [r("a", "recommendation"), r("b", "absent")])]);
    expect(out.qualifyingPrompts).toBe(0);
    expect(out.projectDivergence).toBeNull();
    expect(out.excluded.noStability).toBe(1);
  });

  it("[A4-11] project divergence is the mean of the qualifying prompts: (1.0 + 0.24) / 2 = 0.62", () => {
    const out = run([
      prompt("p1", 1, [r("a", "recommendation"), r("b", "absent")]),
      prompt("p2", 0.8, [r("a", "ranked"), r("b", "neutral")]),
    ]);
    expect(out.projectDivergence).toBeCloseTo(0.62, 12);
    expect(out.qualifyingPrompts).toBe(2);
  });
});

describe("NEW-C-12 · attribution by citation-domain set difference", () => {
  it("[A4-12] names winner-only domains, ranked by context_weight; shared domains are not named", () => {
    const out = run(
      [
        prompt("p1", 1, [
          r("gemini", "recommendation", ["low.com", "shared.com", "high.com", "mid.com"]),
          r("chatgpt", "absent", ["shared.com", "other.com"]),
        ]),
      ],
      { "high.com": 0.5, "mid.com": 0.2, "low.com": 0.05, "shared.com": 0.9, "other.com": 0.3 },
    );
    const a = out.prompts[0]!.attribution!;
    expect(a.winningEngine).toBe("gemini");
    expect(a.losingEngine).toBe("chatgpt");
    expect(a.domains).toEqual([
      { domain: "high.com", contextWeight: 0.5 },
      { domain: "mid.com", contextWeight: 0.2 },
      { domain: "low.com", contextWeight: 0.05 },
    ]);
  });

  it("[A4-13] a domain with no known context_weight is named last at weight 0; ties break by domain ascending", () => {
    const out = run(
      [prompt("p1", 1, [r("a", "ranked", ["z.com", "unknown.com", "b.com"]), r("b", "neutral", [])])],
      { "z.com": 0.1, "b.com": 0.1 },
    );
    expect(out.prompts[0]!.attribution!.domains.map((d) => d.domain)).toEqual(["b.com", "z.com", "unknown.com"]);
  });

  it("[A4-14] duplicate cited domains are counted once", () => {
    const out = run([prompt("p1", 1, [r("a", "ranked", ["x.com", "x.com"]), r("b", "neutral")])], { "x.com": 0.4 });
    expect(out.prompts[0]!.attribution!.domains).toEqual([{ domain: "x.com", contextWeight: 0.4 }]);
  });

  it("[A4-15] a divergent prompt whose winner cites nothing the loser lacks has an empty named set, not null", () => {
    const out = run([prompt("p1", 1, [r("a", "ranked", ["x.com"]), r("b", "absent", ["x.com"])])], { "x.com": 1 });
    expect(out.prompts[0]!.attribution!.domains).toEqual([]);
  });

  it("[A4-16] no divergence = no attribution", () => {
    const out = run([prompt("p1", 1, [r("a", "ranked", ["x.com"]), r("b", "ranked", [])])]);
    expect(out.prompts[0]!.attribution).toBeNull();
  });

  it("[A4-17] among tied winners and losers the engine name ascending is chosen, so output is deterministic", () => {
    const out = run([
      prompt("p1", 1, [r("zeta", "recommendation"), r("beta", "recommendation"), r("omega", "absent"), r("alpha", "absent")]),
    ]);
    expect(out.prompts[0]!.attribution!.winningEngine).toBe("beta");
    expect(out.prompts[0]!.attribution!.losingEngine).toBe("alpha");
  });
});

describe("NEW-C-12 · demo engines are counted and labelled", () => {
  it("[A4-18] a live + demo pair qualifies, and is labelled mixed", () => {
    const out = run([prompt("p1", 1, [r("gemini", "recommendation", [], "live"), r("chatgpt", "absent", [], "demo")])]);
    expect(out.qualifyingPrompts).toBe(1);
    expect(out.prompts[0]!.dataSource).toBe("mixed");
    expect(out.dataSource).toBe("mixed");
    expect(out.prompts[0]!.engines).toEqual([
      { engine: "chatgpt", dataSource: "demo" },
      { engine: "gemini", dataSource: "live" },
    ]);
  });

  it("[A4-19] all-live is 'live', all-demo is 'demo', nothing measured is null", () => {
    const live = run([prompt("p1", 1, [r("a", "ranked"), r("b", "neutral")])]);
    const demo = run([prompt("p1", 1, [r("a", "ranked", [], "demo"), r("b", "neutral", [], "demo")])]);
    expect(live.dataSource).toBe("live");
    expect(demo.dataSource).toBe("demo");
    expect(run([]).dataSource).toBeNull();
  });

  it("[A4-20] data_source is mixed across prompts when one prompt is live and another demo", () => {
    const out = run([
      prompt("p1", 1, [r("a", "ranked"), r("b", "neutral")]),
      prompt("p2", 1, [r("a", "ranked", [], "demo"), r("b", "neutral", [], "demo")]),
    ]);
    expect(out.dataSource).toBe("mixed");
  });
});

describe("NEW-C-12 · fail closed on bad input", () => {
  it("[A4-21] an unknown position class throws rather than scoring as 0", () => {
    expect(() => run([prompt("p1", 1, [r("a", "bogus" as never), r("b", "ranked")])])).toThrow(/position class/i);
  });

  it("[A4-22] the same engine twice in one prompt throws — the caller must collapse to one result per engine", () => {
    expect(() => run([prompt("p1", 1, [r("a", "ranked"), r("a", "neutral")])])).toThrow(/duplicate engine/i);
  });

  it("[A4-23] stability outside [0,1] is clamped; NaN is treated as no stability", () => {
    const hi = run([prompt("p1", 1.5, [r("a", "recommendation"), r("b", "absent")])]);
    const lo = run([prompt("p1", -1, [r("a", "recommendation"), r("b", "absent")])]);
    const nan = run([prompt("p1", Number.NaN, [r("a", "recommendation"), r("b", "absent")])]);
    expect(hi.projectDivergence).toBe(1);
    expect(lo.projectDivergence).toBe(0);
    expect(nan.projectDivergence).toBeNull();
    expect(nan.excluded.noStability).toBe(1);
  });
});

describe("NEW-C-12 audit · the stored position_class domain maps to o(e) in the library", () => {
  it("[A4-24] every stored mention_facts.position_class maps; 'neutral_list' is the reference's 'neutral list'", () => {
    expect(divergenceClassFor("recommendation")).toBe("recommendation");
    expect(divergenceClassFor("ranked")).toBe("ranked");
    expect(divergenceClassFor("neutral_list")).toBe("neutral");
  });

  it("[A4-25] no mention at all (null) and 'absent' are o = 0.0", () => {
    expect(divergenceClassFor(null)).toBe("absent");
    expect(divergenceClassFor("absent")).toBe("absent");
  });

  it("[A4-26] 'also_consider' and 'caveat' have no o(e) in the reference: they are 'unscored', never a throw and never a guessed number", () => {
    expect(divergenceClassFor("also_consider")).toBe("unscored");
    expect(divergenceClassFor("caveat")).toBe("unscored");
  });

  it("[A4-27] a value outside the stored domain still fails closed", () => {
    expect(() => divergenceClassFor("bogus")).toThrow(/position class/i);
  });

  it("[A4-28] an unscored result is dropped from its prompt and counted, so it can neither raise nor dilute divergence", () => {
    const out = run([
      prompt("p1", 1, [r("a", "recommendation"), r("b", "absent"), r("c", "unscored")]),
      // Dropping the unscored result leaves one engine: the prompt is excluded as a solo prompt.
      prompt("p2", 1, [r("a", "ranked"), r("c", "unscored")]),
    ]);
    expect(out.qualifyingPrompts).toBe(1);
    expect(out.projectDivergence).toBeCloseTo(1, 12);
    expect(out.excluded).toEqual({ fewerThanTwoEngines: 1, noStability: 0, unscoredResults: 2 });
  });
});

describe("NEW-C-12 audit · live-only divergence for the alert (owner decision on demo-as-live is open)", () => {
  it("[A4-29] the live-only mean uses prompts with >= 2 LIVE results, computed over the live results", () => {
    const out = run([
      prompt("liveLive", 1, [r("a", "recommendation"), r("b", "absent")]),
      prompt("liveDemo", 1, [r("a", "recommendation", [], "live"), r("b", "absent", [], "demo")]),
    ]);
    expect(out.qualifyingPrompts).toBe(2);
    expect(out.projectDivergence).toBeCloseTo(1, 12);
    expect(out.qualifyingLivePrompts).toBe(1);
    expect(out.projectDivergenceLive).toBeCloseTo(1, 12);
    expect(out.prompts.find((p) => p.promptId === "liveDemo")!.divergenceLive).toBeNull();
  });

  it("[A4-30] a live+demo-only workload has no live mean (null, not 0) while the blended mean still exists", () => {
    const out = run([prompt("p1", 1, [r("a", "recommendation", [], "live"), r("b", "absent", [], "demo")])]);
    expect(out.projectDivergence).toBeCloseTo(1, 12);
    expect(out.qualifyingLivePrompts).toBe(0);
    expect(out.projectDivergenceLive).toBeNull();
  });

  it("[A4-31] a demo engine does not move the live mean: three engines, one demo, live pair decides", () => {
    const out = run([prompt("p1", 1, [r("a", "ranked"), r("b", "neutral"), r("c", "recommendation", [], "demo")])]);
    expect(out.projectDivergence).toBeCloseTo(0.6, 12);
    expect(out.projectDivergenceLive).toBeCloseTo(0.3, 12);
  });

  it("[A4-32] live engines that agree are 0, distinct from null", () => {
    const out = run([prompt("p1", 1, [r("a", "ranked"), r("b", "ranked")])]);
    expect(out.projectDivergenceLive).toBe(0);
    expect(out.qualifyingLivePrompts).toBe(1);
  });
});

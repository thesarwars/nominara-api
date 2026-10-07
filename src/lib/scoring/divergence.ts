// NEW-C-12 / STORY-061 "Divergence" — `scoring-models.md` §10, A4.
//
// ⚠ IMPORTS NOTHING. See prominence.ts.
//
//   o(e)               absent 0.0 · neutral 0.4 · ranked 0.7 · recommendation 1.0
//   divergence(p)      (max_e o(e) − min_e o(e)) · (1 − stability_penalty)
//   stability_penalty  1 − stability_score(p)      so the factor is stability_score(p)
//   project_divergence mean over prompts with >= 2 engines returning a result
//   attribution        citation-domain SET DIFFERENCE, winner minus loser,
//                      ranked by each domain's context_weight

/** §10 — `o(e)` by `position_class`, verbatim. */
export const DIVERGENCE_OUTCOME = Object.freeze({
  absent: 0.0,
  neutral: 0.4,
  ranked: 0.7,
  recommendation: 1.0,
});

export type DivergencePositionClass = keyof typeof DIVERGENCE_OUTCOME;

/**
 * Stored `mention_facts.position_class` -> the class `o(e)` is defined for.
 *
 * `neutral_list` is the reference's "neutral list". A brand with no mention is
 * `null` (no row) or 'absent'. `also_consider` and `caveat` have NO `o(e)` in
 * §10 A4 (reference gap, escalated to the owner): they are 'unscored' —
 * dropped from the prompt and counted, never a guessed number, never a throw
 * (a throw here would abort the daily rollup). Anything outside the stored
 * domain still fails closed.
 */
export function divergenceClassFor(stored: string | null): DivergencePositionClass | "unscored" {
  if (stored === null || stored === "absent") return "absent";
  switch (stored) {
    case "recommendation":
    case "ranked":
      return stored;
    case "neutral_list":
      return "neutral";
    case "also_consider":
    case "caveat":
      return "unscored";
    default:
      throw new RangeError(`unknown position class: ${stored}`);
  }
}

/** The one `data_source` vocabulary: `null` means nothing was measured. */
export type DivergenceDataSource = "live" | "demo" | "mixed";

export interface DivergenceEngineResult {
  readonly engine: string;
  /** 'unscored' = a stored class the reference gives no o(e); see `divergenceClassFor`. */
  readonly positionClass: DivergencePositionClass | "unscored";
  /** Domains this engine's answer cited for the prompt. */
  readonly citedDomains: readonly string[];
  /** Seeded demo engines count as results but are labelled, never passed off as live. */
  readonly dataSource: "live" | "demo";
}

export interface DivergencePromptInput {
  readonly promptId: string;
  /** `stability_score(p)` in [0,1]; `null` when never measured. */
  readonly stabilityScore: number | null;
  /** At most one result per engine. */
  readonly engines: readonly DivergenceEngineResult[];
}

export interface DivergenceInput {
  readonly prompts: readonly DivergencePromptInput[];
  /** `context_weight` by domain; a domain absent from the map weighs 0. */
  readonly contextWeights: Readonly<Record<string, number>>;
}

export interface DivergenceAttribution {
  readonly winningEngine: string;
  readonly losingEngine: string;
  /** Domains the winner cited and the loser did not, by `context_weight` desc then domain asc. */
  readonly domains: readonly { readonly domain: string; readonly contextWeight: number }[];
}

export interface PromptDivergence {
  readonly promptId: string;
  readonly divergence: number;
  /** The same formula over the LIVE results only; `null` with fewer than 2 live results. */
  readonly divergenceLive: number | null;
  /** `null` when the prompt does not diverge. */
  readonly attribution: DivergenceAttribution | null;
  readonly dataSource: DivergenceDataSource;
  readonly engines: readonly { readonly engine: string; readonly dataSource: "live" | "demo" }[];
}

export interface DivergenceResult {
  readonly prompts: readonly PromptDivergence[];
  /** `null` = no qualifying prompt (nothing measured); `0` = engines agree. */
  readonly projectDivergence: number | null;
  readonly qualifyingPrompts: number;
  /**
   * Reference §10 A4 says "live" results. Whether seeded demo results may count is an OPEN
   * owner decision, so the live-only mean is exposed for any alert to gate on:
   * `null` = no prompt with >= 2 live results; `0` = those engines agree.
   */
  readonly projectDivergenceLive: number | null;
  readonly qualifyingLivePrompts: number;
  readonly excluded: {
    readonly fewerThanTwoEngines: number;
    readonly noStability: number;
    /** Engine results whose stored class has no o(e) in the reference. */
    readonly unscoredResults: number;
  };
  readonly dataSource: DivergenceDataSource | null;
}

function combine(sources: readonly DivergenceDataSource[]): DivergenceDataSource | null {
  if (sources.length === 0) return null;
  const live = sources.some((s) => s === "live" || s === "mixed");
  const demo = sources.some((s) => s === "demo" || s === "mixed");
  return live && demo ? "mixed" : live ? "live" : "demo";
}

function outcome(positionClass: string): number {
  if (positionClass === "unscored") throw new RangeError("unscored results are dropped before scoring");
  if (!Object.hasOwn(DIVERGENCE_OUTCOME, positionClass)) {
    throw new RangeError(`unknown position class: ${positionClass}`);
  }
  return DIVERGENCE_OUTCOME[positionClass as DivergencePositionClass];
}

const byEngine = (a: DivergenceEngineResult, b: DivergenceEngineResult): number =>
  a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : 0;

export function crossEngineDivergence(input: DivergenceInput): DivergenceResult {
  const prompts: PromptDivergence[] = [];
  let fewer = 0;
  let noStability = 0;
  let unscored = 0;

  for (const prompt of input.prompts) {
    const seen = new Set<string>();
    for (const e of prompt.engines) {
      if (seen.has(e.engine)) throw new RangeError(`duplicate engine in prompt ${prompt.promptId}: ${e.engine}`);
      seen.add(e.engine);
    }
    // Validate every class even for prompts that will be excluded.
    const all = prompt.engines.map((e) => ({ e, o: e.positionClass === "unscored" ? null : outcome(e.positionClass) }));
    unscored += all.filter((s) => s.o === null).length;
    const scored = all.filter((s): s is { e: DivergenceEngineResult; o: number } => s.o !== null);
    if (scored.length < 2) {
      fewer += 1;
      continue;
    }
    const raw = prompt.stabilityScore;
    if (raw === null || !Number.isFinite(raw)) {
      noStability += 1;
      continue;
    }
    const stability = Math.min(1, Math.max(0, raw));

    const sorted = [...scored].sort((a, b) => byEngine(a.e, b.e));
    const max = Math.max(...sorted.map((s) => s.o));
    const min = Math.min(...sorted.map((s) => s.o));
    const divergence = (max - min) * stability;

    let attribution: DivergenceAttribution | null = null;
    if (divergence > 0) {
      const winner = sorted.find((s) => s.o === max)!.e;
      const loser = sorted.find((s) => s.o === min)!.e;
      const loserDomains = new Set(loser.citedDomains);
      const named = [...new Set(winner.citedDomains)]
        .filter((d) => !loserDomains.has(d))
        .map((domain) => ({ domain, contextWeight: input.contextWeights[domain] ?? 0 }))
        .sort((a, b) => b.contextWeight - a.contextWeight || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
      attribution = { winningEngine: winner.engine, losingEngine: loser.engine, domains: named };
    }

    const live = sorted.filter((s) => s.e.dataSource === "live");
    const divergenceLive =
      live.length < 2 ? null : (Math.max(...live.map((s) => s.o)) - Math.min(...live.map((s) => s.o))) * stability;

    prompts.push({
      promptId: prompt.promptId,
      divergence,
      divergenceLive,
      attribution,
      dataSource: combine(sorted.map((s) => s.e.dataSource))!,
      engines: sorted.map((s) => ({ engine: s.e.engine, dataSource: s.e.dataSource })),
    });
  }

  const liveValues = prompts.flatMap((p) => (p.divergenceLive === null ? [] : [p.divergenceLive]));
  return {
    prompts,
    projectDivergence: prompts.length === 0 ? null : prompts.reduce((sum, p) => sum + p.divergence, 0) / prompts.length,
    qualifyingPrompts: prompts.length,
    projectDivergenceLive: liveValues.length === 0 ? null : liveValues.reduce((a, b) => a + b, 0) / liveValues.length,
    qualifyingLivePrompts: liveValues.length,
    excluded: { fewerThanTwoEngines: fewer, noStability, unscoredResults: unscored },
    dataSource: combine(prompts.map((p) => p.dataSource)),
  };
}

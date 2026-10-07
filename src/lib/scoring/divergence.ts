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

/** The one `data_source` vocabulary: `null` means nothing was measured. */
export type DivergenceDataSource = "live" | "demo" | "mixed";

export interface DivergenceEngineResult {
  readonly engine: string;
  readonly positionClass: DivergencePositionClass;
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
  readonly excluded: { readonly fewerThanTwoEngines: number; readonly noStability: number };
  readonly dataSource: DivergenceDataSource | null;
}

function combine(sources: readonly DivergenceDataSource[]): DivergenceDataSource | null {
  if (sources.length === 0) return null;
  const live = sources.some((s) => s === "live" || s === "mixed");
  const demo = sources.some((s) => s === "demo" || s === "mixed");
  return live && demo ? "mixed" : live ? "live" : "demo";
}

function outcome(positionClass: string): number {
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

  for (const prompt of input.prompts) {
    const seen = new Set<string>();
    for (const e of prompt.engines) {
      if (seen.has(e.engine)) throw new RangeError(`duplicate engine in prompt ${prompt.promptId}: ${e.engine}`);
      seen.add(e.engine);
    }
    // Validate every class even for prompts that will be excluded.
    const scored = prompt.engines.map((e) => ({ e, o: outcome(e.positionClass) }));
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

    prompts.push({
      promptId: prompt.promptId,
      divergence,
      attribution,
      dataSource: combine(sorted.map((s) => s.e.dataSource))!,
      engines: sorted.map((s) => ({ engine: s.e.engine, dataSource: s.e.dataSource })),
    });
  }

  return {
    prompts,
    projectDivergence: prompts.length === 0 ? null : prompts.reduce((sum, p) => sum + p.divergence, 0) / prompts.length,
    qualifyingPrompts: prompts.length,
    excluded: { fewerThanTwoEngines: fewer, noStability },
    dataSource: combine(prompts.map((p) => p.dataSource)),
  };
}

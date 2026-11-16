import type { ToolKey, ToolRunConversion, ToolRunStatus } from "../../../contracts/tools/index.js";

// STORY-078 AC16..AC20 (FR-TL-09) - ONE conversion contract for all six entry points. The same function answers for every tool: it
// copies whichever inputs the source tool produced, and nothing tool-specific branches here. A tool that produced no URL is
// "unavailable: no_url" so the caller supplies one; a URL is never guessed.

export interface ConvertibleRun {
  readonly tool_key: ToolKey;
  readonly status: ToolRunStatus;
  readonly brand_name: string | null;
  readonly brand_url: string | null;
  readonly target_url: string | null;
  readonly query_text: string | null;
  readonly prompt_texts: readonly string[] | null;
  readonly converted_project_id: string | null;
  /** Read for one documented key only: `competitors` (see below). An expired run has none. */
  readonly result_json?: Readonly<Record<string, unknown>> | null;
  /** The engines that answered the run: they are the suggested engines (FR-SCAN-01g). Kept on the row, so an expired run still has them. */
  readonly engines_succeeded?: readonly string[];
}

export type ToolConversionPlan = Pick<ToolRunConversion, "state" | "reason" | "credits" | "prefill">;

// COMPETITORS (FR-VS-06, api-specification section 9 `convert_cta.prefill`). There is no competitors column, so a tool that finds competitors
// (Competitor Finder, Visibility Scan) writes them to `result_json.competitors` as an array of names - that key is the contract, and each
// such tool's own story must write it. They live and die with the payload: an expired run has none to carry.
function competitorsOf(resultJson: ConvertibleRun["result_json"]): string[] {
  const raw = resultJson?.["competitors"];
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === "" || seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
  }
  return names;
}

export function toolConversionPlan(run: ConvertibleRun): ToolConversionPlan {
  const seen = new Set<string>();
  const prompts: string[] = [];
  for (const text of [...(run.prompt_texts ?? []), ...(run.query_text === null ? [] : [run.query_text])]) {
    const trimmed = text.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === "" || seen.has(key)) continue;
    seen.add(key);
    prompts.push(trimmed);
  }
  const rootUrl = run.brand_url ?? run.target_url;
  // SUGGESTED ENGINES (STORY-095 AC13): the engines that answered, in the run's order. A tool that ran none (Schema Builder) suggests none.
  const engines = [...new Set(run.engines_succeeded ?? [])];
  const prefill = { project_name: run.brand_name, root_url: rootUrl, prompts, competitors: competitorsOf(run.result_json), engines };

  // `converted` wins over everything: converting a second time returns the first project (AC20) whatever the run looks like now.
  if (run.converted_project_id !== null) return { state: "converted", reason: null, credits: 0, prefill };
  // An EXPIRED run still converts: only its payload is gone, the inputs it copies are kept verbatim on the row.
  if (run.status === "running") return { state: "unavailable", reason: "run_not_finished", credits: 0, prefill };
  if (run.status === "failed") return { state: "unavailable", reason: "run_failed", credits: 0, prefill };
  if (rootUrl === null) return { state: "unavailable", reason: "no_url", credits: 0, prefill };
  return { state: "available", reason: null, credits: 0, prefill };
}

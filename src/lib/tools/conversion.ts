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
}

export type ToolConversionPlan = Pick<ToolRunConversion, "state" | "reason" | "credits" | "prefill">;

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
  const prefill = { project_name: run.brand_name, root_url: rootUrl, prompts };

  // `converted` wins over everything: converting a second time returns the first project (AC20) whatever the run looks like now.
  if (run.converted_project_id !== null) return { state: "converted", reason: null, credits: 0, prefill };
  // An EXPIRED run still converts: only its payload is gone, the inputs it copies are kept verbatim on the row.
  if (run.status === "running") return { state: "unavailable", reason: "run_not_finished", credits: 0, prefill };
  if (run.status === "failed") return { state: "unavailable", reason: "run_failed", credits: 0, prefill };
  if (rootUrl === null) return { state: "unavailable", reason: "no_url", credits: 0, prefill };
  return { state: "available", reason: null, credits: 0, prefill };
}

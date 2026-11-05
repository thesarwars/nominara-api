// STORY-079 - FR-TL-07: the PLAN determines the Tools engine set; there is no picker.
//
// The set is the first `tools.engine_set` engines, in a FIXED order, from the engines that the plan is entitled to AND that this build can actually
// capture on. "Can capture" is the registry's own answer (`captureReadyEngineKeys`), so an engine appears here the day its adapter is bound and
// not before: planning a fixture engine would manufacture a failure out of something never attempted (registry.ts).
//
// BUILDER PROPOSAL (owner to confirm the order): perplexity, chatgpt, gemini, then the two Google surfaces. plans-and-entitlements.md gives the
// COUNT per tier (2/3/4/4/4) and names perplexity and chatgpt as the free tier's two; it does not order the rest.
export const SCAN_ENGINE_PREFERENCE = ["perplexity", "chatgpt", "gemini", "google_aio", "google_ai_mode"] as const;

/**
 * Engines that never run in Tools: the most expensive one (FR-TL-07, "the two most expensive engines never run in Tools"; owner decision 26
 * lets Gemini in, so Claude is the one left). The same fact is `tool_runs.ck_tr_engine_set` - a constraint, so a new call site cannot bypass it.
 * This list keeps a scan from ever proposing a row the database would refuse.
 */
export const SCAN_EXCLUDED_ENGINES: readonly string[] = ["claude"];

export interface ScanEngineSetInput {
  /** `tools.engine_set` from the workspace's resolved entitlements. */
  readonly size: number;
  /** Engines the workspace's plan may use (the catalog's plan floor). */
  readonly entitled: readonly string[];
  /** `captureReadyEngineKeys()`. */
  readonly captureReady: readonly string[];
}

export function selectScanEngines(input: ScanEngineSetInput): string[] {
  if (!Number.isInteger(input.size) || input.size <= 0) return [];
  const entitled = new Set(input.entitled);
  const ready = new Set(input.captureReady);
  return SCAN_ENGINE_PREFERENCE.filter((engine) => !SCAN_EXCLUDED_ENGINES.includes(engine) && entitled.has(engine) && ready.has(engine)).slice(0, input.size);
}

import type { ToolHeadlineField, ToolKey, ToolRunHeadline, ToolRunPresentation } from "../../../contracts/tools/index.js";

// STORY-078 AC21 + AC22 (FR-TL-08, FR-VS-05) - what EVERY result envelope carries, whatever the tool.
//
// BUILDER COPY, owner to review: `NOT_TRACKED_NOTE` is ui-ux-guidelines.md section 5's `tools_not_tracked` verbatim. The per-tool
// "did not check" lines are written here from each tool's own scope statement in the product spec (FR-TL-01..05, page-inventory
// FR-TL-02c); the references give the rule ("a one-line statement of what the tool did not check") and not the sentences.
export const NOT_TRACKED_NOTE = "Not tracked — this result is not scored into any project.";

export const DID_NOT_CHECK: Readonly<Record<ToolKey, string>> = {
  visibility_scan: "One query, one sample per engine, one moment: no other prompts, no repeat samples, and no trend.",
  prompt_research: "Only the prompts you selected, asked once; no tracked history, no competitor set, and no volume data.",
  competitor_finder: "One engine, one category query, one moment: names the capture did not produce are not listed.",
  aux_audit: "Only the pages this audit fetched; rules that need ownership context are excluded unless the domain is verified.",
  schema_builder: "Markup only: no live page fetch, and no check of how any engine currently renders the result.",
  compare_runs: "Only the two stored results you chose: nothing was re-run, and nothing outside them was checked.",
};

/**
 * Which headline figures are ESTIMATES, by tool. A capture-backed tool draws ONE sample per engine, so every figure it derives from
 * those answers is an estimate (ui-ux-guidelines.md: "every figure from a single-sample tool run renders with ≈"). The AUX audit,
 * Schema Builder and Compare Runs compute deterministically over stored or fetched content and flag none.
 */
const SAMPLED_FIELDS: Readonly<Record<ToolKey, readonly ToolHeadlineField[]>> = {
  visibility_scan: ["sov_estimate", "citation_count", "sentiment_label", "brand_present"],
  prompt_research: ["sov_estimate", "entities_found"],
  competitor_finder: ["entities_found"],
  aux_audit: [],
  schema_builder: [],
  compare_runs: [],
};

export function toolPresentation(toolKey: ToolKey, headline: ToolRunHeadline): ToolRunPresentation {
  return {
    not_tracked: true,
    not_tracked_note: NOT_TRACKED_NOTE,
    did_not_check: DID_NOT_CHECK[toolKey],
    // `!== null`, not truthiness: a measured 0 (or `false`) is a present estimate; only an absent figure is not flagged.
    estimated_fields: SAMPLED_FIELDS[toolKey].filter((field) => headline[field] !== null),
  };
}

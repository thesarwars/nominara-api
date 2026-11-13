import {
  PRESENTATION_NOTES_KEY,
  storedPresentationNotesSchema,
  type StoredPresentationNotes,
  type ToolHeadlineField,
  type ToolKey,
  type ToolRunHeadline,
  type ToolRunPresentation,
  type ToolRunResult,
} from "../../../contracts/tools/index.js";

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

/** Schema Builder URL mode (STORY-083 AC5): the run DID fetch a page, so the paste path's "no live page fetch" would be false for it. */
const DID_NOT_CHECK_SCHEMA_URL_CHECK = "Only the structured data of the one page fetched: no other page was checked, and nothing was checked of how any engine currently renders it.";

/** A tool run that reads differently from its tool's usual shape: today only a Schema Builder run made by fetching a URL. */
export type ToolPresentationVariant = "url_check";

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

/** The notes THIS build composes for a run: what a run is stamped with at write time, and what a run with none stored reads. */
export function composedPresentationNotes(toolKey: ToolKey, variant?: ToolPresentationVariant): StoredPresentationNotes {
  return {
    not_tracked_note: NOT_TRACKED_NOTE,
    did_not_check: variant === "url_check" && toolKey === "schema_builder" ? DID_NOT_CHECK_SCHEMA_URL_CHECK : DID_NOT_CHECK[toolKey],
  };
}

/** STORY-095 AC9 - the result to store: the tool's own result plus the notes the run is written with. A key already present is never overwritten. */
export function stampPresentationNotes(result: ToolRunResult, toolKey: ToolKey, variant?: ToolPresentationVariant): ToolRunResult {
  if (storedNotesOf(result) !== null) return result;
  return { ...result, [PRESENTATION_NOTES_KEY]: composedPresentationNotes(toolKey, variant) };
}

/** The notes a stored result carries, or null (no result, a run stored before the key existed, or a key that does not parse: never trusted blindly). */
export function storedNotesOf(result: ToolRunResult | null): StoredPresentationNotes | null {
  if (result === null) return null;
  const parsed = storedPresentationNotesSchema.safeParse(result[PRESENTATION_NOTES_KEY]);
  return parsed.success ? parsed.data : null;
}

/** The result a read returns: the tool's own shape, without the key that belongs to the envelope's `presentation`. */
export function withoutStoredNotes(result: ToolRunResult | null): ToolRunResult | null {
  if (result === null || !(PRESENTATION_NOTES_KEY in result)) return result;
  const { [PRESENTATION_NOTES_KEY]: _notes, ...rest } = result;
  return rest;
}

export function toolPresentation(
  toolKey: ToolKey,
  headline: ToolRunHeadline,
  variant?: ToolPresentationVariant,
  stored: StoredPresentationNotes | null = null,
): ToolRunPresentation {
  // STORY-095 AC9: a stored run serves the notes it was written with; only a run with none stored reads this build's.
  const notes = stored ?? composedPresentationNotes(toolKey, variant);
  return {
    not_tracked: true,
    not_tracked_note: notes.not_tracked_note,
    did_not_check: notes.did_not_check,
    // `!== null`, not truthiness: a measured 0 (or `false`) is a present estimate; only an absent figure is not flagged.
    estimated_fields: SAMPLED_FIELDS[toolKey].filter((field) => headline[field] !== null),
  };
}

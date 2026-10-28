import { noAiDirective } from "./crawler-access.js";
import { answerShapedContentAbsent, contextBlockTruncation, headingHierarchyBroken, keyFactsInMedia, mainContentRatioLow, pageTokensExcessive, paragraphDensity } from "./context-fitness.js";
import { dateModifiedAbsent } from "./freshness.js";
import { jsOnlyMainContent, slowFirstByteForBots, structuredDataClientSideOnly } from "./render-mode.js";
import {
  duplicateConflictingEntities, faqMarkupAbsent, featureListThin, invalidVocabulary, jsonLdSyntaxError, missingContextOrType, noPrimaryEntity,
  offerDataAbsent, organizationIncomplete, ratingWithoutProvenance, schemaTextContradiction,
} from "./structured-data.js";
import type { AuxRule } from "./types.js";

// STORY-051 — the document-model rules, in the reference's order. The five site-file rules (AUX-R-001, 002, 003, 004, 007) live in
// ../site-files.ts and judge fetched files, not a page.

export const AUX_RULES: readonly AuxRule[] = [
  noAiDirective,
  jsonLdSyntaxError, missingContextOrType, noPrimaryEntity, organizationIncomplete, offerDataAbsent, schemaTextContradiction,
  featureListThin, ratingWithoutProvenance, invalidVocabulary, faqMarkupAbsent, duplicateConflictingEntities,
  pageTokensExcessive, mainContentRatioLow, contextBlockTruncation, paragraphDensity, answerShapedContentAbsent, headingHierarchyBroken, keyFactsInMedia,
  jsOnlyMainContent, structuredDataClientSideOnly, slowFirstByteForBots,
  dateModifiedAbsent,
];

/**
 * Catalog rules the audit does NOT evaluate, and why. Each is a gap in what the document model carries, or an owner decision —
 * never a rule that quietly passes. The audit records these in `aux_audits.excluded_rules` so a customer is told what was not
 * checked. A rule here is listed so the catalog's weights still sum to 1; it is not a finding that the page is fine.
 */
export const AUX_RULES_NOT_EVALUATED: Readonly<Record<string, string>> = {
  "AUX-R-005": "Owner decision 2026-10-22: Nominara never requests under another crawler's name, so an edge rule that blocks by user agent cannot be observed.",
  "AUX-R-028": "Needs a trace of content that appears only after a click or scroll; the document model holds the plain and rendered DOM after load, not an interaction record.",
  "AUX-R-031": "Needs the audit date and the median dateModified of the top-10 cited corpus documents; neither is in the document model.",
  "AUX-R-032": "Needs the project's brand aliases to compare with the title and H1; they are not in the document model.",
  "AUX-R-033": "Needs the product name to decide whether a capability sentence names it, and a definition of a capability sentence; neither is in the document model.",
  "AUX-R-034": "Needs the sameAs links of every page on the domain, not of one page; a single document cannot show their absence.",
};

/**
 * Rules in AUX_RULES that run on an INTERIM reading because the document model lacks a field. They are built and they fire, but each
 * covers only part of its reference row, so the audit must not report them as fully checked: when the rules are wired into the audit,
 * surface this map next to AUX_RULES_NOT_EVALUATED. Closing a gap means a STORY-050 field, then the rule reads it.
 */
export const AUX_RULES_PARTIAL: Readonly<Record<string, string>> = {
  "AUX-R-016": "Checks the @context host, the @type spelling and deprecated properties only. Whether a @type is valid for its property set needs a schema.org vocabulary data set (classes and their properties), which is not held.",
  "AUX-R-017": "Reads headings that end in a question mark. Interrogatives written without one, and the Q&A-block arm, need an interrogative / Q&A detection field in the document model.",
  "AUX-R-021": "A list or table anywhere in a section counts as a break, so a long wall of text with one list at its end passes. Needs the longest unstructured token run per content block (a STORY-050 ContentBlock field).",
  "AUX-R-023": "A whole short section stands in for the summary paragraph. Needs sentence counts per paragraph (a STORY-050 ContentBlock field).",
  "AUX-R-025": "Sees images in the plain HTML only, so script-injected images are missed. Needs per-image records (source, alt, adjacent text) in the document model.",
};

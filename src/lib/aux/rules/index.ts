import { noAiDirective } from "./crawler-access.js";
import { answerShapedContentAbsent, contextBlockTruncation, headingHierarchyBroken, keyFactsInMedia, mainContentRatioLow, pageTokensExcessive, paragraphDensity } from "./context-fitness.js";
import { dateModifiedAbsent } from "./freshness.js";
import { jsOnlyMainContent, slowFirstByteForBots, structuredDataClientSideOnly } from "./render-mode.js";
import {
  duplicateConflictingEntities, faqMarkupAbsent, featureListThin, invalidVocabulary, jsonLdSyntaxError, missingContextOrType, noPrimaryEntity,
  offerDataAbsent, organizationIncomplete, ratingWithoutProvenance, schemaTextContradiction,
} from "./structured-data.js";
import type { AuxRule } from "./types.js";

// NOT WIRED. Nothing in src calls evaluateDocuments / AUX_RULES yet: EVALUATE (aux-and-geo-analysis.md section 1, step 6) is not part
// of crawl.audit, so crawled pages get no finding from these rules and `excluded_rules` still names every one of them. STORY-052
// AC1 and AC9 and STORY-051 AC13 ("per page within the audit's latency budget") wait for the follow-up that wires it. That follow-up:
// loadDocumentSnapshot -> buildAuxDocument(cl100kTokenizer) -> evaluateDocuments OUTSIDE the transaction, reconcile inside it,
// remove the codes it runs from EXCLUDED_RULES, and surface AUX_RULES_PARTIAL as a separate annotation.
//
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
  "AUX-R-006": "Sees only directives for Googlebot or everyone: STORY-050 meta.directives drops directives scoped to an AI agent (X-Robots-Tag: GPTBot: noai). Needs the agent-scoped directives in the document model.",
  "AUX-R-013": "Compares the schema with the RAW copy while no renderer is installed (STORY-049 has none, so rendered is always null); the reference defines it on the rendered text. Closes when a renderer supplies the rendered copy.",
  "AUX-R-016": "Checks the @context host, the @type spelling and deprecated properties only. Whether a @type is valid for its property set needs a schema.org vocabulary data set (classes and their properties), which is not held.",
  "AUX-R-017": "Reads headings that end in a question mark. Interrogatives written without one, and the Q&A-block arm, need an interrogative / Q&A detection field in the document model.",
  "AUX-R-019": "Measures the raw copy's token count while no renderer is installed; the reference defines it on rendered.tokenCount.",
  "AUX-R-020": "Measures the raw copy's main-content ratio while no renderer is installed; the reference defines it on rendered tokens.",
  "AUX-R-021": "A list or table anywhere in a section counts as a break, so a long wall of text with one list at its end passes. Needs the longest unstructured token run per content block (a STORY-050 ContentBlock field).",
  "AUX-R-023": "A whole short section stands in for the summary paragraph. Needs sentence counts per paragraph (a STORY-050 ContentBlock field).",
  "AUX-R-025": "Sees images in the plain HTML only, so script-injected images are missed. Needs per-image records (source, alt, adjacent text) in the document model.",
  "AUX-R-029": "The 3 MiB size bound reads the reference's '3 MB' as binary (an owner decision, the same open reading as AUX-R-003's 500 KiB), and timing.bytes counts the decoded string, not wire bytes (a STORY-050 limit).",
};

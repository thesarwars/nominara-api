import { noAiDirective } from "./crawler-access.js";
import { answerShapedContentAbsent, contextBlockTruncation, headingHierarchyBroken, keyFactsInMedia, mainContentRatioLow, pageTokensExcessive, paragraphDensity } from "./context-fitness.js";
import { dateModifiedAbsent } from "./freshness.js";
import { jsOnlyMainContent, slowFirstByteForBots, structuredDataClientSideOnly } from "./render-mode.js";
import {
  duplicateConflictingEntities, faqMarkupAbsent, featureListThin, invalidVocabulary, jsonLdSyntaxError, missingContextOrType, noPrimaryEntity,
  offerDataAbsent, organizationIncomplete, ratingWithoutProvenance, schemaTextContradiction,
} from "./structured-data.js";
import type { AuxRule } from "./types.js";

// WIRED (owner decision 34, AC13). `crawl.audit` calls `runPageRules` (../page-rules.ts), which runs AUX_RULES over every crawled page in the fetch phase,
// outside any transaction; `commit` reconciles the findings. An audit names a rule in `excluded_rules` only when it ran on NO page: the codes in
// AUX_RULES_NOT_EVALUATED always, AUX-R-026 and AUX-R-027 when no page had a rendered copy, AUX-R-029 when no page had a measured timing. The rules
// in AUX_RULES_PARTIAL that did run are surfaced separately, as `error_summary.rules_partial`.
//
// STORY-051 — the document-model rules, in the reference's order. The five site-file rules (AUX-R-001, 002, 003, 004, 007) live in
// ../site-files.ts and judge fetched files, not a page.

const IMPLEMENTED_RULES: readonly AuxRule[] = [
  noAiDirective,
  jsonLdSyntaxError, missingContextOrType, noPrimaryEntity, organizationIncomplete, offerDataAbsent, schemaTextContradiction,
  featureListThin, ratingWithoutProvenance, invalidVocabulary, faqMarkupAbsent, duplicateConflictingEntities,
  pageTokensExcessive, mainContentRatioLow, contextBlockTruncation, paragraphDensity, answerShapedContentAbsent, headingHierarchyBroken, keyFactsInMedia,
  jsOnlyMainContent, structuredDataClientSideOnly, slowFirstByteForBots,
  dateModifiedAbsent,
];

/**
 * THE HOLD SWITCH. A rule listed here keeps its catalog row, its evaluator and its evaluator tests, but the engine does not run it:
 * it is reported as not evaluated (AUX_RULES_NOT_EVALUATED), raises no finding and so adds no penalty.
 *
 * EMPTY since STORY-187 released AUX-R-013 (held by owner decision 8, plans-7day/decisions-2026-10-28.md): the rewritten rule judges name,
 * price and rating only against the page's own subject, and an offer or variant set agrees when any member is shown.
 */
export const HELD_RULES: Readonly<Record<string, string>> = {};

/** Every implemented evaluator, held ones included: for the evaluators' own unit tests and the follow-up story. The engine runs AUX_RULES. */
export const ALL_AUX_RULES: readonly AuxRule[] = IMPLEMENTED_RULES;

/** The rules the engine runs: every implemented evaluator that is not held. */
export const AUX_RULES: readonly AuxRule[] = IMPLEMENTED_RULES.filter((r) => !(r.code in HELD_RULES));

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
  ...HELD_RULES,
};

/**
 * Rules in AUX_RULES that run on an INTERIM reading because the document model lacks a field. They are built and they fire, but each
 * covers only part of its reference row, so the audit must not report them as fully checked: `crawl.audit` lists the ones that ran in
 * `error_summary.rules_partial`, beside `excluded_rules`. Closing a gap means a STORY-050 field, then the rule reads it.
 */
const PARTIAL_READINGS: Readonly<Record<string, string>> = {
  "AUX-R-006": "Sees only directives for Googlebot or everyone: STORY-050 meta.directives drops directives scoped to an AI agent (X-Robots-Tag: GPTBot: noai). Needs the agent-scoped directives in the document model.",
  "AUX-R-013": "Compares the schema with the RAW copy while no renderer is installed (STORY-049 has none, so rendered is always null); the reference defines it on the rendered text. Closes when a renderer supplies the rendered copy.",
  "AUX-R-016": "Checks the @context host, the @type spelling and deprecated properties only. Whether a @type is valid for its property set needs a schema.org vocabulary data set (classes and their properties), which is not held.",
  "AUX-R-017": "Reads headings that end in a question mark. Interrogatives written without one, and the Q&A-block arm, need an interrogative / Q&A detection field in the document model.",
  "AUX-R-018": "Compares only the catalog singleton_types (Organization, WebSite and similar), so two Product blocks with different names are not reported: a listing page legitimately describes many products, and a page with exactly one Product block that two plugins both emit is missed. The reference says any @type; narrowing it needs a rule for telling a listing from a duplicate.",
  "AUX-R-019": "Measures the raw copy's token count while no renderer is installed; the reference defines it on rendered.tokenCount.",
  "AUX-R-020": "Measures the raw copy's main-content ratio while no renderer is installed; the reference defines it on rendered tokens.",
  "AUX-R-023": "A whole short section stands in for the summary paragraph. Needs sentence counts per paragraph (a STORY-050 ContentBlock field).",
  "AUX-R-025": "Sees images in the plain HTML only, so script-injected images are missed. Needs per-image records (source, alt, adjacent text) in the document model.",
  "AUX-R-026": "Undecidable without a rendered copy: with rendered null (STORY-049 has no renderer) it returns no finding, so it can never fire today. A page with no rendered copy keeps AUX-R-026 in excluded_rules for that audit; it is not a pass.",
  "AUX-R-027": "Undecidable without a rendered copy: with rendered null (STORY-049 has no renderer) it returns no finding, so it can never fire today. A page with no rendered copy keeps AUX-R-027 in excluded_rules for that audit; it is not a pass.",
  "AUX-R-029": "A page with no measured timing is skipped (null is not a slow response), so that page keeps AUX-R-029 in excluded_rules for the audit. The 3 MiB size bound reads the reference's '3 MB' as binary (an owner decision, the same open reading as AUX-R-003's 500 KiB), and timing.bytes counts the decoded string, not wire bytes (a STORY-050 limit).",
};

/** PARTIAL covers rules the engine runs; a held rule is reported as not evaluated instead. */
export const AUX_RULES_PARTIAL: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PARTIAL_READINGS).filter(([code]) => !(code in HELD_RULES)));

import { z } from "zod";
import type { AuxRuleFinding } from "../../../../contracts/aux/index.js";
import type { AuxDocument } from "../document-model.js";
import { flattenHeadings, normaliseText, variantOf } from "../rules/helpers.js";
import { buildJsonLdPatch } from "./jsonld.js";
import { buildStructurePatch } from "./markdown.js";
import type { PatchDraft } from "./types.js";

// STORY-053 AC1 / AC2 / AC7 - the dispatcher for the PAGE-level findings STORY-051 produces (generate.ts covers the site files).
//
// Only the rules whose patch content the reference specifies are bound (aux-and-geo-analysis.md section 5):
//   AUX-R-014  a jsonld featureList "extracted verbatim from the page's own H2/H3 capability headings; no values are invented" (example 2)
//   AUX-R-023  the answer-shaped structure template: a summary slot under the page's own first heading (the catalog's "structure template")
// Every other fixable page rule offers no patch until the reference says what its content is: an honest empty, never a guess.
//
// PURE CPU over the page's document model. It either returns a draft, returns null (nothing to offer), or throws PatchRejectedError when its
// own output fails a gate; the caller records a rejection and the audit goes on.

/** NOT FROM THE REFERENCE. A featureList of every H2 on a long page is not reviewable; ten keeps the block short. The architect to confirm or replace. */
export const MAX_FEATURE_LIST_ITEMS = 10;

const featureThresholds = z.object({ heading_levels: z.array(z.number().int().min(1).max(6)).min(1), non_capability_headings: z.array(z.string()) }).passthrough();
const TOP_LEVEL_FEATURE_LIST = /^jsonld\[(\d+)\]\.featureList$/u;

export interface PagePatchInput {
  readonly finding: Pick<AuxRuleFinding, "rule_code" | "url" | "evidence">;
  readonly document: AuxDocument;
  /** The catalog row's thresholds for the finding's rule: the same data the rule judged by. */
  readonly thresholds: Readonly<Record<string, unknown>>;
}

function featureListPatch({ finding, document, thresholds }: PagePatchInput): PatchDraft | null {
  // Only a block that is itself a top-level JSON-LD entry can be merged by @type; a nested entity would get a duplicate top-level block.
  const at = TOP_LEVEL_FEATURE_LIST.exec(finding.evidence.locator);
  if (at === null) return null;
  const entity = document.structured.jsonLd[Number(at[1])];
  if (typeof entity !== "object" || entity === null || Array.isArray(entity)) return null;
  const type = (entity as Record<string, unknown>)["@type"];
  if (typeof type !== "string" && !Array.isArray(type)) return null;

  const t = featureThresholds.parse(thresholds);
  const skip = new Set(t.non_capability_headings.map(normaliseText));
  const variant = variantOf(document);
  const seen = new Set<string>();
  const items: string[] = [];
  for (const h of flattenHeadings(variant.headingTree)) {
    const text = h.text.trim();
    if (!t.heading_levels.includes(h.level) || skip.has(normaliseText(text)) || text === "" || seen.has(normaliseText(text))) continue;
    seen.add(normaliseText(text));
    items.push(text);
  }
  if (items.length === 0) return null;

  return buildJsonLdPatch({
    ruleCode: finding.rule_code,
    targetUrl: finding.url,
    pageHtml: document.raw.html,
    pageText: `${variant.mainText}\n${items.join("\n")}`,
    existingBlocks: document.structured.jsonLd.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null && !Array.isArray(b)),
    proposed: { "@context": "https://schema.org", "@type": type, featureList: items.slice(0, MAX_FEATURE_LIST_ITEMS) },
    explanation: "Engines read a product's capabilities from its featureList. These are the capability headings your page already shows.",
    derivation: "featureList values are extracted verbatim from the page's own H2/H3 capability headings; no values are invented.",
  });
}

/** The page's main text as markdown: a line that is the next heading of the page, in order, gets its `#` marks. Nothing is added or reworded. */
function mainTextAsMarkdown(document: AuxDocument): string {
  const variant = variantOf(document);
  const headings = flattenHeadings(variant.headingTree);
  let next = 0;
  return variant.mainText
    .split("\n")
    .map((line) => {
      const h = headings[next];
      if (h !== undefined && line.trim() === h.text.trim()) {
        next += 1;
        return `${"#".repeat(h.level)} ${line.trim()}`;
      }
      return line;
    })
    .join("\n");
}

export function generatePagePatch(input: PagePatchInput): PatchDraft | null {
  switch (input.finding.rule_code) {
    case "AUX-R-014":
      return featureListPatch(input);
    case "AUX-R-023":
      return buildStructurePatch({ ruleCode: input.finding.rule_code, targetUrl: input.finding.url, markdown: mainTextAsMarkdown(input.document) });
    default:
      return null;
  }
}

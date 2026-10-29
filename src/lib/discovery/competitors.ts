import type { ProposedCompetitor } from "../../../contracts/projects/index.js";
import type { ComparisonLink } from "./html-signals.js";

// STORY-043 AC11 — competitors proposed, EACH WITH A BASIS (api-specification.md §4.5, product-spec.md §2.1: "the site's own
// comparison/alternatives pages -> category peers -> entities co-occurring in the first capture run").
//
// ONLY THE FIRST BASIS IS BUILT, and only as far as the ROOT DOCUMENT shows it: a link the site itself publishes to a comparison
// or alternatives page, read by its visible text. The other two are not faked:
//   category peers          needs the 180-category taxonomy (no table, seed or story owns it), so there is no "category" to be a peer in;
//   first-capture entities  needs a capture, which cannot exist when discovery runs.
// Fetching the comparison pages themselves is NOT done either: aux-and-geo-analysis.md §1 limits an unverified domain to its
// public surface, and a project is unverified when discovery runs. That is an owner decision, reported rather than made here.
//
// NAMES COME FROM LINK TEXT ONLY. A slug ("hubspot-vs-salesforce") is not read: title-casing a slug yields "Hubspot", a name the
// parser would then match on. Generic text ("Compare") names nobody, so it proposes nobody.
//
// `root_domain` is left absent: it is optional on the wire, and guessing "salesforce.com" from "Salesforce" is exactly the
// invented value this story exists not to ship.

export const MAX_PROPOSED_COMPETITORS = 5;
export const COMPETITOR_BASIS = "own comparison page";

/** Explicit "Brand vs Other": the site itself pairs the two. */
const CONFIDENCE_VS = 0.8;
/** "Other alternatives": the site targets Other's users, which implies a rival but does not say so. */
const CONFIDENCE_ALTERNATIVES = 0.7;

const PLACEHOLDERS = new Set([
  "competitor", "competitors", "competition", "other", "others", "us", "them", "it", "the rest", "alternatives", "alternative",
  "the competition", "everyone", "anyone", "others like us",
]);

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function isBrand(name: string, brands: readonly string[]): boolean {
  const n = norm(name);
  if (n === "") return false;
  return brands.some((b) => {
    const nb = norm(b);
    return nb.length >= 3 && (n === nb || n.includes(nb) || (n.length >= 3 && nb.includes(n)));
  });
}

function cleanName(raw: string): string | null {
  const name = raw
    .replace(/\b(?:comparison|compared|compare)\b.*$/i, "")
    .replace(/^(?:best|top|the)\s+/i, "")
    .replace(/[?!.:,;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 2 || name.length > 50) return null;
  if (!/\p{L}/u.test(name)) return null;
  if (name.split(" ").length > 5) return null;
  if (PLACEHOLDERS.has(name.toLowerCase())) return null;
  return name;
}

interface Candidate {
  readonly name: string;
  readonly confidence: number;
}

function fromText(text: string, brands: readonly string[]): Candidate | null {
  const vs = /^(.+?)\s+(?:vs\.?|versus)\s+(.+)$/i.exec(text);
  if (vs !== null) {
    const [a, b] = [vs[1]!, vs[2]!];
    const aBrand = isBrand(a, brands);
    const bBrand = isBrand(b, brands);
    // Exactly one side must be the brand. Neither is a comparison the site is not making about itself; both is the brand
    // compared with itself.
    if (aBrand === bBrand) return null;
    const name = cleanName(aBrand ? b : a);
    return name === null ? null : { name, confidence: CONFIDENCE_VS };
  }

  const alt = /^(?:alternatives?\s+to\s+(.+)|(.+?)\s+alternatives?)$/i.exec(text);
  if (alt !== null) {
    const name = cleanName(alt[1] ?? alt[2]!);
    // "HubSpot alternatives" is a page ABOUT the brand, so it names nobody else.
    return name === null || isBrand(name, brands) ? null : { name, confidence: CONFIDENCE_ALTERNATIVES };
  }
  return null;
}

export interface ProposeCompetitorsInput {
  /** Every name the brand goes by: the discovered or supplied name, the domain stem, known aliases. */
  readonly brandNames: readonly string[];
  readonly links: readonly ComparisonLink[];
}

export function proposeCompetitors(input: ProposeCompetitorsInput): ProposedCompetitor[] {
  const best = new Map<string, { candidate: Candidate; order: number }>();
  input.links.forEach((link, order) => {
    const candidate = fromText(link.text.trim(), input.brandNames);
    if (candidate === null || isBrand(candidate.name, input.brandNames)) return;
    const key = norm(candidate.name);
    const held = best.get(key);
    if (held === undefined || candidate.confidence > held.candidate.confidence) best.set(key, { candidate, order: held?.order ?? order });
  });

  return [...best.values()]
    .sort((a, b) => b.candidate.confidence - a.candidate.confidence || a.order - b.order)
    .slice(0, MAX_PROPOSED_COMPETITORS)
    .map(({ candidate }) => ({ name: candidate.name, confidence: candidate.confidence, basis: COMPETITOR_BASIS }));
}

import { sha256Of, sha256Tag } from "./precondition.js";
import { PatchRejectedError, type PatchDraft } from "./types.js";

// STORY-053 AC2 / AC4 / AC7 (aux-and-geo-analysis.md section 5, example 2).
//
//   * VALIDATED AND PARSED before it is offered: a JSON object with a schema.org @context and a @type, bounded in size and depth.
//   * UPSERT on @type: a block of a type the page already carries is MERGED into it, never duplicated. Where the proposal disagrees
//     with a value the page already states, the page's value stays and the patch says so (`kept_existing:<path>`): overwriting what
//     the customer wrote would be a new claim made in their name.
//   * DERIVED ONLY from the page: every value (not @-keys) must appear in the page's own text as whole words, or be a value the
//     caller declares as a Nominara template. A value that is neither is rejected, not offered: nothing here is a new factual claim.
//   * A value that touches a compliance, metric or pricing claim sets requires_human_review, and the copy control asks for an
//     acknowledgement (EC-25): a customer publishing a certification they do not hold because a tool suggested it is the
//     highest-severity risk in the product.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** NOT FROM THE REFERENCE. Bounds on one block. */
export const MAX_JSONLD_CHARS = 100_000;
export const MAX_JSONLD_DEPTH = 10;

const SCHEMA_CONTEXT = /^https?:\/\/schema\.org\/?$/i;

/** Keys whose very presence is a claim about price, a metric, or a credential. */
const CLAIM_KEYS: ReadonlySet<string> = new Set([
  "offers", "offer", "price", "pricecurrency", "lowprice", "highprice", "pricespecification",
  "aggregaterating", "ratingvalue", "reviewcount", "ratingcount", "review",
  "award", "awards", "hascredential", "hascertification", "certification", "slogan",
]);
/** Words that make a plain string a compliance claim, whichever key carries it. */
const COMPLIANCE_VALUE = /\b(soc\s?[123]|iso\s?\d{4,5}|hipaa|gdpr|ccpa|pci(?:[- ]dss)?|fedramp|certified|certification|compliant|compliance|accredited)\b/i;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const typesOf = (block: JsonObject): string[] => {
  const t = block["@type"];
  return typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
};

function depthOf(value: unknown, depth = 0): number {
  if (depth > MAX_JSONLD_DEPTH) return depth;
  if (Array.isArray(value)) return value.reduce<number>((m, v) => Math.max(m, depthOf(v, depth + 1)), depth);
  if (isObject(value)) return Object.values(value).reduce<number>((m, v) => Math.max(m, depthOf(v, depth + 1)), depth);
  return depth;
}

function parseProposed(proposed: unknown): JsonObject {
  let value = proposed;
  if (typeof proposed === "string") {
    if (proposed.length > MAX_JSONLD_CHARS) throw new PatchRejectedError("invalid_jsonld", `the block is longer than ${MAX_JSONLD_CHARS} characters`);
    try {
      value = JSON.parse(proposed) as unknown;
    } catch {
      throw new PatchRejectedError("invalid_jsonld", "the block does not parse as JSON");
    }
  }
  if (!isObject(value)) throw new PatchRejectedError("invalid_jsonld", "a structured-data block is a single JSON object");
  const context = value["@context"];
  if (typeof context !== "string" || !SCHEMA_CONTEXT.test(context)) throw new PatchRejectedError("invalid_jsonld", "@context must be https://schema.org");
  const types = typesOf(value);
  if (types.length === 0 || types.some((t) => t.trim() === "")) throw new PatchRejectedError("invalid_jsonld", "@type is required");
  if (JSON.stringify(value).length > MAX_JSONLD_CHARS) throw new PatchRejectedError("invalid_jsonld", `the block is longer than ${MAX_JSONLD_CHARS} characters`);
  if (depthOf(value) > MAX_JSONLD_DEPTH) throw new PatchRejectedError("invalid_jsonld", `the block nests deeper than ${MAX_JSONLD_DEPTH} levels`);
  return value;
}

/** Whole-word containment in normalised text: "49" is not in "149", and "Pipeline analytic" is not in "Pipeline analytics". */
function containsWhole(text: string, needle: string): boolean {
  if (needle === "") return false;
  const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    if (!isWord(text[at - 1]) && !isWord(text[at + needle.length])) return true;
  }
  return false;
}

function assertDerived(value: unknown, pageText: string, templates: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) assertDerived(v, pageText, templates);
    return;
  }
  if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) if (!key.startsWith("@")) assertDerived(v, pageText, templates);
    return;
  }
  if (value === null) return;
  const text = normalise(String(value));
  if (text === "") throw new PatchRejectedError("invalid_jsonld", "an empty value is not a value");
  if (templates.has(text) || containsWhole(pageText, text)) return;
  throw new PatchRejectedError("underived_value", `"${String(value).slice(0, 80)}" is not in the page's own content`, { value: String(value).slice(0, 200) });
}

/** True when a plain string reads as a compliance claim. Shared with the html_fragment generator. */
export const textIsComplianceClaim = (text: string): boolean => COMPLIANCE_VALUE.test(text);
/** True when a key (or an HTML itemprop / meta name) names a price, a metric or a credential. Shared with the html_fragment generator. */
export const isClaimKey = (key: string): boolean => !key.startsWith("@") && CLAIM_KEYS.has(key.toLowerCase());

function touchesClaim(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(touchesClaim);
  if (isObject(value)) return Object.entries(value).some(([key, v]) => (!key.startsWith("@") && CLAIM_KEYS.has(key.toLowerCase())) || touchesClaim(v));
  return typeof value === "string" && COMPLIANCE_VALUE.test(value);
}

/** Existing wins on a scalar disagreement; arrays union; objects recurse. Records what it kept. */
function mergeInto(existing: Json, proposed: Json, path: string, kept: string[]): Json {
  if (Array.isArray(existing) && Array.isArray(proposed)) {
    const out = [...existing];
    for (const item of proposed) if (!out.some((x) => equal(x, item))) out.push(item);
    return out;
  }
  if (isObject(existing) && isObject(proposed)) {
    const out: JsonObject = { ...existing };
    for (const [key, v] of Object.entries(proposed)) {
      if (key === "@context") continue;
      out[key] = key in existing ? mergeInto(existing[key]!, v, path === "" ? key : `${path}.${key}`, kept) : v;
    }
    return out;
  }
  if (!equal(existing, proposed)) kept.push(path);
  return existing;
}

/** JSON for a <script> body: `<` is escaped so no value can close the element, and the two line separators JavaScript trips on. */
// U+2028 and U+2029 are legal in JSON and line terminators in older JavaScript; built from code points so no raw separator sits in this file.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, "g");
const scriptJson = (block: unknown): string =>
  JSON.stringify(block, null, 2)
    .replace(/</g, "\\u003c")
    .replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

export interface BuildJsonLdInput {
  readonly ruleCode: string;
  readonly targetUrl: string;
  readonly pageHtml: string;
  /** The page's own visible text: the only source a value may be derived from, besides templates. */
  readonly pageText: string;
  /** The JSON-LD blocks the page already carries, parsed. */
  readonly existingBlocks: readonly Record<string, unknown>[];
  /** The block to add, as an object or as JSON text. */
  readonly proposed: unknown;
  /** Values that are Nominara-authored constants rather than page content. */
  readonly templateValues?: readonly string[];
  readonly explanation: string;
  readonly derivation: string;
}

export function buildJsonLdPatch(input: BuildJsonLdInput): PatchDraft {
  const proposed = parseProposed(input.proposed);
  const templates = new Set((input.templateValues ?? []).map(normalise));
  assertDerived(proposed, normalise(input.pageText), templates);

  const riskFlags: string[] = [];
  const claim = touchesClaim(proposed);
  if (claim) riskFlags.push("claim_requires_review");

  const proposedTypes = typesOf(proposed);
  const match = input.existingBlocks.find((b) => isObject(b as unknown) && typesOf(b as JsonObject).some((t) => proposedTypes.includes(t))) as JsonObject | undefined;

  let block: JsonObject;
  let reversal: PatchDraft["reversal"];
  if (match === undefined) {
    block = proposed;
    reversal = { operation: "remove_jsonld", content: scriptJson(block) };
  } else {
    const kept: string[] = [];
    block = mergeInto(match, proposed, "", kept) as JsonObject;
    if (equal(block, match)) throw new PatchRejectedError("no_change", "the page's structured data already states everything the patch would add");
    for (const path of kept) riskFlags.push(`kept_existing:${path}`);
    reversal = { operation: "restore_jsonld", content: JSON.stringify(match) };
  }

  const before = sha256Of(input.pageHtml);
  const templateNote = templates.size > 0 ? ` Values from a Nominara template: ${[...(input.templateValues ?? [])].join(", ")}.` : "";
  return {
    ruleCode: input.ruleCode,
    kind: "jsonld",
    targetUrl: input.targetUrl,
    contentBeforeHash: before,
    contentAfter: `<script type="application/ld+json">${scriptJson(block)}</script>`,
    unifiedDiff: null,
    jsonldBlocks: [block],
    reversal,
    preconditions: [{ kind: "page_hash", value: sha256Tag(before) }],
    explanation: match === undefined ? input.explanation : `${input.explanation} The page already has a ${proposedTypes.join("/")} block; this merges into it rather than adding a second.`,
    derivation: `${input.derivation}${templateNote}`,
    requiresHumanReview: claim,
    reviewReason: claim ? "Compliance, metric and pricing claims must be confirmed accurate before publishing." : null,
    riskFlags,
  };
}

import { SLOT_NAMES, type SlotName } from "./archetypes.js";

// STORY-045 — §4 step 2 RESOLVE SLOTS.
//
//   2. RESOLVE SLOTS  from project context: category, competitors[],
//      personas[], verticals[], size_bands[], integrations[],
//      compliance_terms[], capabilities[]
//      (capabilities and integrations are mined from the project's own site
//       during fingerprinting, so slot values are the brand's real vocabulary)
//
// THE MINING IS NOT AVAILABLE YET. Discovery retains four fields —
// `brandName`, `description`, `products[]`, `locale`
// (src/lib/discovery/extract.ts) — and keeps no raw page text, so
// `capabilities[]` and `integrations[]` reach this function only when a
// CALLER supplies them. STORY-049's multi-page crawl is what makes §4's
// parenthesis true; until then the slots resolve from supplied context and
// the story records the gap rather than substituting generic category words,
// which is the exact failure §4's note exists to prevent.
//
// AN UNFILLABLE SLOT IS THE POINT. §4 step 3's anonymous fallback triggers on
// one, so this function must leave a slot ABSENT rather than reach for a
// placeholder. "your industry" or "general" would make every template
// fillable, turn the fallback into dead code, and put invented context into a
// customer-visible prompt.

/** Where a slot value came from. Carried into `generator_meta`. */
export type SlotOrigin = "context" | "derived";

export interface ResolvedSlot {
  readonly value: string;
  readonly origin: SlotOrigin;
  /** For a derived slot, the slots it was composed from, in composition order. */
  readonly derivedFrom?: readonly SlotName[];
}

/** Ordered candidates per slot. The emitter takes the first; the rest feed backfill. */
export type SlotBag = Partial<Record<SlotName, readonly ResolvedSlot[]>>;

/**
 * The same map, but permitting an explicit `undefined`.
 *
 * `exactOptionalPropertyTypes` is on, so `SlotBag` — which is what callers
 * read — cannot hold a key whose value is `undefined`; that is the property
 * worth keeping, because "absent" is what triggers the anonymous fallback and
 * a present-but-undefined key would read as fillable. The intermediates below
 * are built by assigning every slot at once, so they need the looser type,
 * and `resolveSlots` narrows back to `SlotBag` by omitting the empty ones.
 */
type SlotCandidates = Partial<Record<SlotName, readonly ResolvedSlot[] | undefined>>;

/**
 * The context slots resolve from.
 *
 * Flat and already-merged: the service composes it from the request's
 * `brand_context`, the project row, and discovery, so this function stays
 * pure and its determinism is testable without a database.
 */
export interface SlotContext {
  readonly brandName?: string;
  readonly categorySlug?: string;
  readonly competitors?: readonly string[];
  readonly personas?: readonly string[];
  readonly verticals?: readonly string[];
  readonly sizeBands?: readonly string[];
  readonly integrations?: readonly string[];
  readonly complianceTerms?: readonly string[];
  readonly capabilities?: readonly string[];
  /** Not in §4 step 2's list. Honoured when supplied so a caller's own wording wins over our derivation. */
  readonly segments?: readonly string[];
  readonly useCases?: readonly string[];
}

/**
 * `mid_market` -> `mid market`.
 *
 * The request example carries `personas: ["non_technical_marketing_director"]`
 * and `size_bands: ["mid_market"]` — snake_case identifiers. Interpolated raw
 * they produce prompts no buyer would type, sent to an engine as though one
 * had, which corrupts the measurement rather than merely reading badly.
 *
 * CASING IS LEFT ALONE. A brand or competitor name is the entity's own
 * string and the parser matches on it; lowercasing "Salesforce" would be a
 * silent change to what we asked. The cost is that an acronym category reads
 * lowercase — "Which crm do you recommend…" — and that is deliberate: fixing
 * it needs an acronym dictionary, and §4 step 4's naturaliser is specified to
 * do exactly this job ("rewrite each numbered line to read like something a
 * real buyer would type"). The template path is meant to be, in this story's
 * own words, "slightly stiffer".
 */
function humanise(raw: string): string {
  return (
    raw
      .replace(/_+/g, " ")
      // A HYPHEN BETWEEN DIGITS IS KEPT. `-` is a slug separator in
      // "b2b-saas" and a range in "50-200"; treating both as separators
      // turned a head count into "50 200", which reads as two numbers and
      // was caught by the test rather than by review.
      .replace(/(?<![0-9])-+|-+(?![0-9])/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function candidates(values: readonly string[] | undefined, origin: SlotOrigin): readonly ResolvedSlot[] | undefined {
  if (values === undefined) return undefined;
  const seen = new Set<string>();
  const resolved: ResolvedSlot[] = [];
  for (const raw of values) {
    const value = humanise(raw);
    if (value.length === 0) continue;
    // Case-insensitive dedupe: "slack" and "Slack" are one integration, and
    // two variants of the same prompt differing only in casing would be
    // rejected by text_hash dedupe anyway — after being generated.
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ value, origin });
  }
  return resolved.length > 0 ? resolved : undefined;
}

/** A size band already expressed as a count — "50-200", "500+", "1000". */
function numericBand(band: string): boolean {
  return /^\d[\d,]*\s*(?:[-–]\s*\d[\d,]*|\+)?$/.test(band.trim());
}

/**
 * `segment` — §4's templates use it, step 2's resolve list does not mention it.
 *
 * Composed most-specific-first, so a project with both a size band and a
 * vertical gets "mid market b2b saas teams" rather than either alone. Falls
 * back through vertical, size band, then persona; derives nothing from
 * nothing, so an empty context leaves the slot absent and the anonymous
 * fallback fires as it should.
 */
function deriveSegment(context: SlotContext): ResolvedSlot | undefined {
  const sizeBand = context.sizeBands?.map(humanise).find((v) => v.length > 0);
  const vertical = context.verticals?.map(humanise).find((v) => v.length > 0);
  const persona = context.personas?.map(humanise).find((v) => v.length > 0);

  if (sizeBand !== undefined && vertical !== undefined) {
    return { value: `${sizeBand} ${vertical} teams`, origin: "derived", derivedFrom: ["size_band", "vertical"] };
  }
  if (vertical !== undefined) return { value: `${vertical} teams`, origin: "derived", derivedFrom: ["vertical"] };
  if (sizeBand !== undefined) return { value: `${sizeBand} teams`, origin: "derived", derivedFrom: ["size_band"] };
  // A persona is a role, so it pluralises rather than taking "teams".
  if (persona !== undefined) return { value: `${persona}s`, origin: "derived", derivedFrom: ["persona"] };
  return undefined;
}

/**
 * Resolves every slot the grammar can reference.
 *
 * Pure and deterministic — `FR-FAN-01d` requires generation to be
 * reproducible given the same context, and the bag is built by iterating
 * `SLOT_NAMES` in its declared order so the result does not depend on the key
 * order of the context object.
 */
export function resolveSlots(context: SlotContext): SlotBag {
  const direct: SlotCandidates = {
    brand: candidates(context.brandName === undefined ? undefined : [context.brandName], "context"),
    category: candidates(context.categorySlug === undefined ? undefined : [context.categorySlug], "context"),
    competitor: candidates(context.competitors, "context"),
    persona: candidates(context.personas, "context"),
    vertical: candidates(context.verticals, "context"),
    size_band: candidates(context.sizeBands, "context"),
    integration: candidates(context.integrations, "context"),
    compliance_term: candidates(context.complianceTerms, "context"),
    capability: candidates(context.capabilities, "context"),
    // Supplied directly when a caller has their own wording. The derivations
    // below only run where these are absent — a customer's real segment name
    // beats our composition of one.
    segment: candidates(context.segments, "context"),
    use_case: candidates(context.useCases, "context"),
    // §4's `scale_fit.a1` needs a NUMERIC head count and nothing in the
    // specification maps a size band to one. A band that is already a count
    // is honoured; a qualitative band yields nothing, and that template
    // simply does not fire.
    headcount: candidates(context.sizeBands?.filter(numericBand), "context"),
  };

  const derived: SlotCandidates = {
    segment: direct.segment ?? optional(deriveSegment(context)),
    use_case:
      direct.use_case ??
      optional(
        context.capabilities
          ?.map(humanise)
          .filter((v) => v.length > 0)
          .map<ResolvedSlot>((value) => ({ value, origin: "derived", derivedFrom: ["capability"] }))[0],
      ),
  };

  // Rebuilt in SLOT_NAMES order so two contexts differing only in key order
  // serialise identically — the determinism the tests pin.
  const bag: SlotBag = {};
  for (const slot of SLOT_NAMES) {
    const values = derived[slot] ?? direct[slot];
    if (values !== undefined) bag[slot] = values;
  }
  return bag;
}

function optional(slot: ResolvedSlot | undefined): readonly ResolvedSlot[] | undefined {
  return slot === undefined ? undefined : [slot];
}

/** The value the emitter would use for a slot, or undefined when it is unfillable. */
export function slotValue(bag: SlotBag, slot: SlotName, index = 0): string | undefined {
  return bag[slot]?.[index]?.value;
}

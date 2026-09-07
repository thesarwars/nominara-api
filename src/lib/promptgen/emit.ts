import type { ArchetypeCoverage, FunnelStage, GeneratableArchetype } from "../../../contracts/prompts/index.js";
import type { Archetype, SurfaceTemplate } from "./archetypes.js";
import { slotValue, type SlotBag } from "./slots.js";

// STORY-045 — §4 step 3 TEMPLATE EMIT, with step 6 CLASSIFY folded in.
//
//   3. TEMPLATE EMIT  15 archetypes x best-fit template = 15 deterministic
//      candidates. Archetype coverage is guaranteed: an archetype whose
//      required slots are unfillable falls back to its brand-anonymous
//      variant, never to nothing.
//   6. CLASSIFY       funnel_stage from the archetype; brand_named /
//      competitor_named flags
//
// STEP 6 IS FOLDED IN rather than run as its own pass, because all three
// values it produces are pure functions of the template already chosen here:
// the stage comes off the archetype and the two flags come off the chosen
// surface's slots. A second pass reading the same inputs could only ever
// disagree with this one — and a candidate whose `brand_named` disagrees
// with its own text is a reporting error nobody would catch, since both
// halves look right in isolation.
//
// PURE. No clock, no randomness, no I/O: `FR-FAN-01d` requires generation to
// be reproducible from (topic, context, grammar version), and the one place
// that is easy to break is here.

export interface Candidate {
  readonly archetype: GeneratableArchetype;
  readonly funnelStage: FunnelStage;
  readonly templateId: string;
  readonly text: string;
  /** The slot values this surface interpolated, for `generator_meta` and the wire. */
  readonly slots: Readonly<Record<string, string>>;
  readonly brandNamed: boolean;
  readonly competitorNamed: boolean;
  readonly brandAnonymous: boolean;
  /**
   * False here always — emit produces TEMPLATE text. §4 step 4's naturaliser
   * sets it, and `generator_meta` records it, so a stored prompt says which
   * path actually produced its wording rather than which path was requested.
   */
  readonly naturalized: boolean;
  /** True when a preferred surface was skipped as UNFILLABLE and an anonymous one took its place. */
  readonly usedAnonymousFallback: boolean;
  /**
   * True when a fillable branded surface was given up for an anonymous
   * sibling to reach `FR-FAN-01c`'s minimum. Distinct from
   * `usedAnonymousFallback`, which is about unfillability — the two have
   * different causes and a customer reading a coverage row should not see
   * "your context is thin" when the real reason was the anonymous quota.
   * Internal; carried into `generator_meta`, not onto the wire.
   */
  readonly anonymousSubstitution: boolean;
  /** §4 step 7's archetype-weight factor, carried so prioritise.ts needs no second lookup. */
  readonly weight: number;
  /** How many of this surface's slots came from real context rather than a derivation. */
  readonly contextSlotCount: number;
}

export interface EmitInput {
  readonly bag: SlotBag;
  /** The effective archetype set, after the request's include/exclude. Order is preserved. */
  readonly archetypes: readonly Archetype[];
  /** Variants per archetype — the contract's `batch_size`. */
  readonly batchSize: number;
}

export interface EmitResult {
  readonly candidates: readonly Candidate[];
  readonly coverage: readonly ArchetypeCoverage[];
}

/** A template is usable only when EVERY declared slot has a value. */
function fillable(template: SurfaceTemplate, bag: SlotBag): boolean {
  return template.requiredSlots.every((slot) => slotValue(bag, slot) !== undefined);
}

function fill(
  archetype: Archetype,
  template: SurfaceTemplate,
  bag: SlotBag,
  usedAnonymousFallback: boolean,
  anonymousSubstitution = false,
): Candidate {
  const slots: Record<string, string> = {};
  let text = template.surface;
  let contextSlotCount = 0;

  for (const slot of template.requiredSlots) {
    const resolved = bag[slot]?.[0];
    // Unreachable for a `fillable` template; asserted rather than assumed
    // because the alternative is a literal `{category}` reaching an engine
    // as though a buyer had typed it.
    if (resolved === undefined) throw new Error(`promptgen: ${template.id} declared slot ${slot} with no value`);
    slots[slot] = resolved.value;
    if (resolved.origin === "context") contextSlotCount += 1;
    text = text.replaceAll(`{${slot}}`, resolved.value);
  }

  const brandNamed = template.requiredSlots.includes("brand");
  const competitorNamed = template.requiredSlots.includes("competitor");

  return {
    archetype: archetype.key,
    funnelStage: archetype.funnelStage,
    templateId: template.id,
    text,
    slots,
    brandNamed,
    competitorNamed,
    brandAnonymous: !brandNamed && !competitorNamed,
    naturalized: false,
    usedAnonymousFallback,
    anonymousSubstitution,
    weight: archetype.weight,
    contextSlotCount,
  };
}

/**
 * Emits candidates for each archetype in the order §4's table gives them.
 *
 * `batchSize` variants per archetype, each from a DIFFERENT surface. Two
 * variants from one template would be byte-identical and rejected by
 * `text_hash` dedupe the moment they were persisted — generated work thrown
 * away, and a `rejected_duplicate` the customer has to make sense of.
 *
 * Returns FEWER than asked rather than repeating a surface. §4 gives each
 * archetype 2-4, so asking for four when three can fill yields three;
 * `FR-FAN-01a`'s `templates_exhausted` is the reporting side of that, in the
 * pipeline above.
 */
export function emitCandidates(input: EmitInput): EmitResult {
  const chosenByArchetype = new Map<GeneratableArchetype, SurfaceTemplate[]>();

  for (const archetype of input.archetypes) {
    const usable = archetype.templates.filter((template) => fillable(template, input.bag));
    chosenByArchetype.set(archetype.key, usable.slice(0, input.batchSize));
  }

  const substituted = enforceAnonymousMinimum(input, chosenByArchetype);

  const candidates: Candidate[] = [];
  const coverage: ArchetypeCoverage[] = [];

  for (const archetype of input.archetypes) {
    const chosen = chosenByArchetype.get(archetype.key) ?? [];

    // THE FALLBACK FLAG, and it is narrower than "the chosen surface happens
    // to be anonymous". It means: a surface we preferred was skipped as
    // unfillable, and an anonymous one took its place. An archetype whose
    // `.a1` is already anonymous has not fallen back to anything — marking
    // it so would make thin context look like the normal case and turn the
    // coverage chip row into noise.
    const preferred = archetype.templates[0];
    const skippedPreferred = preferred !== undefined && !fillable(preferred, input.bag);

    for (const template of chosen) {
      const fallback = skippedPreferred && template.brandAnonymous;
      candidates.push(fill(archetype, template, input.bag, fallback, substituted.has(template.id)));
    }

    coverage.push({
      intent_archetype: archetype.key,
      represented: chosen.length > 0,
      variant_count: chosen.length,
      used_anonymous_fallback: chosen.some((template) => skippedPreferred && template.brandAnonymous),
    });
  }

  return { candidates, coverage };
}

/**
 * `FR-FAN-01c`'s floor, scaled to the size of the pass.
 *
 * The requirement reads "at least 6 of the 15 variants are brand-anonymous".
 * A thin context cannot fill fifteen surfaces, so there is no fifteen for
 * that ratio to be taken of — the floor is therefore the SHARE the
 * requirement expresses, 6/15, applied to whatever the pass actually
 * produced. At fifteen it gives exactly the documented six.
 *
 * `ceil` AND NOT `floor`, decided after trying floor first and finding it
 * made the substitution below dead code. Rounding down lets a four-candidate
 * pass be three-quarters brand-named and still pass, and a small pass is
 * where the integrity risk is HIGHEST, not lowest: `FR-FAN-01c` exists
 * because "brand-named prompts systematically overstate visibility", and
 * 3-of-4 overstates exactly as badly as 12-of-15 would. Rounding up costs a
 * documented surface on a thin context; rounding down costs the measurement.
 */
export function minimumAnonymous(total: number): number {
  return Math.ceil((6 / 15) * total);
}

/**
 * Swaps fillable branded surfaces for anonymous siblings until the minimum is met.
 *
 * SELECTION IS A SET-LEVEL DECISION, and treating it as fifteen independent
 * per-archetype choices is a defect that a test caught rather than review.
 * §4's example surface is each archetype's preferred phrasing, and four of
 * those examples name an entity — while their anonymous siblings need MORE
 * slots than they do (`alternatives.a1` needs only `competitor`, `.a2` needs
 * `category`). So on a context carrying a brand and competitors but little
 * else, every branded surface fills, most anonymous ones do not, and the pass
 * comes out almost entirely brand-named. That is exactly the "systematically
 * overstate visibility" failure `FR-FAN-01c` exists to prevent, arrived at by
 * honouring an illustration over a guarantee.
 *
 * So the preference yields to the guarantee: a documented `.a1` is kept
 * unless keeping it would put the pass under the anonymous floor.
 *
 * SWAPS RUN IN REVERSE archetype order, so the earliest and most prominent
 * archetypes keep their documented phrasing and the later ones give way
 * first. Deterministic, which `FR-FAN-01d` requires.
 */
function enforceAnonymousMinimum(
  input: EmitInput,
  chosenByArchetype: Map<GeneratableArchetype, SurfaceTemplate[]>,
): ReadonlySet<string> {
  const substituted = new Set<string>();
  const all = () => [...chosenByArchetype.values()].flat();

  const total = all().length;
  const floor = minimumAnonymous(total);

  for (const archetype of [...input.archetypes].reverse()) {
    if (all().filter((template) => template.brandAnonymous).length >= floor) break;

    const chosen = chosenByArchetype.get(archetype.key);
    if (chosen === undefined) continue;

    for (let index = 0; index < chosen.length; index += 1) {
      const current = chosen[index];
      if (current === undefined || current.brandAnonymous) continue;

      const replacement = archetype.templates.find(
        (template) => template.brandAnonymous && fillable(template, input.bag) && !chosen.includes(template),
      );
      if (replacement === undefined) continue;

      chosen[index] = replacement;
      substituted.add(replacement.id);
      if (all().filter((template) => template.brandAnonymous).length >= floor) break;
    }
  }

  return substituted;
}

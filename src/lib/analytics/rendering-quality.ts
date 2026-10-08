import type {
  DataSource,
  RenderingAttribute,
  RenderingAttributeCoverage,
  RenderingCause,
  RenderingEngineEntry,
  RenderingQualityResponse,
} from "../../../contracts/analytics/index.js";
import { ATTR_WEIGHT, engineHasPricedElements, engineRendersAttributes, PRICED_ATTRS } from "../parser/rendering.js";

// NEW-C-11 — scoring-models.md §8, the read side. NO SECOND FORMULA: the
// score of every engine and of the blend arrives already computed by the
// scorecards' path (`toWindowMetrics` / `blendScorecards`, which read the
// per-mention `render_score` STORY-039 wrote). This builds what the score
// cannot say: attribute coverage, who is excluded, and the cause link.

/** §8's seven weighted attributes, in descending weight. */
export const RENDERING_ATTRIBUTES: readonly RenderingAttribute[] = Object.freeze([
  "price",
  "rating",
  "image",
  "spec",
  "description",
  "link",
  "availability",
] as const);

/**
 * Attribute -> the `structured_data` rules whose open finding can cause it to
 * be missing (aux-and-geo-analysis.md; STORY-039 AC7 names "no price shown
 * against an absent or contradicting offer").
 *
 * THE REFERENCE DOES NOT STATE THIS MAPPING; it is a recommendation raised as
 * a spec ambiguity (NEW-C-11 evidence). Only the two high-weight attributes
 * the story names (price, rating) are mapped; none of the others has a rule
 * that causes its absence on an engine surface.
 */
export const RENDERING_CAUSE_RULES: Readonly<Record<"price" | "rating", readonly string[]>> = Object.freeze({
  price: ["AUX-R-012", "AUX-R-013"],
  rating: ["AUX-R-013", "AUX-R-015"],
});

export interface EngineCounts {
  readonly engineKey: string;
  /** Brand mentions counted on this engine in the window. */
  readonly mentions: number;
  readonly withAttr: Readonly<Partial<Record<RenderingAttribute, number>>>;
}

export interface OpenFinding {
  readonly id: string;
  readonly ruleCode: string;
  readonly severity: RenderingCause["severity"];
  readonly title: string;
}

export interface EngineInput {
  readonly engineKey: string;
  readonly displayName: string | null;
  /** The scorecards' `metrics.rendering_quality` for this engine. */
  readonly score: number | null;
  readonly dataSource: DataSource | null;
}

export interface RenderingQualityInput {
  readonly engines: readonly EngineInput[];
  readonly counts: readonly EngineCounts[];
  /** Open findings of the mapped rules, newest first. */
  readonly findings: readonly OpenFinding[];
  readonly blendedScore: number | null;
  readonly blendedDataSource: DataSource | null;
}

const SEVERITY_RANK: Readonly<Record<RenderingCause["severity"], number>> = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
});

/** True where this engine's surface has no element that could carry the attribute. */
function surfaceUnavailable(engineKey: string, attribute: RenderingAttribute): boolean {
  if (!engineRendersAttributes(engineKey)) return true;
  return PRICED_ATTRS.includes(attribute) && !engineHasPricedElements(engineKey);
}

/** The most severe open finding of the attribute's mapped rules; ties keep input (newest-first) order. */
function causeFor(attribute: RenderingAttribute, coverage: number | null, findings: readonly OpenFinding[]): RenderingCause | null {
  // Only a MISSING attribute has a cause: coverage 1 means nothing is missing,
  // and null means nothing was measured to be missing.
  if (coverage === null || coverage >= 1) return null;
  if (attribute !== "price" && attribute !== "rating") return null;
  const rules = RENDERING_CAUSE_RULES[attribute];
  let best: OpenFinding | null = null;
  for (const finding of findings) {
    if (!rules.includes(finding.ruleCode)) continue;
    if (best === null || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[best.severity]) best = finding;
  }
  return best === null ? null : { finding_id: best.id, rule_code: best.ruleCode, severity: best.severity, title: best.title };
}

function share(withAttr: number, mentions: number): number | null {
  return mentions === 0 ? null : withAttr / mentions;
}

export function buildRenderingQuality(
  input: RenderingQualityInput,
): Pick<RenderingQualityResponse, "rich_rendering_engines" | "engines" | "blended"> {
  const countsFor = (engineKey: string): EngineCounts | undefined => input.counts.find((c) => c.engineKey === engineKey);

  const engines: RenderingEngineEntry[] = input.engines.map((engine) => {
    const capable = engineRendersAttributes(engine.engineKey);
    // AC2 — an engine that cannot render attributes is EXCLUDED from its own
    // denominator: nothing counted, no score. A measurement we cannot make is
    // not a zero.
    const counts = capable ? countsFor(engine.engineKey) : undefined;
    const mentions = counts?.mentions ?? 0;
    const attributes: RenderingAttributeCoverage[] = RENDERING_ATTRIBUTES.map((attribute) => {
      const unavailable = surfaceUnavailable(engine.engineKey, attribute);
      const coverage = unavailable ? null : share(counts?.withAttr[attribute] ?? 0, mentions);
      return {
        attribute,
        weight: ATTR_WEIGHT[attribute],
        coverage,
        surface_unavailable: unavailable,
        cause: causeFor(attribute, coverage, input.findings),
      };
    });
    return {
      engine_key: engine.engineKey,
      display_name: engine.displayName,
      renders_attributes: capable,
      has_priced_elements: engineHasPricedElements(engine.engineKey),
      score: capable ? engine.score : null,
      mentions_counted: mentions,
      attributes,
      data_source: engine.dataSource,
    };
  });

  // The blend pools each attribute over the engines whose surface can show it,
  // so a priced attribute is not diluted by a surface that has none.
  const capableKeys = input.engines.map((e) => e.engineKey).filter(engineRendersAttributes);
  const blendedMentions = capableKeys.reduce((total, key) => total + (countsFor(key)?.mentions ?? 0), 0);
  const blendedAttributes: RenderingAttributeCoverage[] = RENDERING_ATTRIBUTES.map((attribute) => {
    const poolKeys = capableKeys.filter((key) => !surfaceUnavailable(key, attribute));
    const mentions = poolKeys.reduce((total, key) => total + (countsFor(key)?.mentions ?? 0), 0);
    const present = poolKeys.reduce((total, key) => total + (countsFor(key)?.withAttr[attribute] ?? 0), 0);
    const coverage = share(present, mentions);
    return {
      attribute,
      weight: ATTR_WEIGHT[attribute],
      coverage,
      surface_unavailable: poolKeys.length === 0,
      cause: causeFor(attribute, coverage, input.findings),
    };
  });

  return {
    rich_rendering_engines: capableKeys,
    engines,
    blended: {
      score: input.blendedScore,
      mentions_counted: blendedMentions,
      attributes: blendedAttributes,
      data_source: input.blendedDataSource,
    },
  };
}

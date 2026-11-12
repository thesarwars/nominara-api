// STORY-056 — the four displacement kinds (`scoring-models.md` §9).
//
// Compares a capture with the PREVIOUS capture of the same prompt and engine —
// never a rolling average — so every event has two identifiable endpoints.
//
// ⚠ THIS FILE IMPORTS NOTHING (scoring-purity.spec.ts). The impact score is
// a separate pure function in `src/lib/scoring/displacement-impact.ts`; the
// caller joins the two.

export type DetectedKind = "presence_lost" | "position_lost" | "recommendation_lost" | "render_downgraded";

export interface SnapshotCitation {
  readonly url: string;
  readonly domain: string;
  readonly sourceClass: string;
}

/** Any entity detected in an answer other than the brand — tracked or not. */
export interface SnapshotEntity {
  readonly entityLabel: string;
  readonly entityId: string | null;
  readonly isTracked: boolean;
  readonly position: number | null;
  readonly prominence: number;
  readonly positionClass: string;
  readonly citations: readonly SnapshotCitation[];
}

export interface CaptureSnapshot {
  readonly resultId: string;
  readonly brandPresent: boolean;
  readonly brandPosition: number | null;
  readonly brandPositionClass: string | null;
  readonly brandRenderForm: string | null;
  readonly entities: readonly SnapshotEntity[];
}

export interface DetectedDisplacement {
  readonly kind: DetectedKind;
  readonly beforeResultId: string;
  readonly afterResultId: string;
  readonly beforePosition: number | null;
  readonly afterPosition: number | null;
  readonly beforePositionClass: string | null;
  readonly afterPositionClass: string | null;
  readonly displacedBy: readonly SnapshotEntity[];
}

/** §2.4's `form_multiplier` order, worst to best. */
const RENDER_ORDER = ["bare_text", "linked", "described", "structured_row", "featured"] as const;

export function renderLevel(form: string | null): number {
  return form === null ? -1 : RENDER_ORDER.indexOf(form as (typeof RENDER_ORDER)[number]);
}

function aheadOfBrand(entity: SnapshotEntity, brandPosition: number | null): boolean {
  return entity.position !== null && brandPosition !== null && entity.position < brandPosition;
}

function displacers(
  kind: DetectedKind,
  before: CaptureSnapshot,
  after: CaptureSnapshot,
): readonly SnapshotEntity[] {
  if (kind === "render_downgraded") return [];
  const beforeByLabel = new Map(before.entities.map((e) => [e.entityLabel, e]));
  if (kind === "recommendation_lost") {
    return after.entities.filter(
      (e) => e.positionClass === "recommendation" && beforeByLabel.get(e.entityLabel)?.positionClass !== "recommendation",
    );
  }
  const wasAhead = (e: SnapshotEntity): boolean => {
    const prior = beforeByLabel.get(e.entityLabel);
    return prior !== undefined && aheadOfBrand(prior, before.brandPosition);
  };
  if (kind === "position_lost") {
    return after.entities.filter((e) => aheadOfBrand(e, after.brandPosition) && !wasAhead(e));
  }
  // presence_lost: whoever now holds the slot the brand held.
  return after.entities.filter(
    (e) => e.position !== null && (before.brandPosition === null || e.position <= before.brandPosition) && !wasAhead(e),
  );
}

export function detectDisplacement(before: CaptureSnapshot, after: CaptureSnapshot): readonly DetectedDisplacement[] {
  if (!before.brandPresent) return [];
  const kinds: DetectedKind[] = [];

  if (!after.brandPresent) {
    kinds.push("presence_lost");
  } else {
    if (
      before.brandPosition !== null &&
      after.brandPosition !== null &&
      after.brandPosition > before.brandPosition
    ) {
      kinds.push("position_lost");
    }
    if (before.brandPositionClass === "recommendation" && after.brandPositionClass !== "recommendation") {
      kinds.push("recommendation_lost");
    }
    if (renderLevel(after.brandRenderForm) < renderLevel(before.brandRenderForm) && renderLevel(after.brandRenderForm) >= 0) {
      kinds.push("render_downgraded");
    }
  }

  return kinds.map((kind) => ({
    kind,
    beforeResultId: before.resultId,
    afterResultId: after.resultId,
    beforePosition: before.brandPosition,
    afterPosition: after.brandPresent ? after.brandPosition : null,
    beforePositionClass: before.brandPositionClass,
    afterPositionClass: after.brandPresent ? after.brandPositionClass : null,
    displacedBy: displacers(kind, before, after),
  }));
}

/**
 * `scoring-models.md` §9 Recovery — does a LATER capture restore what the
 * event lost? Compared against the event's own `before` endpoint, never a
 * fresh baseline: presence back; position back to (or better than) where it
 * was; the recommendation class back; the render form back to (or above) it.
 */
export function restoresSlot(kind: DetectedKind, before: CaptureSnapshot, later: CaptureSnapshot): boolean {
  if (!later.brandPresent) return false;
  switch (kind) {
    case "presence_lost":
      return true;
    case "position_lost":
      return later.brandPosition !== null && before.brandPosition !== null && later.brandPosition <= before.brandPosition;
    case "recommendation_lost":
      return later.brandPositionClass === "recommendation";
    case "render_downgraded":
      return renderLevel(later.brandRenderForm) >= renderLevel(before.brandRenderForm);
  }
}

/** One element of a structured answer (STORY-029), reduced to what passage scoping reads: its words and the citation URLs it references. */
export interface PassageElement {
  /** The element's text; the same text the parser matches a mention against. */
  readonly description: string | undefined;
  /** The element's OWN references, in the terms of the capture's stored citation URLs (the caller resolves them). */
  readonly citedUrls: readonly string[];
}

export type CitationScope = "passage" | "answer";

/**
 * STORY-057 AC3 - scopes one displacing entity's citations to the passage where it is named.
 *
 * Only ever NARROWS: every returned citation is one the entity already held, and a URL the passage cites that the entity does not hold
 * is never added. With no elements (every conversational engine) or no element naming the entity, the passage cannot be located, so
 * the citations come back untouched and `answer`-scoped: guessing a passage would name a source the competitor may not hold there.
 * A passage that names the entity but cites nothing gives an empty `passage` result: zero is a finding, not a reason to fall back.
 */
export function scopeCitationsToPassage(
  entityLabel: string,
  citations: readonly SnapshotCitation[],
  elements: readonly PassageElement[] | undefined,
): { readonly citations: readonly SnapshotCitation[]; readonly scope: CitationScope } {
  const label = entityLabel.trim().toLowerCase();
  const passages =
    elements === undefined || label === ""
      ? []
      : elements.filter((element) => element.description !== undefined && element.description.toLowerCase().includes(label));
  if (passages.length === 0) return { citations, scope: "answer" };
  const cited = new Set(passages.flatMap((passage) => passage.citedUrls));
  return { citations: citations.filter((citation) => cited.has(citation.url)), scope: "passage" };
}

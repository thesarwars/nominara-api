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

/** One element of a structured answer (STORY-029), reduced to what the passage view reads: who it names and the citation URLs it references. */
export interface PassageElement {
  /**
   * The entity labels the parser's matcher (`matchEntities`: word boundaries, aliases, negative aliases) found in this element's text.
   * Matching is the caller's, never this file's: a substring test here would read "HP" into "shape".
   */
  readonly mentions: readonly string[];
  /** The element's OWN references, in the terms of the capture's stored citation URLs (the caller resolves them). */
  readonly citedUrls: readonly string[];
  /** It cites sources but has no text to match a mention against: what it cites cannot be placed in or outside a passage. */
  readonly unlocatable?: boolean;
}

/**
 * `passage`: cited by an element that mentions the entity. `outside_passage`: a passage WAS located and this source is cited only elsewhere
 * in the answer. `answer`: no passage could be located (no elements, none names the entity, or the citing element has no text).
 */
export type CitationScope = "passage" | "outside_passage" | "answer";

/**
 * STORY-057 AC3 / owner decision 99i - the PASSAGE VIEW of one displacing entity's citations. DISPLAY ONLY: every citation comes back, in
 * order, with a label; none is dropped, because the impact score and the concept gap read the whole-answer gap and must not move with it.
 * Never adds a citation: the labels are over the entity's own. With no elements (every conversational engine), or none naming the entity,
 * the passage cannot be located and everything is `answer`; guessing a passage would be a claim the capture does not support.
 */
export function classifyCitationScopes(
  entityLabel: string,
  citations: readonly SnapshotCitation[],
  elements: readonly PassageElement[] | undefined,
): readonly { readonly citation: SnapshotCitation; readonly scope: CitationScope }[] {
  const passages = elements === undefined ? [] : elements.filter((element) => element.mentions.includes(entityLabel));
  if (passages.length === 0) return citations.map((citation) => ({ citation, scope: "answer" as const }));
  const inPassage = new Set(passages.flatMap((passage) => passage.citedUrls));
  const unplaced = new Set((elements ?? []).filter((element) => element.unlocatable === true).flatMap((element) => element.citedUrls));
  return citations.map((citation) => ({
    citation,
    scope: inPassage.has(citation.url) ? ("passage" as const) : unplaced.has(citation.url) ? ("answer" as const) : ("outside_passage" as const),
  }));
}

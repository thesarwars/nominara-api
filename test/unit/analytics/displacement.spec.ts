import { describe, expect, it } from "vitest";
import { detectDisplacement, classifyCitationScopes, type CaptureSnapshot, type PassageElement, type SnapshotEntity } from "../../../src/lib/analytics/displacement.js";

// STORY-056 scenarios 1-5 — each capture is compared with the previous capture
// of the same prompt and engine.

const rival = (over: Partial<SnapshotEntity> = {}): SnapshotEntity => ({
  entityLabel: "Rival",
  entityId: "ent-rival",
  isTracked: true,
  position: 1,
  prominence: 0.8,
  positionClass: "recommendation",
  citations: [{ url: "https://r.example/a", domain: "r.example", sourceClass: "editorial" }],
  ...over,
});

const snap = (over: Partial<CaptureSnapshot> = {}): CaptureSnapshot => ({
  resultId: "res-before",
  brandPresent: true,
  brandPosition: 2,
  brandPositionClass: "ranked",
  brandRenderForm: "described",
  entities: [],
  ...over,
});

describe("STORY-056 · displacement detection", () => {
  it("scenario 1 — present then absent gives presence_lost with both result ids", () => {
    const before = snap({ resultId: "b1" });
    const after = snap({ resultId: "a1", brandPresent: false, brandPosition: null, brandPositionClass: null, brandRenderForm: null, entities: [rival({ position: 2 })] });
    const found = detectDisplacement(before, after);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "presence_lost", beforeResultId: "b1", afterResultId: "a1", beforePosition: 2, afterPosition: null });
  });

  it("scenario 2 — position 2 to 5 gives position_lost", () => {
    const before = snap({ brandPosition: 2 });
    const after = snap({ resultId: "a2", brandPosition: 5 });
    const kinds = detectDisplacement(before, after).map((e) => e.kind);
    expect(kinds).toEqual(["position_lost"]);
  });

  it("scenario 3 — recommendation to a neutral list gives recommendation_lost", () => {
    const before = snap({ brandPositionClass: "recommendation" });
    const after = snap({ resultId: "a3", brandPositionClass: "neutral_list" });
    const found = detectDisplacement(before, after);
    expect(found.map((e) => e.kind)).toEqual(["recommendation_lost"]);
    expect(found[0]).toMatchObject({ beforePositionClass: "recommendation", afterPositionClass: "neutral_list" });
  });

  it("scenario 4 — a priced render to bare text gives render_downgraded", () => {
    const before = snap({ brandRenderForm: "structured_row" });
    const after = snap({ resultId: "a4", brandRenderForm: "bare_text" });
    expect(detectDisplacement(before, after).map((e) => e.kind)).toEqual(["render_downgraded"]);
  });

  it("scenario 5 — an UNTRACKED displacer is recorded in displaced_by", () => {
    const before = snap({ brandPosition: 1 });
    const after = snap({
      resultId: "a5",
      brandPresent: false,
      brandPosition: null,
      brandPositionClass: null,
      brandRenderForm: null,
      entities: [rival({ entityLabel: "Stranger Inc", entityId: null, isTracked: false, position: 1 })],
    });
    const [event] = detectDisplacement(before, after);
    expect(event!.displacedBy).toEqual([
      expect.objectContaining({ entityLabel: "Stranger Inc", entityId: null, isTracked: false, position: 1, prominence: 0.8, positionClass: "recommendation", citations: [expect.objectContaining({ domain: "r.example" })] }),
    ]);
  });

  it("an entity already ahead before is not a displacer", () => {
    const ahead = rival({ position: 1 });
    const before = snap({ brandPosition: 2, entities: [ahead] });
    const after = snap({ resultId: "a", brandPosition: 3, entities: [ahead, rival({ entityLabel: "New", entityId: null, isTracked: false, position: 2 })] });
    const [event] = detectDisplacement(before, after);
    expect(event!.displacedBy.map((d) => d.entityLabel)).toEqual(["New"]);
  });

  it("nothing lost, brand improved, or never present gives no events", () => {
    expect(detectDisplacement(snap(), snap({ resultId: "x" }))).toEqual([]);
    expect(detectDisplacement(snap({ brandPosition: 4 }), snap({ brandPosition: 1 }))).toEqual([]);
    expect(detectDisplacement(snap({ brandPresent: false, brandPosition: null }), snap({ brandPresent: false, brandPosition: null }))).toEqual([]);
    expect(detectDisplacement(snap({ brandPresent: false, brandPosition: null }), snap())).toEqual([]);
  });

  it("null positions on both sides do not produce position_lost", () => {
    expect(detectDisplacement(snap({ brandPosition: null }), snap({ brandPosition: 3 }))).toEqual([]);
  });

  it("several kinds on one pair are all reported", () => {
    const before = snap({ brandPosition: 1, brandPositionClass: "recommendation", brandRenderForm: "featured" });
    const after = snap({ resultId: "z", brandPosition: 4, brandPositionClass: "ranked", brandRenderForm: "bare_text" });
    expect(detectDisplacement(before, after).map((e) => e.kind)).toEqual(["position_lost", "recommendation_lost", "render_downgraded"]);
  });

  it("does not mutate its inputs", () => {
    const before = snap({ entities: [rival()] });
    const after = snap({ resultId: "m", brandPresent: false, brandPosition: null, entities: [rival()] });
    const copy = JSON.stringify([before, after]);
    detectDisplacement(before, after);
    expect(JSON.stringify([before, after])).toBe(copy);
  });
});


// STORY-057 AC3 / scenarios 4 and 5, owner decision 99i - the passage view of the citation gap is DISPLAY ONLY. Every citation the entity
// holds stays in the gap (impact and the concept gap read the whole answer); each is LABELLED: `passage` (cited by an element that
// mentions the entity), `outside_passage` (a passage was located and this source is cited elsewhere in the answer), `answer` (no passage
// could be located, or the citing element is unlocatable). `mentions` are the labels the PARSER'S matcher found in the element.
describe("STORY-057 AC3 · classifyCitationScopes", () => {
  const cite = (path: string) => ({ url: `https://r.example/${path}`, domain: "r.example", sourceClass: "editorial" });
  const [a, b, c] = [cite("a"), cite("b"), cite("c")];
  const passage = (mentions: string[], ...urls: string[]): PassageElement => ({ mentions, citedUrls: urls.map((u) => `https://r.example/${u}`) });
  const scopes = (label: string, cites: ReturnType<typeof cite>[], els: readonly PassageElement[] | undefined) =>
    classifyCitationScopes(label, cites, els).map((x) => [x.citation.url.slice(-1), x.scope]);

  it("scenario 4 - never drops a citation: the passage's is labelled passage, the rest outside_passage", () => {
    expect(scopes("Rival", [a, b, c], [passage(["Rival"], "a"), passage([], "b")])).toEqual([["a", "passage"], ["b", "outside_passage"], ["c", "outside_passage"]]);
  });

  it("scenario 5 - an engine with no elements (undefined or empty) labels every citation answer", () => {
    expect(scopes("Rival", [a, b], undefined)).toEqual([["a", "answer"], ["b", "answer"]]);
    expect(scopes("Rival", [a, b], [])).toEqual([["a", "answer"], ["b", "answer"]]);
  });

  it("elements exist but none mentions the competitor: the passage cannot be located, so answer, never guessed", () => {
    expect(scopes("Rival", [a, b], [passage([], "a"), passage(["Other Rival"], "b")])).toEqual([["a", "answer"], ["b", "answer"]]);
  });

  it("the passages of every element that mentions the competitor are unioned", () => {
    expect(scopes("Rival", [a, b, c], [passage(["Rival"], "a"), passage(["Rival", "X"], "c"), passage([], "b")])).toEqual([["a", "passage"], ["b", "outside_passage"], ["c", "passage"]]);
  });

  it("a passage that mentions the competitor but cites nothing leaves every citation outside_passage (the passage was located)", () => {
    expect(scopes("Rival", [a, b], [passage(["Rival"]), passage([], "a")])).toEqual([["a", "outside_passage"], ["b", "outside_passage"]]);
  });

  it("a URL the passage cites that the competitor does not hold is never added (never inferred)", () => {
    expect(classifyCitationScopes("Rival", [a], [passage(["Rival"], "a", "zzz")]).map((x) => x.citation)).toEqual([a]);
  });

  it("an element with links but no text is unlocatable: what it cites is answer-scoped, never silently outside the passage", () => {
    const unlocatable: PassageElement = { mentions: [], citedUrls: ["https://r.example/b"], unlocatable: true };
    expect(scopes("Rival", [a, b, c], [passage(["Rival"], "a"), unlocatable])).toEqual([["a", "passage"], ["b", "answer"], ["c", "outside_passage"]]);
  });

  it("an entity label is matched whole: 'Zoho' is not the entity 'Zoho CRM' (labels compare equal, never by substring)", () => {
    expect(scopes("Zoho", [a, b], [passage(["Zoho CRM"], "a")])).toEqual([["a", "answer"], ["b", "answer"]]);
  });

  it("does not mutate its inputs", () => {
    const citations = [a, b];
    const elements = [passage(["Rival"], "a")];
    const copy = JSON.stringify([citations, elements]);
    classifyCitationScopes("Rival", citations, elements);
    expect(JSON.stringify([citations, elements])).toBe(copy);
  });
});

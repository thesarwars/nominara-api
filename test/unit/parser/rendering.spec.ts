import { describe, expect, it } from "vitest";
import type { AnswerElement } from "../../../src/lib/engines/contract.js";
import {
  ATTR_WEIGHT,
  classifyRendering,
  engineRendersAttributes,
  FORM_MULTIPLIER,
  renderingQuality,
  shouldAlertOnCoverage,
} from "../../../src/lib/parser/rendering.js";

// STORY-039's ten scenarios, minus 10 (the labelled set is STORY-106's) and 7
// (the AUX finding link — see the story for that gap).

function element(over: Partial<AnswerElement> = {}): AnswerElement {
  return { kind: "shopping_element", links: [], ...over } as AnswerElement;
}

function render(text: string, needle: string, over: Partial<Parameters<typeof classifyRendering>[0]> = {}) {
  const start = text.indexOf(needle);
  return classifyRendering({
    text,
    mention: { start, end: start + needle.length },
    engineKey: "google_ai_mode",
    ...over,
  });
}

describe("STORY-039 · render form", () => {
  it("Scenario 1 — a bare mention is bare_text at the floor multiplier", () => {
    const result = render("- HubSpot", "HubSpot");
    expect(result.form).toBe("bare_text");
    expect(FORM_MULTIPLIER[result.form]).toBe(0.6);
  });

  it("Scenario 2 — a mention in a table row is structured_row", () => {
    const result = render("| HubSpot | 50 seats |", "HubSpot");
    expect(result.form).toBe("structured_row");
    expect(FORM_MULTIPLIER[result.form]).toBe(1.1);
  });

  it("Scenario 3 — the primary recommendation is featured, at the top multiplier", () => {
    const result = render("HubSpot", "HubSpot", { isPrimaryRecommendation: true });
    expect(result.form).toBe("featured");
    expect(FORM_MULTIPLIER[result.form]).toBe(1.15);
  });

  it("reads a described mention as described, and a linked one as linked", () => {
    expect(render("- HubSpot — intuitive pipelines for scaling sales teams", "HubSpot").form).toBe("described");
    expect(render("- [HubSpot](https://hubspot.com)", "HubSpot").form).toBe("linked");
  });

  it("prefers a typed element over the markdown guess", () => {
    const result = render("HubSpot", "HubSpot", { element: element({ kind: "table_element" }) });
    expect(result.form).toBe("structured_row");
    expect(result.derivedFrom).toBe("element");
  });
});

describe("STORY-039 · attributes", () => {
  it("Scenario 4 — a priced element yields price, rating and image", () => {
    const result = render("HubSpot", "HubSpot", {
      element: element({ price: "$45/mo", rating: 4.4, image: "https://img", links: [] }),
    });
    expect(result.attrs).toEqual(expect.arrayContaining(["price", "rating", "image"]));
  });

  it("takes attributes ONLY from typed elements, never from prose", () => {
    // "$49/mo" in a sentence is the engine talking about pricing, not the
    // engine merchandising the brand. Scoring it as the latter inverts the
    // finding the metric exists to report — and a false "price shown" is the
    // worse error by design.
    const result = render("HubSpot costs $49/mo and is rated 4.5 stars by users.", "HubSpot");
    expect(result.attrs).not.toContain("price");
    expect(result.attrs).not.toContain("rating");
  });

  it("Scenario 5 — the same payload on a surface without priced elements records them as SURFACE-specific", () => {
    // Blending would make AI Overviews look structurally worse at rendering
    // than it is — a comparison the interface then has to avoid making.
    const aiMode = render("HubSpot", "HubSpot", { engineKey: "google_ai_mode" });
    const overviews = render("HubSpot", "HubSpot", { engineKey: "google_aio" });

    expect(aiMode.surfaceUnavailable).toEqual([]);
    expect(overviews.surfaceUnavailable).toEqual(expect.arrayContaining(["price", "rating"]));
  });

  it("counts review_count as an attribute but gives it no weight of its own", () => {
    // §8 folds it into rating ("includes review_count when present"). Listed
    // so "does the answer show my review count" is answerable; weighted at 0
    // so it does not double-count.
    expect(ATTR_WEIGHT.review_count).toBe(0);
  });
});

describe("STORY-039 · the score", () => {
  it("is the weighted coverage times the form multiplier, clamped", () => {
    const result = render("| HubSpot |", "HubSpot", {
      element: element({ kind: "table_element", price: "$45", rating: 4.4, links: [] }),
    });
    // price 0.28 + rating 0.22 = 0.50, × structured_row 1.10 = 0.55
    expect(result.score).toBeCloseTo(0.55, 5);
  });

  it("never exceeds 1, even with every attribute and the top multiplier", () => {
    const result = render("HubSpot", "HubSpot", {
      isPrimaryRecommendation: true,
      element: element({
        price: "$45",
        rating: 4.4,
        reviewCount: 900,
        image: "i",
        availability: "in stock",
        description: "d",
        link: "https://x",
        spec: { seats: "50" },
        links: [],
      }),
    });
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("Scenario 8 — every mention gets a form and attributes, even an empty one", () => {
    // Populated on every mention from the first capture: not conditionally,
    // not for tracked entities only. An untracked entity promoted later needs
    // its rendering history to already exist.
    const result = render("HubSpot", "HubSpot");
    expect(result.form).toBeDefined();
    expect(Array.isArray(result.attrs)).toBe(true);
  });
});

describe("STORY-039 · the denominator", () => {
  it("Scenario 6 — an engine that renders no attributes is EXCLUDED from its own denominator", () => {
    // The same fairness rule as a failed cell: a measurement we cannot make
    // is not a zero. Penalising a brand for an engine's output format would
    // be wrong.
    expect(engineRendersAttributes("chatgpt")).toBe(false);
    expect(render("HubSpot", "HubSpot", { engineKey: "chatgpt" }).countsTowardDenominator).toBe(false);
    expect(render("HubSpot", "HubSpot", { engineKey: "google_ai_mode" }).countsTowardDenominator).toBe(true);
  });

  it("drops excluded mentions from BOTH sides of the aggregate", () => {
    const capable = render("| HubSpot |", "HubSpot", { element: element({ kind: "table_element", price: "$45", links: [] }) });
    const incapable = render("HubSpot", "HubSpot", { engineKey: "chatgpt" });

    const withBoth = renderingQuality([
      { prominence: 1, rendering: capable },
      { prominence: 1, rendering: incapable },
    ]);
    const capableOnly = renderingQuality([{ prominence: 1, rendering: capable }]);

    expect(withBoth).toBeCloseTo(capableOnly!, 10);
  });

  it("returns NULL for no mentions, never 0", () => {
    // §8: "Absence and a bare-text mention are different facts." This is one
    // of the two highest-risk correctness bugs the plan names, and a 0 here
    // would be it.
    expect(renderingQuality([])).toBeNull();
    expect(renderingQuality([{ prominence: 1, rendering: render("HubSpot", "HubSpot", { engineKey: "chatgpt" }) }])).toBeNull();
  });

  it("weights by prominence, so a prominent bare mention outranks a buried rich one", () => {
    const rich = render("| HubSpot |", "HubSpot", { element: element({ kind: "table_element", price: "$45", links: [] }) });
    const bare = render("- HubSpot", "HubSpot");

    const prominentBare = renderingQuality([
      { prominence: 0.9, rendering: bare },
      { prominence: 0.1, rendering: rich },
    ])!;
    const prominentRich = renderingQuality([
      { prominence: 0.1, rendering: bare },
      { prominence: 0.9, rendering: rich },
    ])!;

    expect(prominentRich).toBeGreaterThan(prominentBare);
  });
});

describe("STORY-039 · coverage alarm", () => {
  it("Scenario 9 — alarms when classification coverage drops, on a real sample", () => {
    // Every mention falling back to markdown on a capable engine means the
    // adapter stopped emitting elements — a vendor change, same class of
    // detector as STORY-037's resolution-failure alarm.
    expect(shouldAlertOnCoverage(100, 50)).toBe(true);
    expect(shouldAlertOnCoverage(100, 95)).toBe(false);
    expect(shouldAlertOnCoverage(10, 0)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { rawCaptureSchema } from "../../../src/lib/engines/contract.js";
import { FIXTURE_CASES, type FixtureCase, type FixturePayloadSet } from "../../../src/lib/engines/fixtures/fixture-cases.js";
import { chatgptFixtures } from "../../../src/lib/engines/fixtures/payloads/chatgpt.js";
import { claudeFixtures } from "../../../src/lib/engines/fixtures/payloads/claude.js";
import { geminiFixtures } from "../../../src/lib/engines/fixtures/payloads/gemini.js";
import { googleAioFixtures } from "../../../src/lib/engines/fixtures/payloads/google_aio.js";
import { googleAiModeFixtures } from "../../../src/lib/engines/fixtures/payloads/google_ai_mode.js";
import { perplexityFixtures } from "../../../src/lib/engines/fixtures/payloads/perplexity.js";

// STORY-027 · AC9 · "Fixture adapters exist for every engine before any real
// adapter... Fixture coverage per engine: a normal answer, a refusal, an
// empty answer, a truncated answer, a redirect-heavy citation set, and a
// priced-product element." Fixtures are hand-authored (D1, this story's
// Implementation decisions) — an explicit approved deviation.
const FIXTURES_BY_ENGINE: Record<string, FixturePayloadSet> = {
  google_aio: googleAioFixtures,
  google_ai_mode: googleAiModeFixtures,
  perplexity: perplexityFixtures,
  chatgpt: chatgptFixtures,
  gemini: geminiFixtures,
  claude: claudeFixtures,
};

const ENGINES = Object.keys(FIXTURES_BY_ENGINE);

describe("STORY-027 · AC9 · every active engine has all six fixture cases", () => {
  it("exactly 6 active engines are covered", () => {
    expect(ENGINES).toHaveLength(6);
  });

  for (const engine of ENGINES) {
    describe(engine, () => {
      const payloads = FIXTURES_BY_ENGINE[engine];

      it("has all 6 cases present, none missing or duplicated", () => {
        expect(payloads).toBeDefined();
        const keys = Object.keys(payloads as FixturePayloadSet).sort();
        expect(keys).toEqual([...FIXTURE_CASES].sort());
      });

      it.each(FIXTURE_CASES)("case '%s' passes rawCaptureSchema", (fixtureCase: FixtureCase) => {
        const payload = (payloads as FixturePayloadSet)[fixtureCase];
        const result = rawCaptureSchema.safeParse(payload);
        expect(result.success, result.success ? "" : JSON.stringify((result as { error: unknown }).error)).toBe(true);
      });

      it("truncated is true ONLY on the truncated case, false on the other five", () => {
        for (const fixtureCase of FIXTURE_CASES) {
          const expected = fixtureCase === "truncated";
          expect((payloads as FixturePayloadSet)[fixtureCase].truncated, fixtureCase).toBe(expected);
        }
      });
    });
  }

  it("perplexity — structuredCitations is present and non-empty on the normal case (the reference engine for citation fidelity)", () => {
    expect(perplexityFixtures.normal.structuredCitations?.length ?? 0).toBeGreaterThan(0);
  });

  it("google_ai_mode — structuredElements is present on the normal case", () => {
    expect(googleAiModeFixtures.normal.structuredElements?.length ?? 0).toBeGreaterThan(0);
  });

  it("google_ai_mode — the priced-product case has a shopping_element (priced elements are AI Mode only)", () => {
    const kinds = googleAiModeFixtures.priced_product_element.structuredElements?.map((el) => el.kind) ?? [];
    expect(kinds).toContain("shopping_element");
  });

  it("google_aio — the priced-product case has NO shopping element", () => {
    const elements = googleAioFixtures.priced_product_element.structuredElements ?? [];
    expect(elements.some((el) => el.kind === "shopping_element")).toBe(false);
  });

  it("google_aio — normal case citations are references[]-shaped (structuredCitations present)", () => {
    expect(googleAioFixtures.normal.structuredCitations?.length ?? 0).toBeGreaterThan(0);
  });

  it("gemini — the redirect-heavy case's citations are unresolved redirect URIs, at least 3 collapsing to the same vendor host", () => {
    const citations = geminiFixtures.redirect_heavy_citations.structuredCitations ?? [];
    expect(citations.length).toBeGreaterThanOrEqual(3);
    const hosts = citations.map((c) => new URL(c.url).host);
    const hostCounts = new Map<string, number>();
    for (const host of hosts) {
      hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    }
    const collapsedHost = [...hostCounts.entries()].find(([, count]) => count >= 3);
    expect(collapsedHost, `hosts seen: ${JSON.stringify(hosts)}`).toBeDefined();
  });

  it("chatgpt/claude — structuredCitations is absent or empty on the normal case; URLs live in text", () => {
    for (const fixtures of [chatgptFixtures, claudeFixtures]) {
      expect(fixtures.normal.structuredCitations ?? []).toHaveLength(0);
      expect(fixtures.normal.text.length).toBeGreaterThan(0);
    }
  });
});

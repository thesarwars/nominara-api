import { describe, expect, it } from "vitest";
import { buildSentiment, SENTIMENT_MIN_MENTIONS } from "./sentiment.js";

// STORY-111 / NFR-CMP-01, scenario 8 - the evidence text that surfaces in the interface and in exports has contact identifiers replaced.
// The span OFFSETS are unchanged (they index the stored text); only the surfaced string differs.
describe("STORY-111 sentiment evidence text is minimised (scenario 8)", () => {
  it("S8 replaces an email, a phone number and a street address in the evidence window, including one the window cuts through", () => {
    const text = "Acme is slow. Reach support at help@acme.example or +1 415 555 2671 or at 10 Downing Street, London.";
    const mention = (start: number, end: number, id: string) => ({
      resultId: id, engine: "gemini", capturedAt: "2026-11-01T00:00:00.000Z", label: "negative" as const, evidenceStart: start, evidenceEnd: end,
      text, reasons: ["support_complaint"], citations: [],
    });
    const { detail } = buildSentiment({
      windowStart: "2026-10-07", windowDays: 30, rootDomain: "acme.example", brandMentions: SENTIMENT_MIN_MENTIONS, dataSource: null,
      mentions: [mention(0, text.length, "a"), mention(0, text.indexOf("help@") + 8, "b")],
      cells: 10, negativeCells: 2, priorCells: 10, priorNegativeCells: 1, priorReasonCounts: {},
    });
    const texts = detail!.mentions.map((m) => m.evidence_text ?? "");
    for (const t of texts) expect(t).not.toMatch(/help@|acme\.example|555|Downing/);
    expect(texts.some((t) => t.includes("[email]"))).toBe(true);
    expect(detail!.mentions.map((m) => m.evidence_end).sort((a, b) => a - b)).toEqual([text.indexOf("help@") + 8, text.length].sort((a, b) => a - b));
  });
});

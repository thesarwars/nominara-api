import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { persistParse, type CaptureRow, type ParseResult } from "../../../src/lib/parser/parse-capture.js";

// STORY-036 AC5 - the in_link flag is PERSISTED per occurrence, not hard-coded false on the way out.

const capture: CaptureRow = {
  resultId: "r1",
  workspaceId: "w1",
  projectId: "p1",
  promptId: "q1",
  engineKey: "google_ai_mode",
  capturedAt: new Date("2026-11-01T00:00:00Z"),
  text: "x",
  flags: [],
};

function mention(inLink: boolean) {
  return {
    mention: {
      entityType: "brand" as const,
      entityId: null,
      entityLabel: "Acme",
      matchedAlias: "Acme",
      occurrenceIndex: 0,
      charStart: 0,
      charEnd: 4,
      firstTokenIndex: 0,
      listPosition: null,
      inLink,
    },
    prominence: 0,
    sentiment: { label: "neutral" as const, score: 0, confidence: 0.5, method: "lexicon" as const, evidenceSpan: { start: 0, end: 4 }, negativeReasons: [] },
    rendering: { form: "bare_text" as const, attrs: [], score: 0 },
    positionClass: "neutral_list" as const,
  };
}

async function inserted(inLink: boolean): Promise<{ sql: string; params: unknown[] }> {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx = { query: (sql: string, params: unknown[] = []) => (calls.push({ sql, params }), Promise.resolve({ rows: [] })) } as unknown as ClientBase;
  const result = {
    normalizedText: "x",
    answerForm: "narrative",
    mentions: [mention(inLink)],
    citations: [],
    brandPresent: false,
    brandRankPosition: null,
    brandSov: 0,
    flags: [],
  } as unknown as ParseResult;
  await persistParse(tx, capture, result, Buffer.alloc(32));
  return calls.find((call) => call.sql.includes("INSERT INTO mention_facts"))!;
}

describe("STORY-036 AC5 - in_link is stored", () => {
  it("STORY-036 AC5 - a mention inside a link is written with in_link = true", async () => {
    const call = await inserted(true);
    expect(call.sql).toMatch(/\bin_link\b/);
    expect(call.params).toContain(true);
    expect(call.params[call.params.length - 1]).toBe(true);
  });

  it("STORY-036 AC5 - a plain mention is written with in_link = false", async () => {
    const call = await inserted(false);
    expect(call.params[call.params.length - 1]).toBe(false);
  });
});

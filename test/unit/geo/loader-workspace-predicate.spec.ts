import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { loadDivergenceInput } from "../../../src/lib/geo/divergence.js";
import { loadSentimentInput } from "../../../src/lib/geo/sentiment.js";
import { loadTopicsInput } from "../../../src/lib/geo/topics.js";

// STORY-061 round 4 - the project rule: every tenant-table reference carries `<alias>.workspace_id = app.current_workspace()`.
// RLS is the guarantee; the predicate is the project's belt-and-braces and the planner's hint. The loaders are run against a recording
// connection and EVERY statement they issue is checked, so a statement added later without it fails here.

const KEYWORDS = new Set(["WHERE", "JOIN", "LEFT", "INNER", "CROSS", "ON", "ORDER", "GROUP", "LIMIT", "SELECT", "AND", "SET", "LATERAL"]);
const TENANT_TABLES = new Set([
  "answer_captures", "tracked_prompts", "mention_facts", "citation_facts", "project_source_index", "source_domains", "topic_clusters",
  "competitors", "geo_alignments", "semantic_nodes", "project_engines", "projects",
]);

function recorder(): { tx: ClientBase; statements: string[] } {
  const statements: string[] = [];
  const tx = {
    query: (sql: string) => {
      statements.push(sql);
      // Every statement gets a row that lets the loader go on: the project, a zeroed count row, one result id. Nothing else is returned empty
      // on purpose: with no rows the loaders skip the statements that depend on them.
      const row = /FROM projects/.test(sql)
        ? [{ root_domain: "acme.com", name: "Acme" }]
        : [{ cells: 0, negative_cells: 0, demo_cells: 0, stale_cells: 0, answers: 0, brand_mentions: 0, demo: 0, live: 0, demo_results: 0, result_id: "00000000-0000-0000-0000-000000000001", prompt_id: "p", engine_key: "gemini", id: "c", label: "x", commercial_intent: 0.5, is_demo: false, stability_score: 1, position_class: null, captured_at: new Date(), sentiment_label: "negative", evidence_start: 0, evidence_end: 4, negative_reasons: ["x"], text: "text", slot_index: 1, raw_url: "u", domain: "d.com", reason: "x", mentions: 1 }];
      return Promise.resolve({ rows: row, rowCount: row.length });
    },
  } as unknown as ClientBase;
  return { tx, statements };
}

/** Every `FROM|JOIN <tenant table> [alias]` in the statement without `[alias.]workspace_id = app.current_workspace()`. */
function unguarded(sql: string): string[] {
  const missing: string[] = [];
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)(?:\s+(?:AS\s+)?([a-z_]+))?/gi)) {
    const table = m[1]!.toLowerCase();
    if (!TENANT_TABLES.has(table)) continue;
    const next = m[2];
    const alias = next !== undefined && !KEYWORDS.has(next.toUpperCase()) ? next : null;
    const predicate = alias === null ? /(?<![\w.])workspace_id\s*=\s*app\.current_workspace\(\)/ : new RegExp(`\\b${alias}\\.workspace_id\\s*=\\s*app\\.current_workspace\\(\\)`);
    if (!predicate.test(sql)) missing.push(`${table}${alias === null ? "" : ` ${alias}`}`);
  }
  return missing;
}

describe("STORY-061 r4 - loaders carry the workspace predicate on every tenant table", () => {
  // The exact number of statements each loader issues: a statement added or dropped changes it, and the test must be re-read.
  const loaders: [string, (tx: ClientBase) => Promise<unknown>, number][] = [
    ["loadDivergenceInput", (tx) => loadDivergenceInput(tx, "p", "2026-09-02", 30), 7],
    ["loadSentimentInput", (tx) => loadSentimentInput(tx, "p", "2026-09-02", 30), 7],
    ["loadTopicsInput", (tx) => loadTopicsInput(tx, "p", "2026-09-02", 30), 7],
  ];
  for (const [name, run, count] of loaders) {
    it(`[r4-1] ${name}: no statement reads a tenant table without workspace_id = app.current_workspace()`, async () => {
      const { tx, statements } = recorder();
      await run(tx);
      expect(statements).toHaveLength(count);
      const bad = statements.flatMap((s) => unguarded(s));
      expect(bad).toEqual([]);
    });
  }
});

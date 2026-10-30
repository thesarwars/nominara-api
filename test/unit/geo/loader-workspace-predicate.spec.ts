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
      return Promise.resolve({ rows: /FROM projects/.test(sql) ? [{ root_domain: "acme.com", name: "Acme" }] : [], rowCount: 0 });
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
  const loaders: [string, (tx: ClientBase) => Promise<unknown>][] = [
    ["loadDivergenceInput", (tx) => loadDivergenceInput(tx, "p", "2026-09-02", 30)],
    ["loadSentimentInput", (tx) => loadSentimentInput(tx, "p", "2026-09-02", 30)],
    ["loadTopicsInput", (tx) => loadTopicsInput(tx, "p", "2026-09-02", 30)],
  ];
  for (const [name, run] of loaders) {
    it(`[r4-1] ${name}: no statement reads a tenant table without workspace_id = app.current_workspace()`, async () => {
      const { tx, statements } = recorder();
      await run(tx).catch(() => undefined); // an empty project may stop a loader early; what it issued is what is checked
      expect(statements.length).toBeGreaterThan(1);
      const bad = statements.flatMap((s) => unguarded(s));
      expect(bad).toEqual([]);
    });
  }
});

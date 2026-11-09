import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSearchIndexOverContent, searchQueryOffenders } from "./names-not-indexed.js";

// STORY-111 / NFR-CMP-01 - "Personal names are preserved but never indexed, searched, or used to build a profile." Scenario 10.
//
// A personal name in an engine answer lives in the answer text (response_excerpt, payload.text), in the extracted labels (mention_facts.entity_label,
// matched_alias) and in the evidence text. THE ASSERTION IS ABOUT SEARCH PATHS OVER THOSE: no full-text or trigram index on them, and no query
// anywhere in src that does text search over them. The default is REPORT: a new index or query shape over these columns fails here until a
// person decides, rather than being waved through by an allow-list entry.
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = join(SRC, "db/migrations/sql");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? (n === "node_modules" ? [] : walk(full)) : [full];
  });
}

describe("STORY-111 no index or search path over personal names (scenario 10)", () => {
  const migrations = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".up.sql"))
    .map((f) => ({ name: f, sql: readFileSync(join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "") }));

  it("S10 no full-text or trigram index exists on answer text or extracted labels", () => {
    const offenders: string[] = [];
    for (const m of migrations) {
      for (const stmt of m.sql.split(";")) if (isSearchIndexOverContent(stmt)) offenders.push(`${m.name}: ${stmt.trim().slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("S10 no application query does full-text, trigram or pattern search over those columns", () => {
    const sources = walk(SRC).filter((f) => /\.ts$/.test(f) && !/\.(spec|test)\.ts$/.test(f)).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }));
    const offenders: string[] = [];
    for (const f of sources) {
      if (f.path.startsWith("lib/compliance/")) continue;
      for (const p of searchQueryOffenders(f.text)) offenders.push(`${f.path}: ${p}`);
    }
    expect(offenders).toEqual([]);
  });

  it("S10 the detectors work: a planted trigram index and planted text searches are caught BY THE SAME FUNCTIONS that guard the real code", () => {
    expect(isSearchIndexOverContent("CREATE INDEX ix_x ON mention_facts USING gin (entity_label gin_trgm_ops)")).toBe(true);
    expect(isSearchIndexOverContent("CREATE INDEX ix_t ON answer_captures USING gin (to_tsvector('simple', response_excerpt))")).toBe(true);
    // ... and ordinary indexes are not flagged.
    expect(isSearchIndexOverContent("CREATE INDEX ix_ok ON mention_facts (project_id, entity_type)")).toBe(false);
    expect(isSearchIndexOverContent("CREATE INDEX ix_other ON tasks USING gin (title gin_trgm_ops)")).toBe(false);
    expect(searchQueryOffenders("WHERE entity_label ILIKE $1")).not.toEqual([]);
    expect(searchQueryOffenders("WHERE response_excerpt LIKE '%x%'")).not.toEqual([]);
    expect(searchQueryOffenders("SELECT * FROM x WHERE to_tsvector('simple', matched_alias) @@ q")).not.toEqual([]);
    expect(searchQueryOffenders("SELECT entity_label FROM mention_facts WHERE project_id = $1")).toEqual([]);
  });
});

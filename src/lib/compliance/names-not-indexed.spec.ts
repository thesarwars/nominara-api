import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// STORY-111 / NFR-CMP-01 - "Personal names are preserved but never indexed, searched, or used to build a profile." Scenario 10.
//
// A personal name in an engine answer lives in the answer text (response_excerpt, payload.text), in the extracted labels (mention_facts.entity_label,
// matched_alias) and in the evidence text. THE ASSERTION IS ABOUT SEARCH PATHS OVER THOSE: no full-text or trigram index on them, and no query
// anywhere in src that does text search over them. The default is REPORT: a new index or query shape over these columns fails here until a
// person decides, rather than being waved through by an allow-list entry.
const SRC = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATIONS = join(SRC, "db/migrations/sql");

const CONTENT_COLUMNS = ["response_excerpt", "payload", "entity_label", "matched_alias", "evidence_text", "raw_url"];
const CONTENT_TABLES = ["answer_captures", "mention_facts", "citation_facts"];

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
      for (const stmt of m.sql.split(";")) {
        if (!/CREATE\s+(UNIQUE\s+)?INDEX/i.test(stmt)) continue;
        const onContent = CONTENT_TABLES.some((t) => new RegExp(`\\bON\\s+${t}\\b`, "i").test(stmt));
        if (!onContent) continue;
        const searchy = /gin_trgm_ops|gist_trgm_ops|tsvector|to_tsvector|pg_trgm|USING\s+gist/i.test(stmt);
        const touchesContent = CONTENT_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`, "i").test(stmt));
        if (searchy && touchesContent) offenders.push(`${m.name}: ${stmt.trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("S10 no application query does full-text, trigram or pattern search over those columns", () => {
    const sources = walk(SRC).filter((f) => /\.ts$/.test(f) && !/\.(spec|test)\.ts$/.test(f)).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }));
    const offenders: string[] = [];
    const column = `(?:${CONTENT_COLUMNS.join("|")})`;
    const patterns = [
      // SQL keywords are matched case-SENSITIVELY: lower-case "like" is English.
      new RegExp(`\\b${column}\\b[^;\\n]{0,40}\\b(?:ILIKE|LIKE|SIMILAR TO)\\b`),
      new RegExp(`\\b(?:ILIKE|LIKE)\\b[^;\\n]{0,40}\\b${column}\\b`),
      new RegExp(`to_tsvector\\([^)]*${column}`, "i"),
      new RegExp(`similarity\\([^)]*${column}`, "i"),
      new RegExp(`${column}\\s+%\\s`, "i"),
      new RegExp(column + "\\s*(?:->>|#>>)\\s*'text'\\s*(?:~|~\\*|ILIKE|LIKE)", "i"),
    ];
    for (const f of sources) {
      if (f.path.startsWith("lib/compliance/")) continue;
      for (const p of patterns) if (p.test(f.text)) offenders.push(`${f.path}: ${p.source.slice(0, 40)}`);
    }
    expect(offenders).toEqual([]);
  });

  it("S10 the detectors work: a planted trigram index and a planted ILIKE are both caught", () => {
    const planted = "CREATE INDEX ix_x ON mention_facts USING gin (entity_label gin_trgm_ops)";
    expect(/gin_trgm_ops/.test(planted) && /\bON\s+mention_facts\b/i.test(planted) && /\bentity_label\b/.test(planted)).toBe(true);
    const column = `(?:${CONTENT_COLUMNS.join("|")})`;
    expect(new RegExp(`\\b${column}\\b[^;\\n]{0,40}\\b(?:ILIKE|LIKE)\\b`).test("WHERE entity_label ILIKE $1")).toBe(true);
  });
});

// STORY-111 / NFR-CMP-01 - the detectors behind "personal names are preserved but never indexed, searched, or used to build a profile".
//
// A personal name in an engine answer lives in the answer text (response_excerpt, payload.text), in the extracted labels (mention_facts.entity_label,
// matched_alias) and in the evidence text. These functions are what `names-not-indexed.spec.ts` runs over the migrations and over src, AND over a
// planted index and a planted query, so the planted case exercises the very code that guards the real one. The default is REPORT.

export const CONTENT_COLUMNS = ["response_excerpt", "payload", "entity_label", "matched_alias", "evidence_text", "raw_url"] as const;
export const CONTENT_TABLES = ["answer_captures", "mention_facts", "citation_facts"] as const;

const COLUMN = `(?:${CONTENT_COLUMNS.join("|")})`;

/** The query shapes that search text over a content column. SQL keywords are matched case-SENSITIVELY: lower-case "like" is English. */
export const SEARCH_QUERY_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b${COLUMN}\\b[^;\\n]{0,40}\\b(?:ILIKE|LIKE|SIMILAR TO)\\b`),
  new RegExp(`\\b(?:ILIKE|LIKE)\\b[^;\\n]{0,40}\\b${COLUMN}\\b`),
  new RegExp(`to_tsvector\\([^)]*${COLUMN}`, "i"),
  new RegExp(`similarity\\([^)]*${COLUMN}`, "i"),
  new RegExp(`${COLUMN}\\s+%\\s`, "i"),
  new RegExp(COLUMN + "\\s*(?:->>|#>>)\\s*'text'\\s*(?:~|~\\*|ILIKE|LIKE)", "i"),
];

/** True when one CREATE INDEX statement makes a content table's content column searchable (trigram, full-text or gist). */
export function isSearchIndexOverContent(statement: string): boolean {
  if (!/CREATE\s+(UNIQUE\s+)?INDEX/i.test(statement)) return false;
  if (!CONTENT_TABLES.some((t) => new RegExp(`\\bON\\s+${t}\\b`, "i").test(statement))) return false;
  const searchy = /gin_trgm_ops|gist_trgm_ops|tsvector|to_tsvector|pg_trgm|USING\s+gist/i.test(statement);
  const touchesContent = CONTENT_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`, "i").test(statement));
  return searchy && touchesContent;
}

/** The patterns (by source) that a piece of application source matches. Empty = no text-search path over content. */
export function searchQueryOffenders(sourceText: string): string[] {
  return SEARCH_QUERY_PATTERNS.filter((p) => p.test(sourceText)).map((p) => p.source.slice(0, 40));
}

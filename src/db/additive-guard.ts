import type { Client } from "pg";

// The annotation a migration author adds to acknowledge a destructive step is
// intentional — ci-cd-and-environments.md §3's "Contract" phase of an
// expand/contract migration (KAD-16). The guard does not distinguish expand
// from contract by content, only by whether the author explicitly said so.
export const CONTRACT_PHASE_ANNOTATION = "-- @contract-phase";

const DESTRUCTIVE_PATTERNS: Array<{
  regex: RegExp;
  extractTable: (match: RegExpMatchArray) => string;
  isSafe?: (sql: string, match: RegExpMatchArray) => boolean;
}> = [
  {
    regex: /drop\s+table\s+(?:if\s+exists\s+)?([a-zA-Z0-9_."]+)/gi,
    extractTable: (m) => normalizeIdentifier(m[1]!),
  },
  {
    regex: /alter\s+table\s+(?:if\s+exists\s+)?([a-zA-Z0-9_."]+)\s+drop\s+column/gi,
    extractTable: (m) => normalizeIdentifier(m[1]!),
  },
  {
    regex: /truncate\s+(?:table\s+)?([a-zA-Z0-9_."]+)/gi,
    extractTable: (m) => normalizeIdentifier(m[1]!),
  },
  // ci-cd-and-environments.md §3: "CI rejects a DROP or a NOT NULL-add on a
  // populated table unless it carries that annotation."
  {
    regex: /alter\s+table\s+(?:if\s+exists\s+)?([a-zA-Z0-9_."]+)\s+alter\s+column\s+[a-zA-Z0-9_"]+\s+set\s+not\s+null/gi,
    extractTable: (m) => normalizeIdentifier(m[1]!),
  },
  {
    regex:
      /alter\s+table\s+(?:if\s+exists\s+)?([a-zA-Z0-9_."]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?[a-zA-Z0-9_"]+(?:[^,;(]|\([^)]*\))*?\bnot\s+null\b/gis,
    extractTable: (m) => normalizeIdentifier(m[1]!),
    // ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only on Postgres 11+
    // (existing rows read the default; no rewrite, no failure on a populated
    // table). It is not the hazard the rule exists for. NOT NULL with no default
    // fails outright on a populated table, and a volatile default rewrites it.
    isSafe: (sql, m) => isSafeConstantDefaultAdd(sql, m),
  },
];

// Fail closed: a default is accepted only if it is recognisably a constant or
// a transaction-stable timestamp. Anything else — any other function call,
// a subquery, a sequence — is reported, so an unknown form is never waved through.
const SAFE_DEFAULT_EXPR = new RegExp(
  "^(?:" +
    [
      "'(?:[^']|'')*'", // string literal
      "[+-]?\\d+(?:\\.\\d+)?", // number
      "true|false",
      "now\\(\\)|current_timestamp|current_date",
    ].join("|") +
    ")(?:::[a-z_][a-z0-9_ ]*(?:\\(\\d+(?:,\\s*\\d+)?\\))?(?:\\[\\])?)*$",
  "i",
);

function isSafeConstantDefaultAdd(sql: string, match: RegExpMatchArray): boolean {
  const start = match.index ?? 0;
  const afterMatch = sql.slice(start + match[0].length);
  // The column definition runs to the next top-level `,` or `;`.
  let end = afterMatch.length;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < afterMatch.length; i++) {
    const c = afterMatch[i]!;
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth <= 0 && (c === "," || c === ";")) {
      end = i;
      break;
    }
  }
  const definition = (match[0] + afterMatch.slice(0, end)).replace(/--[^\n]*/g, " ");
  const defaults = [...definition.matchAll(/\bdefault\s+/gi)];
  if (defaults.length !== 1) return false;
  const exprStart = defaults[0]!.index! + defaults[0]![0].length;
  const expr = definition
    .slice(exprStart)
    .replace(/\s+(?:not\s+null|null|constraint\b|check\b|references\b|unique\b|primary\b|collate\b)[\s\S]*$/i, "")
    .trim();
  return SAFE_DEFAULT_EXPR.test(expr);
}

const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;

function normalizeIdentifier(raw: string): string {
  const unquoted = raw.replace(/"/g, "");
  if (!SAFE_IDENTIFIER.test(unquoted)) {
    // Refuse to interpolate anything that isn't a plain [schema.]table
    // identifier, rather than silently mis-targeting the populated-table
    // check on an unusually-formed name pulled out of a migration file.
    throw new Error(`additive-only guard: cannot safely parse table identifier "${raw}"`);
  }
  return unquoted;
}

export interface DestructiveStep {
  statementKind: string;
  table: string;
}

export function findDestructiveSteps(sql: string): DestructiveStep[] {
  const steps: DestructiveStep[] = [];
  for (const { regex, extractTable, isSafe } of DESTRUCTIVE_PATTERNS) {
    for (const match of sql.matchAll(regex)) {
      if (isSafe?.(sql, match)) continue;
      steps.push({ statementKind: match[0], table: extractTable(match) });
    }
  }
  return steps;
}

export function hasContractPhaseAnnotation(sql: string): boolean {
  return sql
    .split("\n")
    .some((line) => line.trim().toLowerCase() === CONTRACT_PHASE_ANNOTATION);
}

async function isPopulated(client: Client, table: string): Promise<boolean> {
  try {
    const result = await client.query(`SELECT EXISTS (SELECT 1 FROM ${table} LIMIT 1) AS populated`);
    return result.rows[0]?.populated === true;
  } catch {
    // Table does not exist yet (e.g. created and dropped within the same
    // migration, or this is a fresh database) — nothing to protect.
    return false;
  }
}

/**
 * Rejects a migration that drops or truncates data on a populated table
 * unless the file carries the contract-phase annotation. Throws with the
 * offending table names when it rejects.
 */
export async function assertAdditiveOnly(sql: string, client: Client): Promise<void> {
  const destructiveSteps = findDestructiveSteps(sql);
  if (destructiveSteps.length === 0) {
    return;
  }
  if (hasContractPhaseAnnotation(sql)) {
    return;
  }

  const populatedTables: string[] = [];
  for (const step of destructiveSteps) {
    if (await isPopulated(client, step.table)) {
      populatedTables.push(step.table);
    }
  }

  if (populatedTables.length > 0) {
    throw new Error(
      `additive-only guard: destructive step(s) on populated table(s) [${populatedTables.join(", ")}] ` +
        `without the ${CONTRACT_PHASE_ANNOTATION} annotation. Add the annotation as its own line in the ` +
        `migration file if this is an intentional contract-phase step.`,
    );
  }
}

// STORY-009: matviews bypass the RLS of their base tables at query time
// (ISO-16, data-model.md §1 "Pre-aggregation"), so this rule is a security
// property, not a style preference — it is deliberately NOT folded into
// assertAdditiveOnly's `-- @contract-phase` exemption path. There is no
// legitimate reason to ever create one, so no annotation can permit it.
//
// The regex requires the three words contiguous and in order ("create ...
// materialized ... view"), tolerant of any run of whitespace (including
// newlines) between them. This deliberately does NOT match a plain
// `CREATE VIEW`, and does NOT match prose that merely discusses materialized
// views without that literal contiguous sequence (e.g. "no materialized view
// is created here" — the word "create" and the phrase "materialized view"
// both appear, but never adjacent in that order).
const MATERIALIZED_VIEW_PATTERN = /create\s+materialized\s+view\b/gi;

export function findMaterializedViewSteps(sql: string): string[] {
  return Array.from(sql.matchAll(MATERIALIZED_VIEW_PATTERN), (match) => match[0]);
}

/**
 * Rejects a migration that creates a materialized view, unconditionally —
 * no annotation bypasses this check.
 */
export function assertNoMaterializedViews(sql: string): void {
  const steps = findMaterializedViewSteps(sql);
  if (steps.length > 0) {
    throw new Error(
      `materialized-view guard: ${steps.length} CREATE MATERIALIZED VIEW step(s) found. ` +
        `Materialized views are prohibited (ISO-16) — they do not enforce the RLS of their ` +
        `base tables. Use an ordinary table maintained incrementally instead.`,
    );
  }
}

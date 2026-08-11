import type { Client } from "pg";

// The annotation a migration author adds to acknowledge a destructive step is
// intentional — ci-cd-and-environments.md §3's "Contract" phase of an
// expand/contract migration (KAD-16). The guard does not distinguish expand
// from contract by content, only by whether the author explicitly said so.
export const CONTRACT_PHASE_ANNOTATION = "-- @contract-phase";

const DESTRUCTIVE_PATTERNS: Array<{ regex: RegExp; extractTable: (match: RegExpMatchArray) => string }> = [
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
      /alter\s+table\s+(?:if\s+exists\s+)?([a-zA-Z0-9_."]+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?[a-zA-Z0-9_"]+[^,;]*?\bnot\s+null\b/gis,
    extractTable: (m) => normalizeIdentifier(m[1]!),
  },
];

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
  for (const { regex, extractTable } of DESTRUCTIVE_PATTERNS) {
    for (const match of sql.matchAll(regex)) {
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

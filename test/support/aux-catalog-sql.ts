import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS_DIR } from "../../src/db/migrate-runner.js";
import type { AuxCatalogRule } from "../../src/lib/aux/catalog.js";

// STORY-051 — the AUX rule catalog as the migrations define it, read from the SQL text, so a unit test runs the rules against the
// SAME thresholds, weights and customer text a database would hold (AC5: thresholds are data, not constants in the evaluator).
// Later migrations override earlier ones by code, as ON CONFLICT DO UPDATE does.

export interface CatalogSqlRow extends AuxCatalogRule {
  readonly title: string;
  readonly description: string;
  readonly rationale: string;
  readonly severityDefault: string;
  readonly autoFixable: boolean;
  readonly taskThreshold: string;
}

const MIGRATIONS = ["0070_aux_catalog_crawler_access", "0148_aux_catalog_document_rules"];

const ROW =
  /\(\s*'(AUX-R-\d{3})',\s*'([a-z_]+)',\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*'([a-z]+)',\s*([0-9.]+),\s*(true|false),\s*'(\{.*?\})'::jsonb,\s*'([a-z]+)',\s*'([^']+)'\s*\)/gs;

export function readCatalogSql(migrations: readonly string[] = MIGRATIONS): CatalogSqlRow[] {
  const byCode = new Map<string, CatalogSqlRow>();
  for (const name of migrations) {
    const sql = readFileSync(join(MIGRATIONS_DIR, `${name}.up.sql`), "utf8");
    for (const m of sql.matchAll(ROW)) {
      byCode.set(m[1]!, {
        code: m[1]!,
        category: m[2]!,
        title: m[3]!,
        description: m[4]!,
        rationale: m[5]!,
        severityDefault: m[6]!,
        weight: Number(m[7]),
        autoFixable: m[8] === "true",
        thresholds: JSON.parse(m[9]!) as Record<string, unknown>,
        taskThreshold: m[10]!,
        ruleVersion: m[11]!,
      });
    }
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

import type { AuxRuleFinding } from "../../contracts/aux/index.js";
import { loadAuxCatalog, type AuxCatalog, type AuxCatalogRule } from "../../src/lib/aux/catalog.js";
import type { AuxDocument } from "../../src/lib/aux/document-model.js";
import { evaluateDocument } from "../../src/lib/aux/rules/engine.js";
import { AUX_RULES } from "../../src/lib/aux/rules/index.js";
import { readCatalogSql } from "./aux-catalog-sql.js";

export const CATALOG_ROWS = readCatalogSql();
export const CATALOG: AuxCatalog = loadAuxCatalog(CATALOG_ROWS);
export const PROJECT_ID = "00000000-0000-7000-8000-000000000001";

/** All implemented rules over one page, with the migrated catalog. */
export const runAll = (doc: AuxDocument, catalog: AuxCatalog = CATALOG): Promise<AuxRuleFinding[]> =>
  evaluateDocument(doc, catalog, AUX_RULES, { projectId: PROJECT_ID });

export async function findings(doc: AuxDocument, code: string, catalog: AuxCatalog = CATALOG): Promise<AuxRuleFinding[]> {
  return (await runAll(doc, catalog)).filter((f) => f.rule_code === code);
}

/** The catalog with one rule's thresholds replaced: proves a number is read from data. */
export function withThresholds(code: string, patch: Record<string, unknown>): AuxCatalog {
  const rows: AuxCatalogRule[] = CATALOG_ROWS.map((r) => (r.code === code ? { ...r, thresholds: { ...r.thresholds, ...patch } } : r));
  return loadAuxCatalog(rows);
}

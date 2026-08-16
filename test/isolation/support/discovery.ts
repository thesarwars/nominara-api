import type { Client } from "pg";
import { GLOBAL_TABLES, TENANT_SCOPE_COLUMN } from "../../../src/db/conventions.js";
import { TENANT_TABLES } from "../../../src/db/rls/tenant-tables.generated.js";

// STORY-012 T4 — schema discovery. This module reads the LIVE catalog
// (pg_class/information_schema), never a hand-maintained list, so the
// isolation suite's coverage cannot silently shrink as tables are added.
// Deliberately does NOT import src/db/rls/generate.ts's resolveScopeColumn —
// that would make this suite's own discovery dependent on the exact
// generator it is supposed to be independently checking. This file
// re-derives scope-column resolution from the same public inputs
// (TENANT_SCOPE_COLUMN, "does a workspace_id column exist") instead, so a
// bug in the generator's classification and a bug in this discovery module
// are extremely unlikely to be the SAME bug.

export interface DiscoveredTable {
  readonly name: string;
  readonly columns: ReadonlySet<string>;
}

export interface ClassifiedTenantTable extends DiscoveredTable {
  readonly scopeColumn: string;
}

export interface PartitionChild {
  readonly name: string;
  readonly parent: string;
}

export interface EncryptedColumn {
  readonly table: string;
  readonly column: string;
}

const CENSUS_TABLES_SQL = `
  SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
`;

/** Every BASE table (never a partition child) in the `public` schema, with its column set. */
export async function discoverAllBaseTables(client: Client): Promise<DiscoveredTable[]> {
  const tablesResult = await client.query<{ table_name: string }>(CENSUS_TABLES_SQL);
  const tableNames = tablesResult.rows.map((r) => r.table_name);
  if (tableNames.length === 0) {
    // Anti-vacuity (ISO-00): an empty discovery result must fail loudly, not
    // let every downstream 0-iteration loop pass vacuously.
    throw new Error("discovery: pg_class returned zero base tables in schema public — is the migration chain applied?");
  }

  const columnsResult = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [tableNames],
  );
  const columnsByTable = new Map<string, Set<string>>();
  for (const name of tableNames) columnsByTable.set(name, new Set());
  for (const row of columnsResult.rows) columnsByTable.get(row.table_name)?.add(row.column_name);

  return tableNames.map((name) => ({ name, columns: columnsByTable.get(name) ?? new Set() })).sort((a, b) => a.name.localeCompare(b.name));
}

/** GLOBAL_TABLES entries actually present in the live schema (a real catalog check, not a copy of the constant). */
export async function discoverGlobalTables(client: Client): Promise<DiscoveredTable[]> {
  const all = await discoverAllBaseTables(client);
  const globalSet = new Set<string>(GLOBAL_TABLES);
  return all.filter((t) => globalSet.has(t.name));
}

function resolveScopeColumn(table: DiscoveredTable): string | null {
  const explicit = TENANT_SCOPE_COLUMN[table.name];
  if (explicit) return explicit;
  if (table.columns.has("workspace_id")) return "workspace_id";
  return null;
}

/**
 * Every classifiable tenant table — has a real scope column (either the
 * structural "workspace_id" convention or an explicit TENANT_SCOPE_COLUMN
 * entry) — EXCLUDING GLOBAL_TABLES. Throws (ISO-06's whole point) if a table
 * is neither a GLOBAL_TABLES entry nor classifiable: a table shipped without
 * an isolation decision fails HERE, not by silently shrinking every other
 * loop in the suite.
 */
export async function discoverTenantTables(client: Client): Promise<ClassifiedTenantTable[]> {
  const all = await discoverAllBaseTables(client);
  const globalSet = new Set<string>(GLOBAL_TABLES);
  const classified: ClassifiedTenantTable[] = [];
  const unclassified: string[] = [];

  for (const table of all) {
    if (globalSet.has(table.name)) continue;
    const scopeColumn = resolveScopeColumn(table);
    if (scopeColumn === null) {
      unclassified.push(table.name);
      continue;
    }
    classified.push({ ...table, scopeColumn });
  }

  if (unclassified.length > 0) {
    throw new Error(
      `discovery: table(s) [${unclassified.join(", ")}] are neither in GLOBAL_TABLES nor resolve a tenant scope ` +
        "column (no workspace_id, no TENANT_SCOPE_COLUMN entry) — a table cannot ship without an explicit isolation decision.",
    );
  }
  if (classified.length === 0) {
    throw new Error("discovery: zero tenant tables discovered — the empty-collection trap (T26) forbids this passing vacuously.");
  }
  return classified;
}

/** Every partition child (via pg_inherits), namespace-qualified on the parent's schema. */
export async function discoverPartitionChildren(client: Client): Promise<PartitionChild[]> {
  const result = await client.query<{ relname: string; parent_name: string }>(
    `SELECT c.relname, p.relname AS parent_name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND p.relkind = 'p'`,
  );
  return result.rows.map((r) => ({ name: r.relname, parent: r.parent_name }));
}

/** discoverScopeColumn as a standalone, per-table lookup (used by assertions that already hold a ClassifiedTenantTable elsewhere). */
export function discoverScopeColumn(table: DiscoveredTable): string | null {
  return resolveScopeColumn(table);
}

/**
 * Every column ending in `_enc` across every base table — the envelope-
 * encrypted-column naming convention (security-and-tenancy.md §8), discovered
 * from the schema rather than hand-listed, so a table gaining one later is
 * picked up automatically (AC "The encrypted-column assertion discovers
 * columns from the schema").
 */
export async function discoverEncryptedColumns(client: Client): Promise<EncryptedColumn[]> {
  const result = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN pg_class t ON t.relname = c.table_name
       JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name LIKE '%\\_enc' ESCAPE '\\' AND NOT t.relispartition
      ORDER BY c.table_name, c.column_name`,
  );
  if (result.rows.length === 0) {
    throw new Error("discovery: zero *_enc columns discovered — the empty-collection trap forbids ISO-12 passing vacuously.");
  }
  return result.rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

export interface CensusResult {
  readonly totalTables: number;
  readonly tenantTables: ClassifiedTenantTable[];
  readonly globalTables: DiscoveredTable[];
}

/**
 * The ISO-06 census: tenant and global counts computed INDEPENDENTLY (never
 * one by subtracting the other from a total), then cross-checked against
 * each other and against the fixed numbers (59/10/69) and against this
 * repo's own committed GLOBAL_TABLES / TENANT_TABLES declarations.
 */
export async function computeCensus(client: Client): Promise<CensusResult> {
  const all = await discoverAllBaseTables(client);
  const tenantTables = await discoverTenantTables(client);
  const globalTables = await discoverGlobalTables(client);
  return { totalTables: all.length, tenantTables, globalTables };
}

/** Cross-check discovery against the committed GLOBAL_TABLES / TENANT_TABLES declarations — fail loudly on divergence (T4). */
export function crossCheckAgainstConventions(census: CensusResult): void {
  const discoveredGlobalNames = new Set(census.globalTables.map((t) => t.name));
  const declaredGlobalNames = new Set<string>(GLOBAL_TABLES);
  const globalDiff = symmetricDifference(discoveredGlobalNames, declaredGlobalNames);
  if (globalDiff.size > 0) {
    throw new Error(`discovery: GLOBAL_TABLES cross-check diverges from src/db/conventions.ts: [${[...globalDiff].join(", ")}]`);
  }

  const discoveredTenantNames = new Set(census.tenantTables.map((t) => t.name));
  const declaredTenantNames = new Set<string>(TENANT_TABLES);
  const tenantDiff = symmetricDifference(discoveredTenantNames, declaredTenantNames);
  if (tenantDiff.size > 0) {
    throw new Error(
      `discovery: tenant table set diverges from src/db/rls/tenant-tables.generated.ts: [${[...tenantDiff].join(", ")}] — ` +
        "run `pnpm db:rls-generate` if a table was legitimately added.",
    );
  }
}

function parsePgTextArray(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "{}") return [];
  return trimmed.replace(/^\{/, "").replace(/\}$/, "").split(",");
}

function symmetricDifference<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
  const diff = new Set<T>();
  for (const item of a) if (!b.has(item)) diff.add(item);
  for (const item of b) if (!a.has(item)) diff.add(item);
  return diff;
}

/**
 * A tenant table is "structurally single-row-per-tenant" when its own scope
 * column (or the table's sole primary key) makes more than one row per
 * tenant impossible by construction — e.g. `credit_wallets` (PRIMARY KEY
 * (workspace_id) alone) and `workspaces` itself (scoped by its own `id`, one
 * row IS the tenant). The three-tenant fixture's coverage spec (T5) asserts
 * `= 1` for these, `>= 50` for everything else — documented here rather than
 * silently special-cased inline, since it is itself a fail-closed schema fact
 * (pg_constraint), not a hand-maintained list.
 */
export async function discoverSingleRowPerTenantTables(client: Client, tables: readonly ClassifiedTenantTable[]): Promise<Set<string>> {
  // array_agg over information_schema's sql_identifier domain comes back as
  // the raw Postgres array-literal TEXT ("{a,b}"), not a JS array — pg has no
  // default parser registered for that OID (the exact same class of issue
  // src/db/rls/rls-check.ts's parsePgTextArray documents for pg_policies.roles).
  const result = await client.query<{ table_name: string; columns: string }>(
    `SELECT tc.table_name, array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
      GROUP BY tc.table_name`,
  );
  const pkByTable = new Map(result.rows.map((r) => [r.table_name, parsePgTextArray(r.columns)]));
  const singleRow = new Set<string>();
  for (const table of tables) {
    const pk = pkByTable.get(table.name);
    if (pk && pk.length === 1 && pk[0] === table.scopeColumn) {
      singleRow.add(table.name);
    }
  }
  return singleRow;
}

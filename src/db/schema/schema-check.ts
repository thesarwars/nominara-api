import { fileURLToPath } from "node:url";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type { Client } from "pg";
import { connect, requireDatabaseUrl } from "../client.js";
import { migrateUp } from "../migrate-runner.js";
import { introspectSchema, type IntrospectedTable } from "./introspect.js";
import * as schema from "./index.js";

// STORY-122 — `pnpm db:schema-check`, the sibling of `pnpm db:rls-check` and
// modeled on it.
//
// `pnpm db:schema-generate --check` answers one question — "did someone
// change a migration and forget to regenerate?" — and answers it with a file
// name. That is the right answer for that question and a useless one for
// this: the three ways a schema file and a database can disagree have three
// different remedies, and a reviewer should not have to diff 400 lines to
// find out which happened.
//
// So this compares the COMMITTED Drizzle objects — through Drizzle's own
// getTableConfig, not by parsing the source — against a freshly-migrated
// database, and reports each kind separately. It therefore also catches a
// hand-edit, which a regenerate-and-diff cannot distinguish from a stale
// file.

export interface SchemaCheckResult {
  /** A base table in the migrated database that no pgTable definition describes — "a migration added a table and nobody regenerated". */
  undefinedTables: string[];
  /** A pgTable definition for a table the database does not have — "a migration dropped a table, or the definition was hand-written". */
  orphanedDefinitions: string[];
  /** "<table>.<column>: database <x>, schema <y>" — a column present in both whose type or nullability differs. */
  columnMismatches: string[];
  /** "<table>.<column>" — present in the database, absent from the definition, or the reverse. */
  columnPresenceMismatches: string[];
  /** "<table>: database [...], schema [...]" — differing primary keys. */
  primaryKeyMismatches: string[];
}

export function isClean(result: SchemaCheckResult): boolean {
  return (
    result.undefinedTables.length === 0 &&
    result.orphanedDefinitions.length === 0 &&
    result.columnMismatches.length === 0 &&
    result.columnPresenceMismatches.length === 0 &&
    result.primaryKeyMismatches.length === 0
  );
}

/**
 * Drizzle and Postgres spell several types differently while meaning the
 * same thing. Normalising both sides is not a way of being lenient — every
 * pair below is an exact synonym in Postgres itself, and `format_type`
 * simply prefers the long spelling.
 */
function normalizeSqlType(sqlType: string): string {
  const isArray = sqlType.endsWith("[]");
  const base = (isArray ? sqlType.slice(0, -2) : sqlType)
    .replace(/^char\(/, "character(")
    .replace(/^varchar\(/, "character varying(")
    .replace(/^timestamptz\b/, "timestamp with time zone")
    .replace(/^int4$/, "integer")
    .replace(/^int2$/, "smallint")
    .replace(/^int8$/, "bigint")
    .replace(/^float4$/, "real")
    .replace(/^float8$/, "double precision")
    .replace(/^bool$/, "boolean")
    .replace(/\s+/g, " ")
    // Drizzle renders a type's parameters as "numeric(12, 2)"; format_type
    // renders "numeric(12,2)". Same type, different whitespace.
    .replace(/\(([^)]*)\)/, (_match, inner: string) => `(${inner.replace(/\s*,\s*/g, ",").trim()})`)
    .trim();
  return isArray ? `${base}[]` : base;
}

interface DefinedTable {
  readonly name: string;
  readonly columns: ReadonlyMap<string, { sqlType: string; notNull: boolean }>;
  readonly primaryKey: readonly string[];
}

/** Every pgTable exported from src/db/schema/index.ts, read through Drizzle's own metadata. */
export function definedTables(modules: Record<string, unknown> = schema): DefinedTable[] {
  const tables: DefinedTable[] = [];
  for (const value of Object.values(modules)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as PgTable);
    } catch {
      continue; // not a pgTable — a custom column type, a helper, anything else
    }

    const columns = new Map<string, { sqlType: string; notNull: boolean }>();
    for (const column of config.columns) {
      columns.set(column.name, { sqlType: normalizeSqlType(column.getSQLType()), notNull: column.notNull });
    }

    const composite = config.primaryKeys[0];
    const primaryKey = composite
      ? composite.columns.map((column) => column.name)
      : config.columns.filter((column) => column.primary).map((column) => column.name);

    tables.push({ name: config.name, columns, primaryKey });
  }
  return tables;
}

export function compareSchema(
  database: readonly IntrospectedTable[],
  defined: readonly DefinedTable[],
): SchemaCheckResult {
  const definedByName = new Map(defined.map((table) => [table.name, table]));
  const databaseByName = new Map(database.map((table) => [table.name, table]));

  const result: SchemaCheckResult = {
    undefinedTables: database.filter((table) => !definedByName.has(table.name)).map((table) => table.name),
    orphanedDefinitions: defined.filter((table) => !databaseByName.has(table.name)).map((table) => table.name),
    columnMismatches: [],
    columnPresenceMismatches: [],
    primaryKeyMismatches: [],
  };

  for (const table of database) {
    const definition = definedByName.get(table.name);
    if (!definition) {
      continue; // already reported as undefined; do not report every column too
    }

    const seen = new Set<string>();
    for (const column of table.columns) {
      seen.add(column.name);
      const definedColumn = definition.columns.get(column.name);
      if (!definedColumn) {
        result.columnPresenceMismatches.push(`${table.name}.${column.name}: in the database, not in the schema`);
        continue;
      }
      // Both sides, not just the database's. definedTables() already
      // normalises what it builds, but the invariant belongs in the
      // comparator: a future caller constructing a DefinedTable some other
      // way must not be able to reintroduce a false mismatch.
      const databaseType = normalizeSqlType(column.sqlType);
      const definedType = normalizeSqlType(definedColumn.sqlType);
      if (databaseType !== definedType) {
        result.columnMismatches.push(
          `${table.name}.${column.name}: database ${databaseType}, schema ${definedType}`,
        );
      }
      if (column.notNull !== definedColumn.notNull) {
        // Both readings are hoisted out of the template rather than written
        // as inline ternaries. ISO-13's cache-key scanner is a regex over
        // source text, and an interpolation-opening template carrying two
        // colons — one from the "table.column:" prefix, one from a ternary —
        // reads to it as an un-namespaced cache key. The gate is right to be
        // coarse there; this is the call site's problem to avoid.
        const inDatabase = column.notNull ? "NOT NULL" : "nullable";
        const inSchema = definedColumn.notNull ? "NOT NULL" : "nullable";
        result.columnMismatches.push(`${table.name}.${column.name}: database ${inDatabase}, schema ${inSchema}`);
      }
    }
    for (const name of definition.columns.keys()) {
      if (!seen.has(name)) {
        result.columnPresenceMismatches.push(`${table.name}.${name}: in the schema, not in the database`);
      }
    }

    // Order matters — a composite key's column order is the index's column
    // order, and getting it wrong changes which queries the index serves.
    if (table.primaryKey.join(",") !== definition.primaryKey.join(",")) {
      result.primaryKeyMismatches.push(
        `${table.name}: database [${table.primaryKey.join(", ")}], schema [${definition.primaryKey.join(", ")}]`,
      );
    }
  }

  return result;
}

export async function checkSchema(client: Client): Promise<SchemaCheckResult> {
  await migrateUp(client);
  return compareSchema(await introspectSchema(client), definedTables());
}

function report(label: string, entries: readonly string[]): void {
  if (entries.length === 0) {
    return;
  }
  console.error(`\n${label} (${entries.length}):`);
  for (const entry of entries) {
    console.error(`  - ${entry}`);
  }
}

async function main(): Promise<void> {
  const maintenanceUrl = requireDatabaseUrl();
  const shadowDbName = `nominara_schemacheck_${Date.now()}`;
  const maintenance = await connect(maintenanceUrl);
  try {
    await maintenance.query(`CREATE DATABASE ${shadowDbName}`);
  } finally {
    await maintenance.end();
  }

  const shadowUrl = new URL(maintenanceUrl);
  shadowUrl.pathname = `/${shadowDbName}`;
  const shadow = await connect(shadowUrl.toString());

  let result: SchemaCheckResult;
  try {
    result = await checkSchema(shadow);
  } finally {
    await shadow.end();
    const cleanup = await connect(maintenanceUrl);
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${shadowDbName}`);
    } finally {
      await cleanup.end();
    }
  }

  if (isClean(result)) {
    console.log(`db:schema-check passed: every table in the migrated database is described, and described correctly.`);
    return;
  }

  console.error("db:schema-check FAILED — the schema files and the migrated database disagree.");
  report("Tables in the database with no pgTable definition — run `pnpm db:schema-generate`", result.undefinedTables);
  report("pgTable definitions for tables the database does not have", result.orphanedDefinitions);
  report("Columns present on one side only", result.columnPresenceMismatches);
  report("Columns whose type or nullability differs", result.columnMismatches);
  report("Primary keys that differ", result.primaryKeyMismatches);
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

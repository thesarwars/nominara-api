import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect, requireDatabaseUrl } from "../client.js";
import { migrateUp } from "../migrate-runner.js";
import { introspectSchema, type IntrospectedColumn, type IntrospectedTable } from "./introspect.js";
import { SCHEMA_SUBSYSTEMS, SUBSYSTEM_BY_TABLE, type SchemaSubsystem } from "./subsystems.js";

// STORY-122 — `pnpm db:schema-generate`, modeled on src/db/rls/generate.ts.
//
// The direction of truth runs migrations → schema files and never back.
// Migrations are hand-authored SQL because drizzle-kit models no extensions,
// functions, triggers, roles, grants, RLS policies or partitions — which is
// migrations 0001, 0005, 0006 and 0007 in their entirety. The pgTable
// definitions DESCRIBE what those migrations produced, and describing 77
// tables by hand is 77 opportunities for a nullability or type error that
// compiles, reviews clean, and is wrong at runtime.
//
// So they are generated, like 0006_generated_rls_policies.up.sql and
// tenant-tables.generated.ts before them, from a freshly-migrated shadow
// database. `--check` is the CI half.

export const SCHEMA_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A table the database has and src/db/schema/subsystems.ts does not name. */
export class UnassignedTableError extends Error {
  constructor(tableNames: readonly string[]) {
    super(
      `src/db/schema/subsystems.ts assigns no subsystem to: ${tableNames.join(", ")}. ` +
        "Add each one to the subsystem whose meaning it belongs to — there is no default bucket, " +
        "because a table that lands in one is a table nobody decided about.",
    );
    this.name = "UnassignedTableError";
  }
}

/** Two columns in one table whose camelCase property names collide. */
export class PropertyNameCollisionError extends Error {
  constructor(table: string, property: string, columns: readonly string[]) {
    super(
      `table ${table}: columns [${columns.join(", ")}] all camel-case to "${property}". ` +
        "Rename the property explicitly in the generator rather than letting one silently shadow the other.",
    );
    this.name = "PropertyNameCollisionError";
  }
}

export function camelCase(columnName: string): string {
  return columnName.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

// ---- the type map ---------------------------------------------------------

/** `format_type` output → the Drizzle builder call, for types taking no parameter. */
const SCALAR_BUILDERS: Readonly<Record<string, string>> = {
  text: "text()",
  uuid: "uuid()",
  boolean: "boolean()",
  integer: "integer()",
  smallint: "smallint()",
  real: "real()",
  "double precision": "doublePrecision()",
  jsonb: "jsonb()",
  json: "json()",
  date: "date()",
  inet: "inet()",
  interval: "interval()",
  "timestamp with time zone": "timestamp({ withTimezone: true })",
  // Deliberately bigint, not number. These are counters and ledger totals;
  // `mode: "number"` silently loses precision past 2^53, and quietly wrong
  // arithmetic on a credit balance is the exact failure this codebase spends
  // its effort refusing to ship.
  bigint: 'bigint({ mode: "bigint" })',
  bytea: "bytea()",
  citext: "citext()",
};

/** Which module each builder is imported from. */
const CUSTOM_BUILDERS = new Set(["bytea", "citext"]);

interface RenderedColumn {
  readonly property: string;
  readonly line: string;
  readonly builders: readonly string[];
  readonly usesSql: boolean;
}

function builderFor(sqlType: string): { call: string; builder: string } {
  const scalar = SCALAR_BUILDERS[sqlType];
  if (scalar) {
    return { call: scalar, builder: scalar.slice(0, scalar.indexOf("(")) };
  }

  const numeric = /^numeric\((\d+),(\d+)\)$/.exec(sqlType);
  if (numeric) {
    return { call: `numeric({ precision: ${numeric[1]}, scale: ${numeric[2]} })`, builder: "numeric" };
  }
  if (sqlType === "numeric") {
    return { call: "numeric()", builder: "numeric" };
  }

  const char = /^character\((\d+)\)$/.exec(sqlType);
  if (char) {
    return { call: `char({ length: ${char[1]} })`, builder: "char" };
  }

  const varchar = /^character varying\((\d+)\)$/.exec(sqlType);
  if (varchar) {
    return { call: `varchar({ length: ${varchar[1]} })`, builder: "varchar" };
  }

  const halfvec = /^halfvec\((\d+)\)$/.exec(sqlType);
  if (halfvec) {
    return { call: `halfvec({ dimensions: ${halfvec[1]} })`, builder: "halfvec" };
  }

  const vector = /^vector\((\d+)\)$/.exec(sqlType);
  if (vector) {
    return { call: `vector({ dimensions: ${vector[1]} })`, builder: "vector" };
  }

  throw new Error(
    `src/db/schema/generate.ts has no Drizzle builder for the Postgres type "${sqlType}". ` +
      "Add it to SCALAR_BUILDERS or builderFor rather than approximating it with text — a schema " +
      "that lies about a column's type is worse than one that refuses to describe it.",
  );
}

function escapeSqlTemplate(expression: string): string {
  return expression.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

export function renderColumn(column: IntrospectedColumn, isSolePrimaryKey = false): RenderedColumn {
  const isArray = column.sqlType.endsWith("[]");
  const baseType = isArray ? column.sqlType.slice(0, -2) : column.sqlType;
  const { call, builder } = builderFor(baseType);

  let expression = `${call}`;
  if (isArray) {
    expression += ".array()";
  }
  if (isSolePrimaryKey) {
    // .primaryKey() already implies NOT NULL, so .notNull() alongside it is
    // noise. A COMPOSITE key is declared once in the table's extra config
    // instead — see renderTable.
    expression += ".primaryKey()";
  } else if (column.notNull) {
    expression += ".notNull()";
  }
  if (column.defaultExpr !== null) {
    expression += `.default(sql\`${escapeSqlTemplate(column.defaultExpr)}\`)`;
  }

  // The database name is always written out, even where it equals the
  // property name. A future rename that changes one and not the other then
  // fails to compile, rather than reading a column that no longer exists.
  return {
    property: camelCase(column.name),
    line: `  ${camelCase(column.name)}: ${withColumnName(expression, column.name)},`,
    builders: [builder],
    usesSql: column.defaultExpr !== null,
  };
}

/** Inserts the database column name as the builder's first argument. */
function withColumnName(expression: string, columnName: string): string {
  const open = expression.indexOf("(");
  const close = expression.indexOf(")", open);
  const existingArgs = expression.slice(open + 1, close).trim();
  const args = existingArgs.length > 0 ? `"${columnName}", ${existingArgs}` : `"${columnName}"`;
  return `${expression.slice(0, open)}(${args}${expression.slice(close)}`;
}

export function renderTable(table: IntrospectedTable): { code: string; builders: string[]; usesSql: boolean } {
  const solePrimaryKey = table.primaryKey.length === 1 ? table.primaryKey[0] : null;
  const rendered = table.columns.map((column) => renderColumn(column, column.name === solePrimaryKey));

  const byProperty = new Map<string, string[]>();
  for (const [index, column] of table.columns.entries()) {
    const property = rendered[index]!.property;
    byProperty.set(property, [...(byProperty.get(property) ?? []), column.name]);
  }
  for (const [property, columns] of byProperty) {
    if (columns.length > 1) {
      throw new PropertyNameCollisionError(table.name, property, columns);
    }
  }

  const builders = rendered.flatMap((column) => column.builders);
  const usesSql = rendered.some((column) => column.usesSql);
  const composite = table.primaryKey.length > 1;

  const lines: string[] = [];
  lines.push(`export const ${camelCase(table.name)} = pgTable("${table.name}", {`);
  lines.push(...rendered.map((column) => column.line));
  if (composite) {
    const columns = table.primaryKey.map((name) => `table.${camelCase(name)}`).join(", ");
    lines.push(`}, (table) => [primaryKey({ columns: [${columns}] })]);`);
  } else {
    lines.push("});");
  }

  return { code: lines.join("\n"), builders: composite ? [...builders, "primaryKey"] : builders, usesSql };
}

export function renderSubsystemModule(subsystem: SchemaSubsystem, tables: readonly IntrospectedTable[]): string {
  const rendered = tables.map(renderTable);
  const builders = new Set(rendered.flatMap((table) => table.builders));
  const usesSql = rendered.some((table) => table.usesSql);

  const coreImports = [...builders].filter((name) => !CUSTOM_BUILDERS.has(name)).sort();
  const customImports = [...builders].filter((name) => CUSTOM_BUILDERS.has(name)).sort();
  coreImports.push("pgTable");
  const uniqueCore = [...new Set(coreImports)].sort();

  const header = [
    `// STORY-122 — the \`${subsystem}\` subsystem's tables.`,
    "// GENERATED BY src/db/schema/generate.ts — DO NOT HAND-EDIT.",
    "// Regenerate with `pnpm db:schema-generate`; `pnpm db:schema-check` fails",
    "// when this file and the migrated database disagree.",
    "//",
    "// The migrations under src/db/migrations/ are the source of truth. These",
    "// definitions describe what they produced, so that a column renamed in a",
    "// migration breaks the build in every service that reads it.",
    "",
  ];

  const imports: string[] = [];
  if (usesSql) {
    imports.push('import { sql } from "drizzle-orm";');
  }
  imports.push(`import { ${uniqueCore.join(", ")} } from "drizzle-orm/pg-core";`);
  if (customImports.length > 0) {
    imports.push(`import { ${customImports.join(", ")} } from "./columns.js";`);
  }

  return (
    [header.join("\n"), imports.join("\n"), "", rendered.map((table) => table.code).join("\n\n")].join("\n") + "\n"
  );
}

export function renderIndexModule(): string {
  const subsystems = Object.keys(SCHEMA_SUBSYSTEMS).sort();
  return (
    [
      "// STORY-122 — every table definition, in one import.",
      "// GENERATED BY src/db/schema/generate.ts — DO NOT HAND-EDIT.",
      "//",
      "// drizzle.config.ts points at this file, and src/db/drizzle.service.ts",
      "// passes it to drizzle() as the schema, so a service imports tables from",
      "// here rather than reaching into a subsystem file by path.",
      "",
      ...subsystems.map((subsystem) => `export * from "./${subsystem}.js";`),
    ].join("\n") + "\n"
  );
}

// ---- generation -----------------------------------------------------------

export interface GeneratedSchema {
  /** file name (e.g. "identity.ts") → contents */
  readonly modules: ReadonlyMap<string, string>;
  readonly tableCount: number;
}

export function generateSchemaModules(tables: readonly IntrospectedTable[]): GeneratedSchema {
  const unassigned = tables.filter((table) => !SUBSYSTEM_BY_TABLE.has(table.name)).map((table) => table.name);
  if (unassigned.length > 0) {
    throw new UnassignedTableError(unassigned);
  }

  const modules = new Map<string, string>();
  for (const subsystem of Object.keys(SCHEMA_SUBSYSTEMS) as SchemaSubsystem[]) {
    const subsystemTables = tables.filter((table) => SUBSYSTEM_BY_TABLE.get(table.name) === subsystem);
    modules.set(`${subsystem}.ts`, renderSubsystemModule(subsystem, subsystemTables));
  }
  modules.set("index.ts", renderIndexModule());

  return { modules, tableCount: tables.length };
}

async function withShadowDatabase<T>(fn: (shadow: Awaited<ReturnType<typeof connect>>) => Promise<T>): Promise<T> {
  const maintenanceUrl = requireDatabaseUrl();
  const shadowDbName = `nominara_schemagen_${Date.now()}`;
  const maintenance = await connect(maintenanceUrl);
  try {
    await maintenance.query(`CREATE DATABASE ${shadowDbName}`);
  } finally {
    await maintenance.end();
  }

  const shadowUrl = new URL(maintenanceUrl);
  shadowUrl.pathname = `/${shadowDbName}`;
  const shadow = await connect(shadowUrl.toString());

  try {
    await migrateUp(shadow);
    return await fn(shadow);
  } finally {
    await shadow.end();
    const cleanup = await connect(maintenanceUrl);
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${shadowDbName}`);
    } finally {
      await cleanup.end();
    }
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const generated = await withShadowDatabase(async (shadow) => generateSchemaModules(await introspectSchema(shadow)));

  if (checkOnly) {
    const stale: string[] = [];
    for (const [fileName, contents] of generated.modules) {
      const onDisk = await readFile(path.join(SCHEMA_DIR, fileName), "utf8").catch(() => null);
      if (onDisk !== contents) {
        stale.push(fileName);
      }
    }
    if (stale.length > 0) {
      console.error(`db:schema-generate --check failed: ${stale.join(", ")} out of date with the generator.`);
      console.error("Run `pnpm db:schema-generate` and commit the result.");
      process.exit(1);
    }
    console.log(`db:schema-generate --check passed: ${generated.tableCount} tables, every module matches.`);
    return;
  }

  for (const [fileName, contents] of generated.modules) {
    const target = path.join(SCHEMA_DIR, fileName);
    await writeFile(target, contents, "utf8");
    console.log(`wrote ${target}`);
  }
  console.log(`${generated.tableCount} tables across ${Object.keys(SCHEMA_SUBSYSTEMS).length} subsystems`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

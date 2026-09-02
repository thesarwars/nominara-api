import { describe, expect, it } from "vitest";
import {
  PropertyNameCollisionError,
  UnassignedTableError,
  camelCase,
  generateSchemaModules,
  renderColumn,
  renderTable,
} from "../../src/db/schema/generate.js";
import type { IntrospectedColumn, IntrospectedTable } from "../../src/db/schema/introspect.js";
import { SCHEMA_SUBSYSTEMS, SUBSYSTEM_BY_TABLE } from "../../src/db/schema/subsystems.js";

// STORY-122 · src/db/schema/generate.ts. The generator's own behaviour,
// against synthetic introspection — the real 77-table output is asserted
// against a real database in
// test/integration/drizzle-schema-and-service.spec.ts.

function column(overrides: Partial<IntrospectedColumn> & { name: string; sqlType: string }): IntrospectedColumn {
  return { notNull: false, defaultExpr: null, ...overrides };
}

function table(name: string, columns: IntrospectedColumn[], primaryKey: string[] = []): IntrospectedTable {
  return { name, columns, primaryKey };
}

describe("STORY-122 · the subsystem assignment", () => {
  it("assigns every table exactly once — a table in two subsystems would be defined twice", () => {
    const assigned = Object.values(SCHEMA_SUBSYSTEMS).flat();
    expect(new Set(assigned).size, "a table name appears in more than one subsystem").toBe(assigned.length);
    expect(SUBSYSTEM_BY_TABLE.size).toBe(assigned.length);
  });

  // Scenario 5 — the generator refuses, rather than the check catching it
  // later. A default bucket would let a table nobody decided about ship in
  // whichever file sorted first.
  it("scenario 5 — a table with no subsystem fails the GENERATOR, naming it", () => {
    const tables = [table("projects", [column({ name: "id", sqlType: "uuid" })], ["id"]), table("brand_new_table", [])];
    expect(() => generateSchemaModules(tables)).toThrow(UnassignedTableError);
    expect(() => generateSchemaModules(tables)).toThrow(/brand_new_table/);
    expect(() => generateSchemaModules(tables)).toThrow(/no default bucket/);
  });
});

describe("STORY-122 · column rendering", () => {
  it("camel-cases the property and always writes the database name out", () => {
    expect(camelCase("last_strong_auth_at")).toBe("lastStrongAuthAt");
    expect(renderColumn(column({ name: "last_strong_auth_at", sqlType: "timestamp with time zone" })).line).toBe(
      '  lastStrongAuthAt: timestamp("last_strong_auth_at", { withTimezone: true }),',
    );
  });

  it.each([
    ["text", "text", '  a: text("a"),'],
    ["uuid", "uuid", '  a: uuid("a"),'],
    ["citext", "citext", '  a: citext("a"),'],
    ["bytea", "bytea", '  a: bytea("a"),'],
    ["numeric(6,3)", "numeric", '  a: numeric("a", { precision: 6, scale: 3 }),'],
    ["numeric", "numeric", '  a: numeric("a"),'],
    ["character(2)", "char", '  a: char("a", { length: 2 }),'],
    ["halfvec(1536)", "halfvec", '  a: halfvec("a", { dimensions: 1536 }),'],
    ["bigint", "bigint", '  a: bigint("a", { mode: "bigint" }),'],
    ["text[]", "text", '  a: text("a").array(),'],
    ["citext[]", "citext", '  a: citext("a").array(),'],
  ])("maps %s", (sqlType, builder, expected) => {
    const rendered = renderColumn(column({ name: "a", sqlType }));
    expect(rendered.line).toBe(expected);
    expect(rendered.builders).toContain(builder);
  });

  it("refuses an unmapped Postgres type rather than approximating it as text", () => {
    // A schema that lies about a column's type is worse than one that
    // refuses to describe it: the lie compiles.
    expect(() => renderColumn(column({ name: "a", sqlType: "tstzrange" }))).toThrow(/no Drizzle builder/);
    expect(() => renderColumn(column({ name: "a", sqlType: "tstzrange" }))).toThrow(/tstzrange/);
  });

  it("carries a default through verbatim, so the column is optional on insert exactly when the database says", () => {
    expect(renderColumn(column({ name: "created_at", sqlType: "timestamp with time zone", notNull: true, defaultExpr: "now()" })).line).toBe(
      '  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),',
    );
  });

  it("escapes a default expression that would otherwise break out of the template literal", () => {
    const rendered = renderColumn(column({ name: "a", sqlType: "text", defaultExpr: "'`${x}`'::text" }));
    expect(rendered.line).toContain("\\`");
    expect(rendered.line).toContain("\\${");
  });
});

describe("STORY-122 · table rendering", () => {
  it("marks a single-column primary key on the column, and omits the redundant notNull", () => {
    const code = renderTable(
      table("projects", [column({ name: "id", sqlType: "uuid", notNull: true, defaultExpr: "gen_random_uuid()" })], ["id"]),
    ).code;
    expect(code).toContain('id: uuid("id").primaryKey().default(sql`gen_random_uuid()`)');
    expect(code).not.toContain(".notNull().primaryKey()");
  });

  it("declares a composite primary key once, in the table's extra config, in constraint order", () => {
    const code = renderTable(
      table(
        "answer_captures",
        [
          column({ name: "id", sqlType: "uuid", notNull: true }),
          column({ name: "captured_at", sqlType: "timestamp with time zone", notNull: true }),
        ],
        ["captured_at", "id"],
      ),
    ).code;
    expect(code).toContain("primaryKey({ columns: [table.capturedAt, table.id] })");
    expect(code).not.toContain(".primaryKey()");
  });

  it("refuses two columns whose camel-case property names collide", () => {
    expect(() =>
      renderTable(table("t", [column({ name: "run_id", sqlType: "uuid" }), column({ name: "runId", sqlType: "uuid" })])),
    ).toThrow(PropertyNameCollisionError);
  });
});

import { describe, expect, it } from "vitest";
import { compareSchema, definedTables, isClean } from "../../src/db/schema/schema-check.js";
import type { IntrospectedTable } from "../../src/db/schema/introspect.js";
import { SUBSYSTEM_BY_TABLE } from "../../src/db/schema/subsystems.js";

// STORY-122 · src/db/schema/schema-check.ts. The point of this check is not
// that it fails — `pnpm db:schema-generate --check` already fails on any
// divergence — but that it says WHICH KIND, because the three ways a schema
// file and a database can disagree have three different remedies. These
// tests hold it to that.

function dbTable(name: string, columns: { name: string; sqlType: string; notNull: boolean }[], primaryKey: string[] = []): IntrospectedTable {
  return { name, columns: columns.map((column) => ({ ...column, defaultExpr: null })), primaryKey };
}

function defined(name: string, columns: [string, string, boolean][], primaryKey: string[] = []) {
  return { name, columns: new Map(columns.map(([n, t, nn]) => [n, { sqlType: t, notNull: nn }])), primaryKey };
}

describe("STORY-122 · compareSchema reports each kind of divergence separately", () => {
  it("scenario 2 — a table added to a migration without regenerating is named", () => {
    const result = compareSchema([dbTable("newly_added", [{ name: "id", sqlType: "uuid", notNull: true }], ["id"])], []);
    expect(result.undefinedTables).toEqual(["newly_added"]);
    expect(result.orphanedDefinitions).toEqual([]);
    // Not also reported as 77 missing columns — one cause, one message.
    expect(result.columnPresenceMismatches).toEqual([]);
  });

  it("scenario 3 — a definition for a table the database does not have is a DIFFERENT bucket", () => {
    const result = compareSchema([], [defined("dropped_table", [["id", "uuid", true]], ["id"])]);
    expect(result.orphanedDefinitions).toEqual(["dropped_table"]);
    expect(result.undefinedTables).toEqual([]);
  });

  it("scenario 4 — a column whose nullability changed is named, with both readings", () => {
    const result = compareSchema(
      [dbTable("projects", [{ name: "root_url", sqlType: "text", notNull: true }])],
      [defined("projects", [["root_url", "text", false]])],
    );
    expect(result.columnMismatches).toEqual(["projects.root_url: database NOT NULL, schema nullable"]);
  });

  it("a column whose type changed is named, with both readings", () => {
    const result = compareSchema(
      [dbTable("projects", [{ name: "priority_prompt_limit", sqlType: "bigint", notNull: true }])],
      [defined("projects", [["priority_prompt_limit", "integer", true]])],
    );
    expect(result.columnMismatches).toEqual([
      "projects.priority_prompt_limit: database bigint, schema integer",
    ]);
  });

  it("a column present on one side only is a presence problem, not a type problem", () => {
    const added = compareSchema(
      [dbTable("projects", [{ name: "id", sqlType: "uuid", notNull: true }, { name: "locale", sqlType: "text", notNull: true }])],
      [defined("projects", [["id", "uuid", true]])],
    );
    expect(added.columnPresenceMismatches).toEqual(["projects.locale: in the database, not in the schema"]);
    expect(added.columnMismatches).toEqual([]);

    const removed = compareSchema(
      [dbTable("projects", [{ name: "id", sqlType: "uuid", notNull: true }])],
      [defined("projects", [["id", "uuid", true], ["gone", "text", false]])],
    );
    expect(removed.columnPresenceMismatches).toEqual(["projects.gone: in the schema, not in the database"]);
  });

  it("a primary key in the wrong ORDER is a mismatch — the order is the index's order", () => {
    const result = compareSchema(
      [dbTable("answer_captures", [
        { name: "id", sqlType: "uuid", notNull: true },
        { name: "captured_at", sqlType: "timestamp with time zone", notNull: true },
      ], ["captured_at", "id"])],
      [defined("answer_captures", [["id", "uuid", true], ["captured_at", "timestamp with time zone", true]], ["id", "captured_at"])],
    );
    expect(result.primaryKeyMismatches).toEqual([
      "answer_captures: database [captured_at, id], schema [id, captured_at]",
    ]);
  });

  it.each([
    ["char(2)", "character(2)"],
    ["varchar(50)", "character varying(50)"],
    ["numeric(12, 2)", "numeric(12,2)"],
  ])("treats %s and %s as the same type — they are exact synonyms in Postgres", (drizzleSpelling, postgresSpelling) => {
    const result = compareSchema(
      [dbTable("t", [{ name: "c", sqlType: postgresSpelling, notNull: false }])],
      [defined("t", [["c", drizzleSpelling, false]])],
    );
    expect(result.columnMismatches).toEqual([]);
  });
});

describe("STORY-122 · the committed definitions, read through Drizzle's own metadata", () => {
  it("exports a pgTable for every table the subsystem map names, and no others", () => {
    const names = new Set(definedTables().map((table) => table.name));
    const expected = new Set(SUBSYSTEM_BY_TABLE.keys());
    expect([...names].filter((name) => !expected.has(name)), "a definition for a table no subsystem names").toEqual([]);
    expect([...expected].filter((name) => !names.has(name)), "a named table with no definition").toEqual([]);
  });

  it("finds no pgTable where there is none — the custom column types are not mistaken for tables", () => {
    expect(isClean(compareSchema([], []))).toBe(true);
  });
});

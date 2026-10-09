import { describe, expect, it } from "vitest";
import {
  CONTRACT_PHASE_ANNOTATION,
  assertNoMaterializedViews,
  findDestructiveSteps,
  findMaterializedViewSteps,
  hasContractPhaseAnnotation,
} from "../../src/db/additive-guard.js";

// STORY-006 · QA coverage audit: the additive-only guard's pattern-matching
// is pure and container-free — it does not need a real database to verify,
// and testing it only through slow integration tests is why the SET NOT NULL
// pattern shipped without any test at all alongside the ADD COLUMN one.
describe("STORY-006 · additive-guard pure logic", () => {
  describe("findDestructiveSteps", () => {
    it("detects DROP TABLE and extracts the table name", () => {
      const steps = findDestructiveSteps("DROP TABLE probe_destructive;");
      expect(steps).toEqual([{ statementKind: expect.stringContaining("DROP TABLE"), table: "probe_destructive" }]);
    });

    it("detects DROP TABLE IF EXISTS", () => {
      const steps = findDestructiveSteps("DROP TABLE IF EXISTS probe_destructive;");
      expect(steps.map((s) => s.table)).toEqual(["probe_destructive"]);
    });

    it("detects ALTER TABLE ... DROP COLUMN", () => {
      const steps = findDestructiveSteps("ALTER TABLE probe_destructive DROP COLUMN note;");
      expect(steps.map((s) => s.table)).toEqual(["probe_destructive"]);
    });

    it("detects TRUNCATE, with or without the TABLE keyword", () => {
      expect(findDestructiveSteps("TRUNCATE probe_destructive;").map((s) => s.table)).toEqual(["probe_destructive"]);
      expect(findDestructiveSteps("TRUNCATE TABLE probe_destructive;").map((s) => s.table)).toEqual([
        "probe_destructive",
      ]);
    });

    it("detects ALTER TABLE ... ALTER COLUMN ... SET NOT NULL", () => {
      const steps = findDestructiveSteps("ALTER TABLE probe_not_null ALTER COLUMN note SET NOT NULL;");
      expect(steps.map((s) => s.table)).toEqual(["probe_not_null"]);
    });

    it("detects ALTER TABLE ... ADD COLUMN ... NOT NULL with no DEFAULT (fails outright on a populated table)", () => {
      expect(
        findDestructiveSteps("ALTER TABLE probe_not_null ADD COLUMN note text NOT NULL;").map((s) => s.table),
      ).toEqual(["probe_not_null"]);
    });

    it("detects NOT NULL with no DEFAULT on a parameterised type such as numeric(12,2)", () => {
      expect(
        findDestructiveSteps("ALTER TABLE probe_not_null ADD COLUMN amount numeric(12,2) NOT NULL;").map((s) => s.table),
      ).toEqual(["probe_not_null"]);
    });

    describe("ADD COLUMN ... NOT NULL DEFAULT <constant> is metadata-only and accepted", () => {
      it.each([
        ["string, default before NOT NULL", "note text DEFAULT '' NOT NULL"],
        ["string, default after NOT NULL", "note text NOT NULL DEFAULT 'v1'"],
        ["boolean", "flag boolean NOT NULL DEFAULT false"],
        ["number", "n integer NOT NULL DEFAULT 0"],
        ["negative decimal", "n numeric(12,2) NOT NULL DEFAULT -1.50"],
        ["cast jsonb literal", "j jsonb NOT NULL DEFAULT '{}'::jsonb"],
        ["cast array literal", "a text[] NOT NULL DEFAULT '{}'::text[]"],
        ["string containing a comma", "note text NOT NULL DEFAULT 'a,b'"],
        ["now() (stable, evaluated once)", "at timestamptz NOT NULL DEFAULT now()"],
        ["current_timestamp", "at timestamptz NOT NULL DEFAULT current_timestamp"],
        ["with a trailing CHECK", "n integer NOT NULL DEFAULT 0 CHECK (n >= 0)"],
      ])("%s", (_label, column) => {
        expect(findDestructiveSteps(`ALTER TABLE probe_not_null ADD COLUMN ${column};`)).toEqual([]);
        expect(findDestructiveSteps(`ALTER TABLE probe_not_null ADD COLUMN IF NOT EXISTS ${column};`)).toEqual([]);
      });
    });

    describe("ADD COLUMN ... NOT NULL with a non-constant default is still flagged (volatile = table rewrite)", () => {
      it.each([
        ["random()", "r double precision NOT NULL DEFAULT random()"],
        ["gen_random_uuid()", "id uuid NOT NULL DEFAULT gen_random_uuid()"],
        ["clock_timestamp()", "at timestamptz NOT NULL DEFAULT clock_timestamp()"],
        ["nextval", "n bigint NOT NULL DEFAULT nextval('probe_seq')"],
        ["subexpression with a call", "n integer NOT NULL DEFAULT (1 + floor(random() * 3))"],
        ["a column reference-looking expression", "n integer NOT NULL DEFAULT other_col"],
        ["a user function", "n integer NOT NULL DEFAULT app.next_value()"],
      ])("%s", (_label, column) => {
        expect(findDestructiveSteps(`ALTER TABLE probe_not_null ADD COLUMN ${column};`).map((s) => s.table)).toEqual([
          "probe_not_null",
        ]);
      });
    });

    it("does not exempt a NOT NULL default on one column from a second NOT NULL-without-default column", () => {
      const steps = findDestructiveSteps(
        "ALTER TABLE probe_not_null ADD COLUMN a text NOT NULL DEFAULT 'x'; ALTER TABLE probe_other ADD COLUMN b text NOT NULL;",
      );
      expect(steps.map((s) => s.table)).toEqual(["probe_other"]);
    });

    it("does not flag a nullable ADD COLUMN", () => {
      expect(findDestructiveSteps("ALTER TABLE probe_not_null ADD COLUMN note text;")).toEqual([]);
    });

    it("does not flag NOT NULL inside a CREATE TABLE — only an ALTER on an existing table is destructive", () => {
      expect(findDestructiveSteps("CREATE TABLE probe_fresh (id integer PRIMARY KEY, note text NOT NULL);")).toEqual(
        [],
      );
    });

    it("does not run the ADD COLUMN pattern past a statement boundary onto an unrelated later NOT NULL", () => {
      const steps = findDestructiveSteps(
        "ALTER TABLE probe_not_null ADD COLUMN note text; CREATE TABLE probe_other (id integer NOT NULL);",
      );
      expect(steps).toEqual([]);
    });

    it("returns no steps for a purely additive migration", () => {
      expect(findDestructiveSteps("CREATE TABLE probe_fresh (id integer PRIMARY KEY);")).toEqual([]);
    });

    it("collects every destructive step when a migration mixes several", () => {
      const steps = findDestructiveSteps(`
        DROP TABLE old_probe;
        ALTER TABLE probe_destructive DROP COLUMN note;
        ALTER TABLE probe_not_null ALTER COLUMN x SET NOT NULL;
      `);
      expect(steps.map((s) => s.table).sort()).toEqual(["old_probe", "probe_destructive", "probe_not_null"].sort());
    });
  });

  describe("hasContractPhaseAnnotation", () => {
    it("is true when the annotation is on its own line", () => {
      expect(hasContractPhaseAnnotation(`${CONTRACT_PHASE_ANNOTATION}\nDROP TABLE probe;`)).toBe(true);
    });

    it("tolerates surrounding whitespace on the annotation line", () => {
      expect(hasContractPhaseAnnotation(`   ${CONTRACT_PHASE_ANNOTATION}   \nDROP TABLE probe;`)).toBe(true);
    });

    it("is false when the annotation is absent", () => {
      expect(hasContractPhaseAnnotation("DROP TABLE probe;")).toBe(false);
    });

    it("is false when the annotation text appears trailing on a statement line rather than its own line", () => {
      expect(hasContractPhaseAnnotation(`DROP TABLE probe; ${CONTRACT_PHASE_ANNOTATION}`)).toBe(false);
    });
  });

  describe("normalizeIdentifier (via findDestructiveSteps)", () => {
    it("accepts a schema-qualified identifier", () => {
      expect(findDestructiveSteps("DROP TABLE app.probe;").map((s) => s.table)).toEqual(["app.probe"]);
    });

    it("strips surrounding double quotes from an otherwise-safe identifier", () => {
      expect(findDestructiveSteps('DROP TABLE "probe_destructive";').map((s) => s.table)).toEqual([
        "probe_destructive",
      ]);
    });

    it("throws rather than silently mis-targeting on an unsafe identifier", () => {
      // A stray semicolon inside the captured identifier text — the regex
      // itself won't produce this from well-formed SQL, but normalizeIdentifier
      // must not trust its input blindly either way.
      expect(() => findDestructiveSteps("DROP TABLE probe$destructive;")).not.toThrow();
      // A genuinely unsafe shape: multiple dots, which SAFE_IDENTIFIER rejects.
      expect(() => findDestructiveSteps("DROP TABLE a.b.c;")).toThrow(/cannot safely parse table identifier/);
    });
  });
});

// STORY-009 · the materialized-view lint rule: pure, regex-based,
// unconditional — no `-- @contract-phase` annotation exempts it, because a
// matview bypassing RLS on its base tables is a security property (ISO-16),
// not a destructiveness judgement call. (Not one of this story's numbered
// known-gap/defect list, E-1..E-6 — those are documented in STORY-009's
// Technical Notes; this rule is a design decision, not a gap.)
describe("STORY-009 · materialized-view guard", () => {
  describe("findMaterializedViewSteps", () => {
    it("detects a plain CREATE MATERIALIZED VIEW", () => {
      expect(findMaterializedViewSteps("CREATE MATERIALIZED VIEW foo AS SELECT 1;")).toEqual([
        "CREATE MATERIALIZED VIEW",
      ]);
    });

    it("is case-insensitive", () => {
      expect(findMaterializedViewSteps("create materialized view foo as select 1;")).toEqual([
        "create materialized view",
      ]);
    });

    it("tolerates newlines and irregular whitespace between the three words", () => {
      expect(
        findMaterializedViewSteps("CREATE\n  MATERIALIZED\t\nVIEW foo AS SELECT 1;"),
      ).toHaveLength(1);
    });

    it("detects CREATE MATERIALIZED VIEW IF NOT EXISTS", () => {
      expect(findMaterializedViewSteps("CREATE MATERIALIZED VIEW IF NOT EXISTS foo AS SELECT 1;")).toHaveLength(1);
    });

    it("collects every match when a migration creates several matviews", () => {
      const sql = `
        CREATE MATERIALIZED VIEW foo AS SELECT 1;
        CREATE MATERIALIZED VIEW bar AS SELECT 2;
      `;
      expect(findMaterializedViewSteps(sql)).toHaveLength(2);
    });

    it("does NOT flag a plain CREATE VIEW", () => {
      expect(findMaterializedViewSteps("CREATE VIEW foo AS SELECT 1;")).toEqual([]);
    });

    it("does NOT flag prose that merely mentions materialized views without the literal contiguous sequence", () => {
      expect(
        findMaterializedViewSteps(
          "-- no materialized view is created here; every pre-aggregation is an ordinary table",
        ),
      ).toEqual([]);
    });

    it("returns no steps for an ordinary additive migration", () => {
      expect(findMaterializedViewSteps("CREATE TABLE foo (id uuid PRIMARY KEY);")).toEqual([]);
    });
  });

  describe("assertNoMaterializedViews", () => {
    it("throws when a materialized view is present", () => {
      expect(() => assertNoMaterializedViews("CREATE MATERIALIZED VIEW foo AS SELECT 1;")).toThrow(
        /materialized view/i,
      );
    });

    it("does not throw for a plain CREATE VIEW or an ordinary CREATE TABLE", () => {
      expect(() => assertNoMaterializedViews("CREATE VIEW foo AS SELECT 1;")).not.toThrow();
      expect(() => assertNoMaterializedViews("CREATE TABLE foo (id uuid PRIMARY KEY);")).not.toThrow();
    });

    it("throws even when the file carries the contract-phase annotation — this rule is unconditional", () => {
      expect(() =>
        assertNoMaterializedViews(`${CONTRACT_PHASE_ANNOTATION}\nCREATE MATERIALIZED VIEW foo AS SELECT 1;`),
      ).toThrow(/materialized view/i);
    });
  });
});

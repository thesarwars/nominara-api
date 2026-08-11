import { describe, expect, it } from "vitest";
import {
  CONTRACT_PHASE_ANNOTATION,
  findDestructiveSteps,
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

    it("detects ALTER TABLE ... ADD COLUMN ... NOT NULL, with or without a DEFAULT", () => {
      expect(
        findDestructiveSteps("ALTER TABLE probe_not_null ADD COLUMN note text NOT NULL DEFAULT '';").map(
          (s) => s.table,
        ),
      ).toEqual(["probe_not_null"]);
      expect(
        findDestructiveSteps("ALTER TABLE probe_not_null ADD COLUMN note text DEFAULT '' NOT NULL;").map(
          (s) => s.table,
        ),
      ).toEqual(["probe_not_null"]);
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

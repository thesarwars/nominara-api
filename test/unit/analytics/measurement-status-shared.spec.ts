import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answeredStatusSql, measurementStatusSql } from "../../../src/lib/rollup/aggregate-day.js";

// ⚠ NAMED RULES ABOUT `answer_captures.status`, AND NO HAND-WRITTEN COPIES.
//
// STORY-152 shipped a divergence of exactly this kind and had to back it out:
// `scorecards.service.ts` spelled a window boundary differently from
// `aggregate-day.ts`, and an engine measured today dropped out of the header's
// blend while the stored chart row counted it.
//
// A review then found the same defect one predicate over — the STATUS test was
// a deny-list in the rollup and an allow-list in the membership. Equal over
// today's five statuses, divergent the moment a sixth is added, and invisible
// to every integration test until then. Which is why this guard is structural.
//
// ⚠ AND THEN THE FIRST VERSION OF THIS GUARD MISSED A COPY THAT ALREADY
// EXISTED. It scanned two named files for `c.status IN (…)` — an allow-list of
// one alias spelling across an allow-list of two files — and
// `aggregate-day.ts`'s `datesWithFacts` says `status NOT IN (…)`, unaliased,
// 185 lines below the declaration in a file the scan already read. A guard
// built to stop copies reported clean on one.
//
// So: the pattern is alias-agnostic, and the file list is DERIVED — every file
// under src/ that mentions `answer_captures` — rather than named.
describe("STORY-152 · answer_captures.status has named rules and no hand-written copies", () => {
  const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.ts$/.test(full)) out.push(full);
    }
    return out;
  }

  /**
   * Every file that reads the table. DERIVED, not listed — a named list is the
   * shape that failed here, and `matrix.service.ts` was outside it while
   * carrying a third spelling of the freshness rule.
   */
  const readers = walk(SRC).filter((file) => readFileSync(file, "utf8").includes("answer_captures"));

  /** Alias-agnostic: `c.status`, `ac.status` and a bare `status` all match. */
  const STATUS_PREDICATE = /(?:\b[a-z_]+\.)?status\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/giu;

  /** The declaration sites, anchored on the string LITERAL rather than to the next `;`. */
  const DECLARATIONS = /return `\$\{statusColumn\}[^`]*`;/gu;

  /**
   * `answer_captures`'s status domain, READ FROM THE MIGRATION THAT DEFINES IT.
   *
   * ⚠ THIS IS WHAT DISTINGUISHES A COPY FROM A DIFFERENT TABLE, and it is a
   * property rather than a list of exceptions. `capture_runs.status` is also
   * called `status` and also appears in `IN (...)` predicates — the first
   * widened scan flagged `status IN ('queued','running')`, which is a
   * different table with a different domain and must not be unified with
   * anything here. A predicate is only OURS if every value it names is an
   * answer_captures status.
   *
   * ⚠ AND IT IS PARSED RATHER THAN TYPED OUT, BECAUSE A HARDCODED COPY WOULD
   * HAVE BEEN THE FIFTH INSTANCE OF THIS STORY'S OWN RECURRING MISTAKE.
   *
   * Four review rounds went on allow-lists that were one entry short. Written
   * as a literal, this one fails in the worst possible direction: add a sixth
   * status and a hand-written `status IN ('refused','failed')` names a value
   * the list does not know, `every()` returns false, the predicate is skipped
   * as "some other table's" — and the guard silently stops covering the exact
   * case it exists for, on the exact day it is needed. Reading the CHECK
   * constraint means a sixth status extends the discriminator by itself.
   */
  const CAPTURE_STATUSES = (() => {
    const migration = readFileSync(
      fileURLToPath(new URL("../../../src/db/migrations/sql/0003_projects_prompts_captures.up.sql", import.meta.url)),
      "utf8",
    );
    // Anchored on the table, because this file defines several `status IN (…)`
    // constraints and the first one belongs to `engines`.
    const table = migration.slice(migration.indexOf("CREATE TABLE answer_captures"));
    const check = /CHECK\s*\(status IN \(([^)]*)\)\)/u.exec(table);
    if (check === null) {
      throw new Error("could not find answer_captures' status CHECK — the discriminator would silently match nothing");
    }
    return [...check[1]!.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
  })();

  function isAnswerCapturesPredicate(values: string): boolean {
    const named = [...values.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
    return named.length > 0 && named.every((value) => CAPTURE_STATUSES.includes(value));
  }

  it("the two rules are what they claim to be, and are opposites on purpose", () => {
    // Pinned by value as well as by sharing: "both readers agree" is also true
    // when both are wrong.
    expect(measurementStatusSql()).toBe("c.status NOT IN ('failed', 'blocked')");
    expect(answeredStatusSql()).toBe("c.status IN ('captured', 'parsed', 'skipped')");
    // The alias is a parameter because one reader queries the table unaliased.
    expect(measurementStatusSql("status")).toBe("status NOT IN ('failed', 'blocked')");

    // A DENY-list for measurement, so a status added later still counts as
    // data; an ALLOW-list for answeredness, so an unknown status does not
    // silently become a "last answered at" and make a stale engine look fresh.
    // Opposite biases, each toward the less harmful mistake.
    expect(measurementStatusSql()).toContain("NOT IN");
    expect(answeredStatusSql()).not.toContain("NOT IN");
  });

  it("the status domain is parsed from the migration, not typed out here", () => {
    // If this ever reads empty or wrong, `isAnswerCapturesPredicate` returns
    // false for everything and the whole scan goes quietly vacuous.
    expect(CAPTURE_STATUSES).toEqual(expect.arrayContaining(["captured", "parsed", "skipped", "failed", "blocked"]));
    expect(CAPTURE_STATUSES.length, "five today — a sixth should EXTEND this, not break it").toBeGreaterThanOrEqual(5);
    // And it must not have picked up a neighbouring table's domain.
    expect(CAPTURE_STATUSES).not.toContain("queued");
    expect(CAPTURE_STATUSES).not.toContain("active");
  });

  it("finds the readers it claims to scan — an empty scan would pass forever", () => {
    expect(readers.length, "no file mentions answer_captures — the walk is broken").toBeGreaterThanOrEqual(3);
    for (const named of [
      path.join(SRC, "lib", "rollup", "aggregate-day.ts"),
      path.join(SRC, "modules", "analytics", "scorecards.service.ts"),
      path.join(SRC, "modules", "tracking", "matrix.service.ts"),
    ]) {
      expect(readers, `${path.relative(SRC, named)} must be in scope — each was a gap`).toContain(named);
    }
  });

  it("⚠ no file hand-writes a status predicate — every one interpolates a named rule", () => {
    const offenders: string[] = [];
    for (const file of readers) {
      // Strip the declarations before scanning, or the definition site reports
      // itself. Anchored on the template literal, NOT on `[^;]*` to the next
      // semicolon: there is no `semi` rule in eslint.config.js, so a
      // declaration reformatted without its trailing semicolon would let a
      // greedy stripper run forward and silently swallow a hand-written copy
      // placed just below — which is exactly where one would go.
      const source = readFileSync(file, "utf8").replace(DECLARATIONS, "");
      for (const match of source.matchAll(STATUS_PREDICATE)) {
        if (!isAnswerCapturesPredicate(match[1] ?? "")) continue;
        offenders.push(`${path.relative(SRC, file)}: ${match[0]}`);
      }
    }
    expect(
      offenders,
      "interpolate one of the named *StatusSql rules instead — a fourth spelling is how the last divergence arrived",
    ).toEqual([]);
  });

  it("⚠ the stripper removes the declarations and nothing else", () => {
    // The stripper is itself a place to hide a bug: one that matched too much
    // would hide real copies, and one that matched nothing would flag the
    // declarations forever. Both directions asserted.
    const aggregate = readFileSync(path.join(SRC, "lib", "rollup", "aggregate-day.ts"), "utf8");
    const stripped = aggregate.replace(DECLARATIONS, "");

    // ⚠ TIED TO THE DECLARATIONS THEMSELVES, NOT TO A BYTE BUDGET. The first
    // version asserted `removed < 200`, which was calibrated for two rules and
    // failed the moment there were four — a number that has to be re-tuned
    // every time the file grows is a number nobody will re-tune correctly.
    const matches = [...aggregate.matchAll(DECLARATIONS)];
    const exported = [...aggregate.matchAll(/export function \w*StatusSql\(/gu)];
    expect(matches.length, "the stripper must match every rule's return statement").toBe(exported.length);
    expect(exported.length, "and there must be rules to match").toBeGreaterThanOrEqual(2);

    // Each match is a single return statement, so none of them can be running
    // forward into surrounding code.
    for (const match of matches) {
      expect(match[0].length, `a declaration match ran too far: ${match[0].slice(0, 60)}`).toBeLessThan(90);
      expect(match[0]).not.toContain("\n");
    }

    // The surrounding code survives.
    expect(stripped).toContain("export function measurementStatusSql");
    expect(stripped).toContain("export async function aggregateRange");
  });

  it("⚠ and the scan catches a copy the previous version missed", () => {
    // The regression case, as a direct assertion on the pattern rather than a
    // file: the unaliased spelling at `datesWithFacts` escaped a `c.`-prefixed
    // scan. If the pattern ever requires an alias again, this fails.
    for (const spelling of [
      "status NOT IN ('failed', 'blocked')",
      "c.status IN ('captured', 'parsed', 'skipped')",
      "ac.status NOT IN ('failed')",
    ]) {
      const match = new RegExp(STATUS_PREDICATE.source, "iu").exec(spelling);
      expect(match, `this spelling escapes the scan: ${spelling}`).not.toBeNull();
      expect(isAnswerCapturesPredicate(match![1]!), `and must be recognised as ours: ${spelling}`).toBe(true);
    }

    // And the discriminator must EXCLUDE another table's status column, or
    // the scan would demand that `capture_runs` share a rule with
    // `answer_captures`.
    const other = new RegExp(STATUS_PREDICATE.source, "iu").exec("status IN ('queued','running')");
    expect(other, "the pattern still matches it textually").not.toBeNull();
    expect(
      isAnswerCapturesPredicate(other![1]!),
      "capture_runs.status is a different domain and must not be flagged",
    ).toBe(false);
  });
});

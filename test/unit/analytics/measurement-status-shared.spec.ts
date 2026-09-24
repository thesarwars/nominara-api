import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as statusRules from "../../../src/lib/rollup/aggregate-day.js";

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

  /**
   * Alias-agnostic AND operator-agnostic.
   *
   * ⚠ THE OPERATOR LIST WAS ONE SHORT, WHICH IS THIS STORY'S SIGNATURE ERROR
   * IN ITS SIXTH DIMENSION. The first version matched only `IN` / `NOT IN`,
   * and `l2-semantic-reuse.ts` says `ac.status = 'parsed'` — a live predicate
   * on this column, in a file this scan already read, returning no match. The
   * title claimed "no file hand-writes a status predicate" while one did.
   *
   * Round four's miss escaped on the alias prefix; this escaped on the
   * operator. Both are enumerations of a form that has more members than the
   * author happened to think of, which is why the VALUE test below does the
   * real discrimination — the pattern is deliberately greedy and the domain
   * check decides what is ours.
   */
  const STATUS_PREDICATE =
    /(?:\b[a-z_]+\.)?\bstatus\s*(?:(?:NOT\s+)?IN\s*\(([^)]*)\)|(?:=|<>|!=)\s*('[a-z_]+'))/giu;

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
    // ⚠ BOUNDED AT THE NEXT `CREATE TABLE`, NOT RUN TO END OF FILE. Anchored
    // on the table because this file defines five `status IN (…)` constraints
    // — engines, projects, tracked_prompts, capture_runs, answer_captures —
    // and an unbounded slice searches every table BELOW the anchor too. That
    // is safe today only because answer_captures happens to be last; a
    // reformatting plus one new table would have silently inherited a
    // neighbour's vocabulary instead of throwing. Bounded, a reformatting
    // throws in every case rather than in the cases that happen to be safe.
    const start = migration.indexOf("CREATE TABLE answer_captures");
    if (start === -1) throw new Error("answer_captures' CREATE TABLE not found — the domain would be empty");
    const next = migration.indexOf("\nCREATE TABLE", start + 1);
    const table = migration.slice(start, next === -1 ? undefined : next);
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

  /**
   * Prose is not code.
   *
   * ⚠ WIDENING THE OPERATOR TO `=` MADE THIS NECESSARY, AND THE FIRST RUN
   * PROVED IT: six sites flagged, FOUR of them comments — including this
   * story's own docblock explaining the widening. A scanner that reads
   * comments reports a discussion of a predicate as a copy of one, and this
   * repo has been bitten by that before (ISO-13's cache-namespacing scanner
   * failed on an interpolated string inside a comment).
   *
   * Stripping is safe in the direction that matters: a copy hidden in a
   * comment is not executed, so a false NEGATIVE here costs nothing. The
   * `--` rule is deliberately anchored to the start of a trimmed line, which
   * is how every SQL comment in this codebase is written, so it cannot eat a
   * `--` appearing mid-expression.
   */
  function stripProse(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "")
      .replace(/^\s*--.*$/gmu, "");
  }

  /**
   * An assignment is not a predicate — recognised NARROWLY, so that anything
   * unfamiliar is flagged rather than skipped.
   *
   * `UPDATE answer_captures SET status = 'parsed'` WRITES a status; it asks
   * nothing, and there is nothing for a named rule to say about it.
   *
   * ⚠ THE FIRST VERSION SEARCHED BACKWARDS FOR THE NEAREST OF
   * (SET|WHERE|AND|OR|ON|HAVING) AND CALLED IT AN ASSIGNMENT IF IT FOUND
   * `SET`. That is an ENUMERATION OF PREDICATE INTRODUCERS — the exact shape
   * five review rounds punished — and it was one member short. A review
   * demonstrated it with ordinary SQL:
   *
   *   UPDATE t SET flag = CASE WHEN status = 'parsed' THEN 1 ELSE 0 END
   *
   * `status = 'parsed'` there is a genuine predicate, the nearest listed
   * keyword is `SET`, and the scan skipped it SILENTLY — the direction I had
   * argued was safe and was not.
   *
   * Adding `WHEN` would have closed those two cases and left the shape. So
   * this asks the narrow POSITIVE question instead: is the column sitting
   * directly in a SET list, i.e. immediately after `SET` or after a comma
   * continuing one? Everything else — `CASE WHEN`, `HAVING`, `FILTER
   * (WHERE …)`, a subquery, or any construct nobody has thought of — falls
   * through to "not an assignment" and gets FLAGGED.
   *
   * That inverts the failure: an unrecognised context now costs a false
   * positive somebody has to look at, instead of a real copy nobody sees.
   */
  function isAssignment(source: string, index: number): boolean {
    return /(?:\bSET\b|,)\s*$/iu.test(source.slice(Math.max(0, index - 80), index));
  }

  /**
   * Every rule the module exports, DERIVED.
   *
   * ⚠ THE FILE LIST WAS DERIVED AND THE RULE LIST WAS NOT, WHICH IS THE SAME
   * ERROR THIS SPEC EXISTS TO CATCH. The first version imported two of four
   * rules by name and pinned those two. `capturedInRunStatusSql` — the one
   * carrying the subtle judgement, that `skipped` is EXCLUDED because
   * `capture_runs.skipped_cells` already counts those cells — had no
   * assertion anywhere. Adding `'skipped'` to it would double-count every
   * cache-suppressed cell in the progress bar and no test would fail.
   */
  const RULES = Object.keys(statusRules)
    .filter((name) => /StatusSql$/u.test(name))
    .sort();

  /** What each rule must be. A rule missing from here fails the test below. */
  const EXPECTED = {
    measurementStatusSql: "c.status NOT IN ('failed', 'blocked')",
    nonMeasurementStatusSql: "c.status IN ('failed', 'blocked')",
    answeredStatusSql: "c.status IN ('captured', 'parsed', 'skipped')",
    capturedInRunStatusSql: "c.status IN ('captured', 'parsed')",
    hasFactsStatusSql: "c.status = 'parsed'",
  };

  it("⚠ every exported rule is pinned by value — a new one cannot arrive unpinned", () => {
    expect(RULES.length, "the module exports no *StatusSql rules — the derivation is broken").toBeGreaterThanOrEqual(5);

    // The derivation is the point: a sixth rule added to the module with no
    // entry in EXPECTED fails HERE rather than shipping unasserted.
    expect(RULES, "a rule exists that nothing pins — add it to EXPECTED with its reason").toEqual(
      Object.keys(EXPECTED).sort(),
    );

    const rules = statusRules as unknown as Record<string, (column?: string) => string>;
    const expected = EXPECTED as Record<string, string>;
    for (const name of RULES) {
      expect(rules[name]!(), `${name} changed value`).toBe(expected[name]);
      // The alias is a parameter on every one of them, because readers query
      // the table both aliased and bare.
      expect(rules[name]!("x.status"), `${name} must honour its statusColumn argument`).toBe(
        expected[name]!.replace("c.status", "x.status"),
      );
    }
  });

  it("the rules' SHAPES are deliberate, and opposite where they need to be", () => {
    // A DENY-list for measurement, so a status added later still counts as
    // data; an ALLOW-list for answeredness, so an unknown status does not
    // silently become a "last answered at" and make a stale engine look fresh.
    // Opposite biases, each toward the less harmful mistake.
    expect(statusRules.measurementStatusSql()).toContain("NOT IN");
    expect(statusRules.answeredStatusSql()).not.toContain("NOT IN");

    // The complement is exactly that — same values, inverted operator — so
    // the two cannot drift apart on a sixth status.
    expect(statusRules.nonMeasurementStatusSql()).toBe(
      statusRules.measurementStatusSql().replace(" NOT IN ", " IN "),
    );

    // ⚠ `skipped` IS ABSENT FROM THE RUN-PROGRESS RULE AND PRESENT IN THE
    // FRESHNESS ONE. That difference is the whole reason they are two rules:
    // a suppressed cell HAS an answer, but `capture_runs.skipped_cells`
    // already counts it, so counting it again would double it in the bar.
    expect(statusRules.answeredStatusSql()).toContain("'skipped'");
    expect(statusRules.capturedInRunStatusSql()).not.toContain("'skipped'");

    // And the fifth rule is an EQUALITY, not a list — only `parsed` has facts
    // to reuse, and a sixth status would not join it.
    expect(statusRules.hasFactsStatusSql()).toContain("=");
    expect(statusRules.hasFactsStatusSql()).not.toContain("IN");
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
      const source = stripProse(readFileSync(file, "utf8")).replace(DECLARATIONS, "");
      for (const match of source.matchAll(STATUS_PREDICATE)) {
        // Group 1 is an IN list, group 2 a single quoted value from an
        // equality. Exactly one is set.
        if (!isAnswerCapturesPredicate(match[1] ?? match[2] ?? "")) continue;
        if (isAssignment(source, match.index)) continue;
        offenders.push(`${path.relative(SRC, file)}: ${match[0]}`);
      }
    }
    expect(
      offenders,
      "interpolate one of the named *StatusSql rules instead — a fourth spelling is how the last divergence arrived",
    ).toEqual([]);
  });

  it("⚠ the two discriminators cut where they claim to, in both directions", () => {
    // ⚠ THESE EXIST BECAUSE WIDENING THE OPERATOR TO `=` FLAGGED SIX SITES
    // AND ALL SIX WERE FALSE POSITIVES — four comments (one of them this
    // story's own docblock about the widening) and two `SET` assignments.
    // A reviewer had predicted "exactly one new flag, and it is the real
    // one"; the real one had already been converted, and the six were noise.
    // A guard that cries wolf six times gets its assertion deleted.

    // PROSE: a predicate written in a comment is not a copy...
    expect(stripProse("// see `c.status IN ('failed')` for why\nconst x = 1;")).not.toContain("c.status");
    expect(stripProse("  -- AND c.status IN ('failed')\n  AND id = $1")).not.toContain("c.status");
    expect(stripProse("/* c.status IN ('failed') */\nconst y = 2;")).not.toContain("c.status");
    // ...but real code is untouched, including a `--` that is not a comment.
    expect(stripProse("AND c.status IN ('failed')")).toContain("c.status");
    expect(stripProse("const n = a -- b;"), "a mid-line -- is not a SQL comment here").toContain("a -- b");

    // ASSIGNMENT: a write is not a question.
    const write = "UPDATE answer_captures SET status = 'parsed' WHERE id = $1";
    const read = "SELECT 1 FROM answer_captures WHERE id = $1 AND status = 'parsed'";
    expect(isAssignment(write, write.indexOf("status = 'parsed'"))).toBe(true);
    expect(isAssignment(read, read.indexOf("status = 'parsed'"))).toBe(false);
    // A multi-column SET still reads as assignment at the second column...
    const multi = "UPDATE t SET normalizer_version = $2, status = 'parsed' WHERE id = $1";
    expect(isAssignment(multi, multi.indexOf("status = 'parsed'"))).toBe(true);
    // ...and a predicate after a SET-bearing statement does not.
    const both = "UPDATE t SET a = 1 WHERE id = $1 AND status = 'parsed'";
    expect(isAssignment(both, both.indexOf("status = 'parsed'"))).toBe(false);

    // ⚠ THE REGRESSION CASES. The first version searched backwards for the
    // nearest of (SET|WHERE|AND|OR|ON|HAVING); in all four of these the
    // nearest listed keyword is `SET` while the column is a genuine
    // PREDICATE, so it skipped them silently. A reviewer found the first two
    // with ordinary SQL. They must all read as NOT-an-assignment.
    for (const sql of [
      "UPDATE answer_captures SET flag = CASE WHEN status = 'parsed' THEN 1 ELSE 0 END",
      "UPDATE t SET a = 1, b = CASE WHEN c.status = 'parsed' THEN 2 END",
      "UPDATE t SET a = (SELECT 1 FROM x GROUP BY y HAVING ac2.status = 'parsed')",
      "UPDATE t SET a = (SELECT count(*) FILTER (WHERE status = 'parsed') FROM x)",
    ]) {
      const at = sql.indexOf("status = 'parsed'");
      expect(isAssignment(sql, at), `a predicate inside a SET clause must still be flagged: ${sql}`).toBe(false);
    }

    // And the inversion's own property: an UNRECOGNISED context falls through
    // to "not an assignment", so a construct nobody anticipated costs noise
    // rather than silence. This is the whole reason the test is a narrow
    // positive rather than a keyword list.
    const invented = "UPDATE t SET a = SOMETHING_NOBODY_HAS_WRITTEN_YET status = 'parsed'";
    expect(isAssignment(invented, invented.indexOf("status = 'parsed'"))).toBe(false);

    // A column whose NAME merely ends in `status` is not this column.
    expect("x_status = 'parsed'".match(STATUS_PREDICATE), "x_status must not match").toBeNull();
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

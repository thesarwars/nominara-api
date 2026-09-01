import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// STORY-069 AC10 — "No limit, price, or credit cost is hardcoded anywhere — in
// application code, interface markup, or marketing markup. Asserted by a
// grep-style check over the known values."
//
// plans-and-entitlements.md's opening paragraph is the rule: "`plans
// .entitlements` (jsonb) is the **single machine-readable source of truth**.
// Every table in this document is its documentation, not a second source."
//
// WHY THIS IS WORTH THE EFFORT, in the story's own words: "the alternative
// failure is silent: a limit hardcoded in a component keeps working, and
// diverges from the billing system only when someone changes a plan." Nothing
// breaks on the day the constant is written. It breaks on the day somebody
// edits a plan and one number in one file does not move with it, and by then
// nobody is looking here.
//
// SCOPE: this repository only — `src/` and `contracts/`. AC10 also names
// "interface markup" and "marketing markup", which live in nominara-app and
// nominara-web and are another developer's. The same check belongs there,
// against the same value list, and the list is exported below so it can be one
// import rather than a second transcription of the matrix.

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The values a hardcoded copy would be, chosen for being IMPLAUSIBLE AS
 * COINCIDENCE.
 *
 * Deliberately not every figure in the matrix. `30`, `40`, `100` and `250` are
 * ordinary numbers that appear legitimately in timeouts, batch sizes and page
 * limits, and a check that flagged them would be turned off within a week —
 * which is worse than no check, because the file would still be here implying
 * one runs. What is listed is what nothing else in this codebase has a reason
 * to say: the six price figures, the starter credit allowance, the two large
 * fair-use ceilings, the long retention windows, and the three SLA figures.
 */
export const PLAN_VALUES_THAT_MUST_NOT_BE_HARDCODED: readonly string[] = [
  // price.monthly_usd / price.annual_usd
  "49",
  "129",
  "349",
  "490",
  "1290",
  "3490",
  // credits.included_per_cycle. `1200` and `3000` are NOT here, and the reason
  // is the rule above rather than an exception to it: this codebase already
  // says both for unrelated reasons — a 1200 ms fixture latency, and port 3000
  // in every browser-origin fixture — so listing them would produce twenty-one
  // standing false positives and the check would be deleted rather than
  // maintained. The consequence is stated rather than hidden: growth's and
  // business's credit allowances are the two matrix figures this check cannot
  // guard, and the six prices plus `450` still catch a transcription of the
  // pricing table, which is the shape the failure actually takes.
  "450",
  // fair_use.captures_per_cycle
  "6000",
  "22000",
  // retention.raw_captures_days / retention.rollups_days
  "395",
  "1095",
  // sla.uptime
  "99.5",
  "99.9",
  "99.95",
];

/**
 * Where these values legitimately appear, and why each is allowed.
 *
 * The list is short on purpose: every entry is a place the matrix is
 * TRANSCRIBED rather than USED, and each has a stated provenance.
 */
const ALLOWED = new Map<string, string>([
  [
    join("src", "db", "seed", "plan-entitlements.ts"),
    "the transcription of §2's matrix itself — the single source every other reader goes through",
  ],
  [
    join("src", "db", "migrations", "sql", "0002_identity_tenancy_billing.up.sql"),
    "the seeded INSERT, generated from the file above by scripts/print-entitlements.mts",
  ],
  [
    join("src", "db", "migrations", "sql", "0018_entitlement_live_flags.up.sql"),
    "transforms the seeded jsonb in place; adds no values of its own",
  ],
  [join("contracts", "openapi.generated.json"), "generated artifact, not authored"],
]);

const SEARCHED_ROOTS = ["src", "contracts"];
const SEARCHED_EXTENSIONS = [".ts", ".tsx", ".sql", ".json", ".mts"];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (SEARCHED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
      yield full;
    }
  }
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly value: string;
  readonly text: string;
}

/**
 * A numeric literal, not a substring.
 *
 * `1200` must not match inside `1200000` (a real delay in this codebase) or
 * inside `60_000`, so the boundaries reject a digit, a decimal point, or an
 * underscore on either side. `\b` alone is not enough: it would let `1200` hit
 * inside `1200.5`, and `_` is itself a word character so `\b` never fires
 * between `60` and `_000`.
 */
function occurrences(text: string, value: string): number[] {
  const escaped = value.replace(".", "\\.");
  const pattern = new RegExp(`(?<![\\d._])${escaped}(?![\\d._])`, "g");
  const lines = text.split("\n");
  const found: number[] = [];
  lines.forEach((line, index) => {
    if (isCommentLine(line)) {
      return;
    }
    if (pattern.test(line)) {
      found.push(index + 1);
    }
    pattern.lastIndex = 0;
  });
  return found;
}

/**
 * A line that is only a comment.
 *
 * Prose QUOTING a figure is not a hardcoded figure, and this file's own
 * exemption is the proof: `metrics.ts` and `error-details.schema.ts` both
 * explain the fair-use rule by naming the ceiling the refusal must not
 * publish. Flagging those would push the next author to write the explanation
 * without the number, which makes the codebase worse to read in exchange for
 * nothing.
 *
 * Only WHOLE-line comments are skipped — `const LIMIT = 6000; // the growth
 * ceiling` still has code on it and is still checked, which is asserted below.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("--");
}

describe("STORY-069 AC10 · no plan limit, price, or credit cost is hardcoded", () => {
  it("finds none of the matrix's distinctive values outside the seed and its generated copies", () => {
    const hits: Hit[] = [];

    for (const root of SEARCHED_ROOTS) {
      for (const file of walk(join(REPO_ROOT, root))) {
        const relativePath = relative(REPO_ROOT, file);
        if (ALLOWED.has(relativePath)) {
          continue;
        }
        const text = readFileSync(file, "utf8");
        for (const value of PLAN_VALUES_THAT_MUST_NOT_BE_HARDCODED) {
          for (const line of occurrences(text, value)) {
            hits.push({
              file: relativePath.split(sep).join("/"),
              line,
              value,
              text: (text.split("\n")[line - 1] ?? "").trim().slice(0, 140),
            });
          }
        }
      }
    }

    // Reported as the full list rather than a count, so a failure names the
    // file and line rather than sending the reader to grep for it.
    expect(hits).toEqual([]);
  });

  it("the check would actually catch one — the values are matched as literals, not substrings", () => {
    // A check that cannot fail is decoration. This asserts the matcher on a
    // synthetic source, including the two near-misses it must NOT flag.
    expect(occurrences("const PRICE_PER_MONTH = 129;", "129")).toEqual([1]);
    expect(occurrences("const delayMs = 1200000;", "1200")).toEqual([]);
    expect(occurrences("const windowMs = 60_000;", "6000")).toEqual([]);
    expect(occurrences("const uptime = 99.95;", "99.9")).toEqual([]);
    expect(occurrences("const uptime = 99.9;", "99.9")).toEqual([1]);
  });

  it("prose naming a figure is not a hardcoded figure, but code with a trailing comment still is", () => {
    expect(occurrences("// the growth ceiling is 6000 captures per cycle", "6000")).toEqual([]);
    expect(occurrences(" * A 429 carrying `limit: 6000` publishes it", "6000")).toEqual([]);
    expect(occurrences("-- seeded at 6000 for growth", "6000")).toEqual([]);
    // The hole this could open, closed: code is still code with a comment on it.
    expect(occurrences("const CEILING = 6000; // the growth ceiling", "6000")).toEqual([1]);
  });

  it("every allow-listed path still exists", () => {
    // An allow-list entry for a file that has been moved or deleted is a hole
    // nobody would notice: the check keeps passing and the exemption is
    // silently wider than intended.
    for (const path of ALLOWED.keys()) {
      expect(() => statSync(join(REPO_ROOT, path)), path).not.toThrow();
    }
  });
});

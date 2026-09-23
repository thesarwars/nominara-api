import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MEASUREMENT_STATUS_SQL } from "../../../src/lib/rollup/aggregate-day.js";

// ⚠ ONE DEFINITION OF "WHAT COUNTS AS A MEASUREMENT", AND THIS IS WHAT KEEPS
// IT TO ONE.
//
// STORY-152 shipped a divergence of exactly this kind and had to back it out:
// `scorecards.service.ts`'s membership CTE spelled the window boundary
// differently from `aggregate-day.ts`, and an engine measured today dropped
// out of the header's blend while the stored chart row counted it. The fix
// made the two share one predicate.
//
// A review then found the SAME defect one predicate over — the status test
// was an allow-list here and a deny-list there. Equal over today's five
// statuses, and divergent the moment `answer_captures_status_check` gains a
// sixth: the new value would count as a measurement in the rollup and not in
// the membership, dropping the engine from the blend while the chart kept it.
//
// The set being equal today is why no integration test can catch a copy being
// reintroduced — there is nothing to observe until someone adds a status. So
// the property asserted here is STRUCTURAL: there is one definition, and both
// readers interpolate it.
describe("STORY-152 · the measurement-status predicate has exactly one definition", () => {
  const src = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../src/${relative}`, import.meta.url)), "utf8");

  const AGGREGATE = "lib/rollup/aggregate-day.ts";
  const SCORECARDS = "modules/analytics/scorecards.service.ts";

  it("the constant is what it claims to be — a deny-list over the two non-measurements", () => {
    // Pinned by VALUE as well as by sharing, because "both files agree" is
    // also true if both are wrong. A deny-list, so a status added later counts
    // as data until someone decides otherwise: the opposite default silently
    // drops real captures out of a published score.
    expect(MEASUREMENT_STATUS_SQL).toBe("c.status NOT IN ('failed', 'blocked')");
  });

  it("both readers interpolate it rather than writing their own", () => {
    for (const file of [AGGREGATE, SCORECARDS]) {
      expect(src(file), `${file} must interpolate MEASUREMENT_STATUS_SQL`).toContain("${MEASUREMENT_STATUS_SQL}");
    }
  });

  // ⚠ THE SCAN THAT ACTUALLY CATCHES A COPY. The assertion above passes even
  // if someone adds a SECOND, hand-written status predicate beside the
  // interpolation — which is precisely how the last one arrived.
  it("⚠ neither file hand-writes a status list for a measurement", () => {
    // `answer_captures.status` appears in two legitimate other shapes, and
    // both are named rather than pattern-excluded so a third has to be
    // considered rather than absorbed:
    //
    //   `last_capture` in scorecards.service.ts — "when did this engine last
    //   produce an answer", which is a FRESHNESS question, not a membership
    //   one. It stays an allow-list on purpose: a status nobody has thought
    //   about should not silently become a "last answered at".
    const ALLOWED = ["c.status IN ('captured', 'parsed', 'skipped')"];

    for (const file of [AGGREGATE, SCORECARDS]) {
      // The DECLARATION is where the predicate is allowed to be spelled out;
      // scanning it as a use would make this test unpassable by construction.
      const source = src(file).replace(/export const MEASUREMENT_STATUS_SQL =[^;]*;/u, "");
      const found = [...source.matchAll(/c\.status\s+(?:NOT\s+)?IN\s*\([^)]*\)/gu)].map((m) => m[0]);
      const unexpected = found.filter((predicate) => !ALLOWED.includes(predicate));
      expect(
        unexpected,
        `${file} hand-writes a status predicate — interpolate MEASUREMENT_STATUS_SQL instead, ` +
          "or add it to ALLOWED here with a reason",
      ).toEqual([]);
    }
  });

  it("finds the files it claims to scan — an empty scan would pass forever", () => {
    for (const file of [AGGREGATE, SCORECARDS]) {
      expect(src(file).length, `${file} is empty or unreadable`).toBeGreaterThan(1000);
    }
    // And the allow-listed shape genuinely occurs, so a rename does not leave
    // ALLOWED silently protecting nothing.
    expect(src(SCORECARDS)).toContain("c.status IN ('captured', 'parsed', 'skipped')");
    // The declaration-stripper above must actually match, or the scan is
    // running against the whole file and the ALLOWED list is doing work it
    // was not meant to do.
    expect(src(AGGREGATE)).toMatch(/export const MEASUREMENT_STATUS_SQL =[^;]*;/u);
  });
});

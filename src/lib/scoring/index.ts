// STORY-041 — the scoring library.
//
// `tracking-engine.md` Stage 6: "All per-result metrics are computed by the
// pure functions in `src/lib/scoring`, stamped with `scoring_version`, and
// written in a single transaction with the fact rows."
//
// ⚠ NOTHING IN THIS DIRECTORY IMPORTS ANYTHING. No clock, no randomness, no
// database, no logger, not even another module of this codebase. AC1 makes
// that absolute, and the story says why: "A hidden dependency on the clock or
// on a database read would make the golden set unable to distinguish a bug
// from an environment difference, and the gate would become advisory."
//
// A reviewer verifies the rule by reading the import list of each file, which
// is empty. `scoring-purity.spec.ts` asserts it so it stays that way.

export * from "./prominence.js";
export * from "./aggregate.js";
export * from "./visibility.js";
export * from "./aux.js";
export * from "./source-coverage.js";
export * from "./source-index.js";
export * from "./divergence.js";

/**
 * `scoring_version` — stamped on every fact row and every rollup.
 *
 * BUMP THIS WHEN ANY OUTPUT CHANGES BEYOND THE TOLERANCE. AC13 requires that
 * a change in any output fails CI unless the version is bumped, and §8 of
 * `tracking-engine.md` makes re-parse rather than re-capture the recovery —
 * so a stored score and the function that produced it must always agree about
 * which version they are.
 *
 * `v1` matches `answer_captures.scoring_version`'s and
 * `workspaces.scoring_version`'s DEFAULT, so nothing already written becomes
 * a mismatch on the day this library starts being called.
 */
export const SCORING_VERSION = "v1";

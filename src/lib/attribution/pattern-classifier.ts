import { SUBSTITUTION_CO_MOVEMENT_COPY, type AttributionPattern } from "../../../contracts/attribution/index.js";

// STORY-114 - scoring-models.md section 11: pattern classification is a DETERMINISTIC LOOKUP over four counts, not a model.
//
// EVERY THRESHOLD IS IN THIS FILE, in `ATTRIBUTION_THRESHOLDS`, and nowhere else.
//
//   SUBSTITUTION_SESSION_DROP  0.10  STATED by the reference: session velocity below minus 10 percent.
//   MIN_AI_SESSIONS            30    STATED by the reference ("n >= 30 sessions"), used as the sessions evidence minimum for every
//                                    pattern that claims AI sessions, and as the base the substitution decline is measured against.
//   MIN_CITATIONS              1     PROVISIONAL. The reference states no citation-side evidence minimum. One measured citation is
//                                    evidence the page is cited; zero is the absent case. Owner decision pending.
//   ORGANIC_CLICKS_NEAR_ZERO   0     PROVISIONAL. The reference says "organic_clicks ~ 0" without a number; a measured count is
//                                    near zero only when it is zero. Owner decision pending.
//
// MISSING SOURCES NARROW, NEVER WIDEN. `organicClicks === null` means Search Console is not connected. `organic_only` and `ai_only`
// both assert something about organic clicks, so neither is reachable from null: the set of patterns a URL can take shrinks to the ones
// that do not depend on the missing source. A page with no impressions data is therefore never called AI-only.
//
// PRECEDENCE (first match wins):
//   1. ai_substitution_candidate  - the most valuable finding, so it is checked before the broader dual_visibility it overlaps.
//   2. organic_only               - not cited, organic clicks measured above zero.
//   3. invisible_both             - not cited and no AI sessions (assigned, never omitted).
//   4. insufficient_data          - either side below its evidence minimum (assigned, never blank).
//   5. ai_only                    - organic clicks MEASURED at near zero.
//   6. dual_visibility            - the rest.

export const ATTRIBUTION_THRESHOLDS = Object.freeze({
  SUBSTITUTION_SESSION_DROP: 0.1,
  MIN_AI_SESSIONS: 30,
  MIN_CITATIONS: 1,
  ORGANIC_CLICKS_NEAR_ZERO: 0,
});

export interface UrlFigures {
  readonly citations: number;
  readonly citationsPrior: number;
  readonly aiSessions: number;
  readonly aiSessionsPrior: number;
  /** `null` when Search Console is not connected: unknown, which is not zero. */
  readonly organicClicks: number | null;
}

const T = ATTRIBUTION_THRESHOLDS;

export function classifyUrl(f: UrlFigures): AttributionPattern {
  const citationVelocity = f.citations - f.citationsPrior;
  // The velocity is relative to the prior window, so a prior window with no sessions has no velocity: it cannot be a substitution.
  const sessionVelocity = f.aiSessionsPrior > 0 ? (f.aiSessions - f.aiSessionsPrior) / f.aiSessionsPrior : null;
  if (citationVelocity > 0 && sessionVelocity !== null && sessionVelocity < -T.SUBSTITUTION_SESSION_DROP && f.aiSessionsPrior >= T.MIN_AI_SESSIONS) {
    return "ai_substitution_candidate";
  }
  if (f.citations === 0 && f.organicClicks !== null && f.organicClicks > T.ORGANIC_CLICKS_NEAR_ZERO) return "organic_only";
  if (f.citations === 0 && f.aiSessions === 0) return "invisible_both";
  if (f.citations < T.MIN_CITATIONS || f.aiSessions < T.MIN_AI_SESSIONS) return "insufficient_data";
  if (f.organicClicks !== null && f.organicClicks <= T.ORGANIC_CLICKS_NEAR_ZERO) return "ai_only";
  return "dual_visibility";
}

/** The co-movement note a flagged row carries, from the shared copy constant; `null` for every other pattern. */
export function substitutionNote(pattern: AttributionPattern): string | null {
  return pattern === "ai_substitution_candidate" ? SUBSTITUTION_CO_MOVEMENT_COPY : null;
}

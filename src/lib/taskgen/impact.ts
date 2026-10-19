/**
 * STORY-063 — impact score and effort band come from the rule (AC10). The score is `100 * impact_weight * strength`, where
 * the rule's weight is the ceiling and `strength` (0..1) says how far past its threshold the evidence went. Clamped to
 * the column's documented 0..100.
 */
export function impactScore(impactWeight: number, strength: number): number {
  const raw = 100 * impactWeight * strength;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, raw));
}

/**
 * How strongly the evidence clears the rule's threshold: 0.5 AT the threshold, rising linearly to 1 at twice the
 * threshold. A task that only just fired is therefore never ranked as if it were extreme, and one far past the bar is.
 */
export function strengthOf(observed: number, threshold: number): number {
  if (!(threshold > 0) || !Number.isFinite(observed)) return 0.5;
  const excess = Math.min(1, Math.max(0, observed / threshold - 1));
  return 0.5 + 0.5 * excess;
}

import { createHash } from "node:crypto";

// STORY-032 AC8 — tracking-engine.md §6's L3 content-hash short-circuit.
//
// §6: "If content_hash matches this cell's previous result, copy the prior
// parse output wholesale and skip entity matching, arbitration, and
// embedding. Recomputed only if normalizer_version, scoring_version, or the
// project's alias set changed."
//
// UNLIKE L1 AND L2 THIS IS NOT A PLAN-TIME DECISION. The capture happens
// either way; L3 decides whether the PARSE can be skipped once the answer is
// in hand and its hash is known. It saves compute rather than a vendor call,
// which is why it is the only layer that does not suppress a capture.
//
// The decision is a pure function over four comparisons, deliberately: it is
// the piece where a wrong answer is silent in both directions, and a pure
// function is the only shape that can be exhaustively tested. Copying when
// something changed publishes a stale score. Recomputing when nothing changed
// costs money and nothing else — so where the two are in tension, this errs
// toward recomputing.

export interface L3Inputs {
  /** The answer just captured. */
  readonly contentHash: Buffer;
  /** The build's current versions and the project's current aliases. */
  readonly normalizerVersion: string;
  readonly scoringVersion: string;
  readonly aliasFingerprint: Buffer;
}

export interface L3PriorResult {
  readonly resultId: string;
  readonly contentHash: Buffer;
  readonly normalizerVersion: string;
  readonly scoringVersion: string;
  /** NULL for any row written before STORY-032 — read as "unknown", never as "matched". */
  readonly aliasFingerprint: Buffer | null;
}

export type L3Decision =
  | { readonly shortCircuit: true; readonly sourceResultId: string }
  | { readonly shortCircuit: false; readonly reason: L3RecomputeReason };

export type L3RecomputeReason =
  | "no_prior_result"
  | "content_changed"
  | "normalizer_version_changed"
  | "scoring_version_changed"
  | "alias_set_changed"
  | "alias_fingerprint_unknown";

/**
 * The alias set, hashed.
 *
 * Everything entity matching reads: the project's own aliases and owned
 * domains, and every competitor's name and aliases. A competitor added this
 * morning must invalidate a short-circuit, and competitors live in their own
 * table — a fingerprint over the project row alone would miss them entirely,
 * which is the most likely way for this cache to go quietly wrong.
 *
 * Order-independent by construction: the inputs are sorted before hashing, so
 * a database returning the same aliases in a different order does not look
 * like a change. Each entry is length-prefixed, so ["ab","c"] and ["a","bc"]
 * cannot hash alike.
 */
export function aliasSetFingerprint(input: {
  readonly brandAliases: readonly string[];
  readonly negativeAliases: readonly string[];
  readonly ownedDomains: readonly string[];
  readonly competitors: readonly { readonly name: string; readonly aliases: readonly string[] }[];
}): Buffer {
  const parts = [
    ...input.brandAliases.map((a) => `b:${a}`),
    ...input.negativeAliases.map((a) => `n:${a}`),
    ...input.ownedDomains.map((d) => `d:${d}`),
    ...input.competitors.flatMap((c) => [`c:${c.name}`, ...c.aliases.map((a) => `ca:${c.name}:${a}`)]),
  ].sort();

  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${String(part.length)}:${part}`);
  return hash.digest();
}

/**
 * Whether this capture's parse can be copied from `prior`.
 *
 * Reasons are returned rather than a bare boolean so a caller can record WHY
 * a recompute happened. A suppression rate that falls with no explanation is
 * indistinguishable from a cache that has stopped working, and this is the
 * only place that knows the difference.
 */
export function decideL3(current: L3Inputs, prior: L3PriorResult | null): L3Decision {
  if (prior === null) return { shortCircuit: false, reason: "no_prior_result" };
  if (!current.contentHash.equals(prior.contentHash)) {
    return { shortCircuit: false, reason: "content_changed" };
  }
  if (current.normalizerVersion !== prior.normalizerVersion) {
    return { shortCircuit: false, reason: "normalizer_version_changed" };
  }
  if (current.scoringVersion !== prior.scoringVersion) {
    return { shortCircuit: false, reason: "scoring_version_changed" };
  }
  if (prior.aliasFingerprint === null) {
    // Written before the fingerprint existed. Unknown is not "matched" —
    // recomputing costs money, and skipping a needed recompute costs
    // correctness.
    return { shortCircuit: false, reason: "alias_fingerprint_unknown" };
  }
  if (!current.aliasFingerprint.equals(prior.aliasFingerprint)) {
    return { shortCircuit: false, reason: "alias_set_changed" };
  }
  return { shortCircuit: true, sourceResultId: prior.resultId };
}

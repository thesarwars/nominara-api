import type { ClientBase } from "pg";
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
 * Everything entity matching reads: the project's own aliases, ROOT DOMAIN
 * and owned domains, and every competitor's name, aliases and ROOT DOMAIN. A
 * competitor added this morning must invalidate a short-circuit, and
 * competitors live in their own table — a fingerprint over the project row
 * alone would miss them entirely, which is the most likely way for this
 * cache to go quietly wrong.
 *
 * THE TWO ROOT DOMAINS WERE MISSING, found by the second-engineer review.
 * Both feed citation attribution rather than name matching, which is why
 * they were easy to overlook and why the omission was serious:
 *
 *   `projects.root_domain` is NOT NULL and is the project's PRIMARY domain —
 *   `owned_domains` is the secondary list beside it, not a superset. It was
 *   the one column of the three the fingerprint did not read. A domain
 *   migration or rebrand would leave every cached parse attributing
 *   `owned_citation_count` against the old domain, indefinitely, because the
 *   answer text had not changed and so nothing else would invalidate.
 *
 *   `competitors.root_domain` is how a citation is attributed to a
 *   competitor at all. Setting it on a competitor that had none — the exact
 *   shape of "finish configuring the competitor I added yesterday" — changed
 *   what matching would produce while leaving this fingerprint identical.
 *
 * Adding inputs changes every fingerprint, so the first run after this ships
 * recomputes rather than short-circuits. That is the safe direction and the
 * one this module says it errs toward: recomputing costs money, copying a
 * stale score costs trust.
 *
 * Order-independent by construction: the inputs are sorted before hashing, so
 * a database returning the same aliases in a different order does not look
 * like a change. Each entry is length-prefixed, so ["ab","c"] and ["a","bc"]
 * cannot hash alike.
 */
export function aliasSetFingerprint(input: {
  /** `projects.root_domain` — NOT NULL, and not a member of `ownedDomains`. */
  readonly rootDomain: string;
  readonly brandAliases: readonly string[];
  readonly negativeAliases: readonly string[];
  readonly ownedDomains: readonly string[];
  readonly competitors: readonly {
    readonly name: string;
    readonly aliases: readonly string[];
    /** `competitors.root_domain` — nullable, and how a citation is attributed to this competitor. */
    readonly rootDomain: string | null;
  }[];
}): Buffer {
  const parts = [
    `r:${input.rootDomain}`,
    ...input.brandAliases.map((a) => `b:${a}`),
    ...input.negativeAliases.map((a) => `n:${a}`),
    ...input.ownedDomains.map((d) => `d:${d}`),
    ...input.competitors.flatMap((c) => [
      `c:${c.name}`,
      // Null and empty string must not hash alike: "no domain configured"
      // and "domain cleared to empty" are different states of the row, and
      // conflating them would let one become the other invisibly.
      `cd:${c.name}:${c.rootDomain === null ? "\u0000null" : c.rootDomain}`,
      ...c.aliases.map((a) => `ca:${c.name}:${a}`),
    ]),
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

/**
 * Read a project's alias set from the database and fingerprint it.
 *
 * WHY THIS EXISTS AS CODE RATHER THAN AS A CALLER'S OBJECT LITERAL.
 * `aliasSetFingerprint` had no caller anywhere in `src/` — nothing mapped
 * database columns onto its input, so its completeness was unverifiable and
 * an omission was undetectable by construction. Two omissions had already
 * shipped that way, both root domains, and the review that found them noted
 * a third class still missing. A hand-built literal at each call site would
 * have made a fourth inevitable.
 *
 * With one loader, "does the fingerprint read everything the matcher reads"
 * becomes a question a test can ask of the database: change a column, and
 * the fingerprint must move. capture-l3-alias-set.spec.ts asks it of every
 * matcher-relevant column.
 *
 * STILL MISSING, AND DELIBERATELY SO: §7's third input class, the
 * discovered-candidate labels. The automaton is built from `brand_aliases ∪
 * competitor aliases ∪ discovered-candidate labels`, and candidates live in
 * `mention_facts` (`entity_type='other'`) — a table only EPIC-05's parser
 * writes, and which no code populates today, so the set is empty for every
 * project. Which candidates enter the dictionary, and at what occurrence
 * threshold, is EPIC-05's to settle; guessing it here would bake a number
 * the reference does not give into a cache-invalidation rule. The set is
 * empty until then, so the fingerprint is complete for the data that
 * exists — and this comment is the record that it will not be on the day
 * that table starts filling.
 */
export async function loadAliasSet(
  tx: ClientBase,
  projectId: string,
): Promise<Parameters<typeof aliasSetFingerprint>[0]> {
  const project = await tx.query<{
    root_domain: string;
    owned_domains: string[];
    brand_aliases: string[];
    negative_aliases: string[];
  }>(
    `SELECT root_domain, owned_domains, brand_aliases, negative_aliases
       FROM projects WHERE id = $1`,
    [projectId],
  );
  const row = project.rows[0];
  if (row === undefined) {
    throw new Error(`alias set: project ${projectId} does not exist, or is invisible under the current tenant context`);
  }

  const competitors = await tx.query<{ name: string; aliases: string[]; root_domain: string | null }>(
    // Soft-deleted competitors are excluded, because the matcher excludes
    // them: leaving one in would hold a short-circuit valid against an
    // automaton that no longer contains it.
    `SELECT name, aliases, root_domain
       FROM competitors WHERE project_id = $1 AND deleted_at IS NULL
      ORDER BY name`,
    [projectId],
  );

  return {
    rootDomain: row.root_domain,
    brandAliases: row.brand_aliases,
    negativeAliases: row.negative_aliases,
    ownedDomains: row.owned_domains,
    competitors: competitors.rows.map((competitor) => ({
      name: competitor.name,
      aliases: competitor.aliases,
      rootDomain: competitor.root_domain,
    })),
  };
}

/** The project's current alias fingerprint, as `SuppressedRowContext` needs it. */
export async function projectAliasFingerprint(tx: ClientBase, projectId: string): Promise<Buffer> {
  return aliasSetFingerprint(await loadAliasSet(tx, projectId));
}

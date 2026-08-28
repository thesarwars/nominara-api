import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aliasSetFingerprint, decideL3, type L3Inputs, type L3PriorResult } from "../../src/lib/capture/l3-short-circuit.js";

// STORY-032 AC8 — §6's L3 short-circuit.
//
// Wrong in both directions, and silent in both. Copying when something
// changed publishes a stale score against a configuration the customer has
// since altered — a competitor added this morning that never appears.
// Recomputing when nothing changed costs money and nothing else. Where the
// two are in tension the decision must err toward recomputing, and these
// tests pin that direction rather than merely the happy path.
const HASH_A = createHash("sha256").update("answer-a").digest();
const HASH_B = createHash("sha256").update("answer-b").digest();
const ALIASES_A = createHash("sha256").update("aliases-a").digest();
const ALIASES_B = createHash("sha256").update("aliases-b").digest();

const CURRENT: L3Inputs = {
  contentHash: HASH_A,
  normalizerVersion: "v1",
  scoringVersion: "v1",
  aliasFingerprint: ALIASES_A,
};

const PRIOR: L3PriorResult = {
  resultId: "11111111-1111-4111-8111-111111111111",
  contentHash: HASH_A,
  normalizerVersion: "v1",
  scoringVersion: "v1",
  aliasFingerprint: ALIASES_A,
};

describe("STORY-032 · the L3 content-hash short-circuit", () => {
  // The guard: if it never short-circuits, every "must recompute" below
  // passes for the wrong reason.
  it("short-circuits when the answer and every invalidator are unchanged", () => {
    expect(decideL3(CURRENT, PRIOR)).toEqual({ shortCircuit: true, sourceResultId: PRIOR.resultId });
  });

  it.each([
    ["a different answer", { contentHash: HASH_B }, "content_changed"],
    ["a new normaliser", { normalizerVersion: "v2" }, "normalizer_version_changed"],
    ["a new scoring version", { scoringVersion: "v2" }, "scoring_version_changed"],
    ["a changed alias set", { aliasFingerprint: ALIASES_B }, "alias_set_changed"],
  ] as const)("recomputes on %s", (_label, patch, reason) => {
    expect(decideL3({ ...CURRENT, ...patch }, PRIOR)).toEqual({ shortCircuit: false, reason });
  });

  it("recomputes when there is no prior result for the cell", () => {
    expect(decideL3(CURRENT, null)).toEqual({ shortCircuit: false, reason: "no_prior_result" });
  });

  // Rows written before the fingerprint column existed. "Unknown" must not be
  // read as "matched" — that would short-circuit against an alias set nobody
  // can vouch for, which is the one outcome this whole column exists to
  // prevent.
  it("recomputes when the prior row predates the fingerprint, rather than assuming it matched", () => {
    expect(decideL3(CURRENT, { ...PRIOR, aliasFingerprint: null })).toEqual({
      shortCircuit: false,
      reason: "alias_fingerprint_unknown",
    });
  });
});

describe("STORY-032 · the alias-set fingerprint", () => {
  const BASE = {
    brandAliases: ["Acme", "Acme Corp"],
    negativeAliases: ["Acme Anvils"],
    ownedDomains: ["acme.test"],
    competitors: [{ name: "Globex", aliases: ["Globex Inc"] }],
  };

  it("is stable across repeated calls", () => {
    expect(aliasSetFingerprint(BASE).equals(aliasSetFingerprint({ ...BASE }))).toBe(true);
  });

  // A database returning the same rows in a different order is not a change,
  // and treating it as one would recompute every parse forever.
  it("does not depend on the order the aliases arrive in", () => {
    const shuffled = {
      ...BASE,
      brandAliases: ["Acme Corp", "Acme"],
      competitors: [{ name: "Globex", aliases: ["Globex Inc"] }],
    };
    expect(aliasSetFingerprint(shuffled).equals(aliasSetFingerprint(BASE))).toBe(true);
  });

  // THE ONE MOST LIKELY TO GO WRONG. Competitors live in their own table, so
  // a fingerprint over the project row alone would miss them — and a
  // competitor added this morning would never appear in a cell whose answer
  // had not changed.
  it("changes when a COMPETITOR is added, not just when the project's own aliases change", () => {
    const withCompetitor = { ...BASE, competitors: [...BASE.competitors, { name: "Initech", aliases: [] }] };
    expect(aliasSetFingerprint(withCompetitor).equals(aliasSetFingerprint(BASE))).toBe(false);
  });

  it("changes when a competitor gains an alias", () => {
    const extended = { ...BASE, competitors: [{ name: "Globex", aliases: ["Globex Inc", "Globex Ltd"] }] };
    expect(aliasSetFingerprint(extended).equals(aliasSetFingerprint(BASE))).toBe(false);
  });

  it.each([
    ["a brand alias", { brandAliases: ["Acme", "Acme Corp", "ACME Co"] }],
    ["a negative alias", { negativeAliases: ["Acme Anvils", "Acme Cartoons"] }],
    ["an owned domain", { ownedDomains: ["acme.test", "acme.example"] }],
  ] as const)("changes when %s is added", (_label, patch) => {
    expect(aliasSetFingerprint({ ...BASE, ...patch }).equals(aliasSetFingerprint(BASE))).toBe(false);
  });

  // LENGTH-PREFIXED, and this is the pair that proves it.
  //
  // My first attempt here compared ["ab","c"] with ["a","bc"] and passed with
  // the length prefix REMOVED — the per-category tags ("b:", "c:") already
  // separated those two, so the test named a property it never exercised.
  // Caught by mutating the source.
  //
  // These two genuinely collide without it: one brand alias "a" plus a
  // competitor named "b" concatenates to "b:a" + "c:b", and a single brand
  // alias literally spelled "ac:b" concatenates to "b:ac:b". The same bytes,
  // from a different alias set — so a competitor could be added or removed
  // with no change to the fingerprint, and L3 would keep short-circuiting
  // against a configuration that had moved.
  it("distinguishes sets whose concatenations would otherwise be identical", () => {
    const withCompetitor = {
      brandAliases: ["a"],
      negativeAliases: [],
      ownedDomains: [],
      competitors: [{ name: "b", aliases: [] }],
    };
    const withoutCompetitor = {
      brandAliases: ["ac:b"],
      negativeAliases: [],
      ownedDomains: [],
      competitors: [],
    };
    expect(
      aliasSetFingerprint(withCompetitor).equals(aliasSetFingerprint(withoutCompetitor)),
      "these concatenate to the same bytes; only the length prefix tells them apart",
    ).toBe(false);
  });

  // A project that has configured nothing yet still needs a stable answer
  // rather than a throw or an empty buffer.
  it("hashes an empty alias set to a stable value", () => {
    const empty = { brandAliases: [], negativeAliases: [], ownedDomains: [], competitors: [] };
    expect(aliasSetFingerprint(empty)).toHaveLength(32);
    expect(aliasSetFingerprint(empty).equals(aliasSetFingerprint(empty))).toBe(true);
  });
});

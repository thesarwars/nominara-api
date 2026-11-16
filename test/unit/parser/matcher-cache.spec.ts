import { beforeEach, describe, expect, it } from "vitest";
import type { AliasEntry } from "../../../src/lib/parser/entity-matcher.js";
import { aliasSetHash, matchEntities } from "../../../src/lib/parser/entity-matcher.js";
import { MATCHER_CACHE_CAPACITY, clearMatcherCache, matcherCacheStats, matcherFor } from "../../../src/lib/parser/matcher-cache.js";

// STORY-036 AC1 - the automaton is built once per (project, alias-set hash), not once per capture.

const alias = (alias: string, label = alias): AliasEntry => ({ entityType: "competitor", entityId: "c1", label, alias });
const A = alias("Acme");
const B = alias("Bolt");

describe("STORY-036 AC1 - the automaton cache", () => {
  beforeEach(() => clearMatcherCache());

  it("STORY-036 AC1 - the same project and alias set returns the SAME automaton, built once", () => {
    const first = matcherFor("p1", [A, B], []);
    const second = matcherFor("p1", [A, B], []);
    expect(second).toBe(first);
    expect(matcherCacheStats()).toMatchObject({ builds: 1, hits: 1, size: 1 });
  });

  it("STORY-036 AC1 - reordering the same alias set is a hit", () => {
    const first = matcherFor("p1", [A, B], ["x"]);
    expect(matcherFor("p1", [B, A], ["x"])).toBe(first);
    expect(matcherCacheStats().builds).toBe(1);
  });

  it("STORY-036 AC1 - a changed alias set is a MISS, so an edited alias is never answered by the old automaton", () => {
    const first = matcherFor("p1", [A], []);
    const second = matcherFor("p1", [A, B], []);
    expect(second).not.toBe(first);
    expect(matcherCacheStats().builds).toBe(2);
  });

  it("STORY-036 AC1 - a changed NEGATIVE alias is a miss as well", () => {
    const first = matcherFor("p1", [A], []);
    expect(matcherFor("p1", [A], ["acme of"])).not.toBe(first);
  });

  it("STORY-036 AC1 - two projects with an identical alias set do not share an entry", () => {
    expect(matcherFor("p1", [A], [])).not.toBe(matcherFor("p2", [A], []));
    expect(matcherCacheStats().size).toBe(2);
  });

  it("STORY-036 AC1 - the cache is bounded; the least recently used entry is evicted and rebuilt on demand", () => {
    const first = matcherFor("p0", [A], []);
    for (let i = 1; i <= MATCHER_CACHE_CAPACITY; i += 1) matcherFor(`p${String(i)}`, [A], []);
    expect(matcherCacheStats().size).toBe(MATCHER_CACHE_CAPACITY);
    expect(matcherFor("p0", [A], [])).not.toBe(first);
  });

  it("STORY-036 AC1 - a hit refreshes recency, so a hot project is not the one evicted", () => {
    const hot = matcherFor("hot", [A], []);
    for (let i = 0; i < MATCHER_CACHE_CAPACITY - 1; i += 1) matcherFor(`p${String(i)}`, [A], []);
    matcherFor("hot", [A], []);
    matcherFor("one-more", [A], []);
    expect(matcherFor("hot", [A], [])).toBe(hot);
  });
});

describe("STORY-036 AC1 - parseCapture uses the cache", () => {
  it("STORY-036 AC1 - two captures of one project build the automaton ONCE", async () => {
    const { parseCapture } = await import("../../../src/lib/parser/parse-capture.js");
    clearMatcherCache();
    const context = {
      rootDomain: "acme.example",
      ownedDomains: [],
      competitorDomains: [],
      negativeAliases: [],
      aliases: [{ entityType: "brand" as const, entityId: null, label: "Acme", alias: "Acme" }],
    };
    const capture = (resultId: string, text: string) => ({
      resultId,
      workspaceId: "w",
      projectId: "p1",
      promptId: "q",
      engineKey: "google_ai_mode",
      capturedAt: new Date("2026-11-01T00:00:00Z"),
      text,
      flags: [],
    });
    const first = await parseCapture(capture("r1", "Acme is a fine tool."), context);
    const second = await parseCapture(capture("r2", "Many people use Acme daily."), context);
    expect(first.brandPresent).toBe(true);
    expect(second.brandPresent).toBe(true);
    expect(matcherCacheStats()).toMatchObject({ builds: 1, hits: 1 });
  });
});

describe("batch 18 fix - the alias-set hash and the automaton are order- and field-boundary-safe", () => {
  beforeEach(() => clearMatcherCache());

  it("fields within an alias entry cannot run into each other: (label 'Acme Corp', alias 'X') vs (label 'Acme', alias 'Corp X')", () => {
    const one: AliasEntry = { entityType: "competitor", entityId: "c1", label: "Acme Corp", alias: "X" };
    const two: AliasEntry = { entityType: "competitor", entityId: "c1", label: "Acme", alias: "Corp X" };
    expect(aliasSetHash([one], [])).not.toBe(aliasSetHash([two], []));
    // and a label/alias pair cannot be re-cut across the entry boundary either
    const split = [alias("a", "b"), alias("c", "d")];
    const merged = [alias("a", "b\u0001competitor\u0000c1\u0000c")];
    expect(aliasSetHash(split, [])).not.toBe(aliasSetHash(merged, []));
  });

  it("two entities claiming the SAME alias: the winner does not depend on the order the cache first saw them in", () => {
    const first: AliasEntry = { entityType: "competitor", entityId: "c-1", label: "Acme One", alias: "Acme" };
    const second: AliasEntry = { entityType: "competitor", entityId: "c-2", label: "Acme Two", alias: "Acme" };
    const winner = (aliases: readonly AliasEntry[]): string | null => {
      clearMatcherCache();
      const mention = matchEntities({ text: "We like Acme.", aliases, negativeAliases: [] }, matcherFor("p1", aliases, []))[0];
      return mention?.entityId ?? null;
    };
    expect(winner([first, second])).toBe(winner([second, first]));
  });
});

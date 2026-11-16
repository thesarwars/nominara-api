import { incrementCounter } from "../telemetry/metrics.js";
import { aliasSetHash, buildMatcher, type AliasEntry } from "./entity-matcher.js";

// STORY-036 AC1 - the automaton is built once per `(project_id, alias_set_hash)`, not once per capture.
//
// IN PROCESS, NOT VALKEY. `tracking-engine.md` Stage 2 says "compiled and cached in Valkey". A compiled automaton is a trie of JS
// objects, and moving it through Valkey means serialising and re-parsing it on every read, which costs about what building it does.
// What the AC asks of the cache is that a capture does not pay the build, and a per-process map keyed by exactly the reference's key
// delivers that; the key (not the store) is what makes an edited alias set a miss. Reported to the owner as a deliberate deviation.
//
// BOUNDED. A worker parses many projects over its life, so an unbounded map is a leak that grows with the customer count. Least
// recently used goes first; evicting is only a rebuild.
//
// THE AUTOMATON IS IMMUTABLE once built (`matchEntities` only reads it), which is what makes sharing one across concurrent parses safe.

export const MATCHER_CACHE_CAPACITY = 256;

type Matcher = ReturnType<typeof buildMatcher>;

const entries = new Map<string, Matcher>();
const counters = { hits: 0, builds: 0 };

/** The automaton for this project's alias set, built on the first call and reused until the set changes. */
export function matcherFor(projectId: string, aliases: readonly AliasEntry[], negativeAliases: readonly string[]): Matcher {
  // The project id is part of the key and is joined with a character a uuid cannot contain, so no id can run into the hash.
  const key = `${projectId}\u0000${aliasSetHash(aliases, negativeAliases)}`;
  const cached = entries.get(key);
  if (cached !== undefined) {
    // Re-insert to move it to the most recent end of the Map's insertion order.
    entries.delete(key);
    entries.set(key, cached);
    counters.hits += 1;
    incrementCounter("nominara_parser_matcher_cache_total", { outcome: "hit" });
    return cached;
  }
  const built = buildMatcher(aliases);
  entries.set(key, built);
  if (entries.size > MATCHER_CACHE_CAPACITY) entries.delete(entries.keys().next().value!);
  counters.builds += 1;
  incrementCounter("nominara_parser_matcher_cache_total", { outcome: "build" });
  return built;
}

export function matcherCacheStats(): { readonly hits: number; readonly builds: number; readonly size: number } {
  return { ...counters, size: entries.size };
}

/** Test seam. */
export function clearMatcherCache(): void {
  entries.clear();
  counters.hits = 0;
  counters.builds = 0;
}

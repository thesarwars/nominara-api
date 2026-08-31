import type { Cache } from "../cache/cache.port.js";
import { captureL1Key } from "./l1-cache-key.js";
import { cellKey } from "./l2-semantic-reuse.js";

// STORY-032 AC4 — tracking-engine.md §6's L1 exact-hash probe.
//
// The probe is ONE batched read for the whole run, not a read per cell. A
// planning path that costs one round trip per cell would make planning
// slower the more there is to plan, and it would pay that cost to discover
// whether it can avoid work — the cache asked to justify itself in the
// currency it exists to save. `Cache.getMany` is the operation added for it.
//
// WHAT AN ENTRY HOLDS, and why it is not a result id. L1 is cross-tenant, so
// the value cannot point at a row: a `result_id` belongs to whichever tenant
// happened to capture first, and handing it to a second tenant would be a
// cross-tenant reference dressed up as a cache hit. It holds the answer's
// CONTENT HASH instead, which is public information about a public answer.
// The reader then resolves that hash against its OWN prior parses through
// the L3 short-circuit, so nothing crosses the boundary.

export interface L1Candidate {
  readonly promptId: string;
  readonly promptText: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  readonly ttlSeconds: number;
  readonly adapterVersion: string;
}

export interface L1Hit {
  readonly promptId: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  /** The shared answer's content hash — resolved against THIS tenant's own parses by L3. */
  readonly contentHash: Buffer;
}

export interface L1ProbeContext {
  /** `cacheKeyNamespace()`. */
  readonly env: string;
  readonly locale: string;
  readonly personaHint: string | null;
  readonly nowMs: number;
  /**
   * False for a workspace whose plan carries `no_shared_cache`.
   *
   * Such a workspace BYPASSES L1 — it does not get a per-tenant variant of
   * the key. Salting would look like the same thing while quietly filling a
   * cross-tenant namespace with entries only one tenant can ever hit, which
   * is both a leak into an exempt namespace and a slow erosion of the
   * sharing the namespace exists for. See l1-cache-key.ts.
   */
  readonly sharedCacheEnabled: boolean;
}

/**
 * The major of an adapter's semantic version.
 *
 * STRICT on purpose. `Number.parseInt` returns NaN for a version it cannot
 * read, `String(NaN)` is "NaN", and every unreadable version would therefore
 * hash to the SAME bucket — so two genuinely incompatible adapters would
 * share each other's cached answers, and the "an adapter upgrade invalidates
 * the cache" rule would fail exactly for the adapters whose versions are
 * malformed. A malformed version is a bug to surface, not a bucket to join.
 */
export function adapterMajorOf(adapterVersion: string): number {
  const match = /^(\d+)\.\d+\.\d+/u.exec(adapterVersion);
  if (match?.[1] === undefined) {
    throw new Error(
      `L1 probe: adapter version "${adapterVersion}" is not semantic — ` +
        "an unparseable version would collapse every such adapter into one shared cache bucket",
    );
  }
  return Number(match[1]);
}

/**
 * The batch probe. Returns at most one hit per candidate, keyed by `cellKey`.
 *
 * Like the L2 probe, this finds suppressions; it does not act on them. It
 * copies no parse output and writes nothing.
 */
export async function probeExactHash(
  cache: Cache,
  context: L1ProbeContext,
  candidates: readonly L1Candidate[],
): Promise<Map<string, L1Hit>> {
  const hits = new Map<string, L1Hit>();
  if (candidates.length === 0 || !context.sharedCacheEnabled) return hits;

  // DEDUPED before the read, because the L1 key deliberately does not
  // include the sample index — §6 keys on the question, and the three
  // samples of one prompt are the same question. Sending the key once per
  // sample would multiply the batch by the sample count to fetch the same
  // value each time. Every cell that shares a key still gets its own hit.
  const cellsByKey = new Map<string, L1Candidate[]>();
  for (const candidate of candidates) {
    const key = captureL1Key({
      env: context.env,
      engineKey: candidate.engineKey,
      adapterMajor: adapterMajorOf(candidate.adapterVersion),
      promptText: candidate.promptText,
      locale: context.locale,
      personaHint: context.personaHint,
      ttlSeconds: candidate.ttlSeconds,
      nowMs: context.nowMs,
    });
    const bucket = cellsByKey.get(key);
    if (bucket === undefined) cellsByKey.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const keys = [...cellsByKey.keys()];
  const values = await cache.getMany(keys);

  keys.forEach((key, index) => {
    const value = values[index];
    if (value === undefined || value === "") return;
    // A stored value that is not a hex digest is a corrupt or foreign entry,
    // never a hit. Treating it as one would put arbitrary bytes into
    // `content_hash` and send L3 looking for a parse that cannot exist.
    if (!/^[0-9a-f]{64}$/u.test(value)) return;
    const contentHash = Buffer.from(value, "hex");
    for (const candidate of cellsByKey.get(key) ?? []) {
      hits.set(cellKey(candidate), {
        promptId: candidate.promptId,
        engineKey: candidate.engineKey,
        sampleIndex: candidate.sampleIndex,
        contentHash,
      });
    }
  });

  return hits;
}

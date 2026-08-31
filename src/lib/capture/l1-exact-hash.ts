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
// WHAT AN ENTRY HOLDS: THE ANSWER ITSELF.
//
// §6 is explicit — "L1 entries store only an engine's public answer to a
// public question and contain no tenant identifier. Entity matching,
// scoring, and storage all happen per tenant AFTER the cache read." The
// storage happens after the read because the read is what SUPPLIES the thing
// stored.
//
// This module first shipped storing only the content HASH, on the reasoning
// that a `result_id` would hand one tenant a reference to another tenant's
// row. That half was right and still holds — no result id appears here. But
// a hash alone is not an answer, and the reader was left with nothing to
// store: the suppressed row carried a NULL `raw_object_key`, a NULL
// `response_excerpt` and an empty `payload`, so no tenant that had not
// ALREADY captured that exact answer could recover a word of it. The row was
// not "unscored pending re-match"; it was unscoreable, permanently, while
// `brand_present NOT NULL DEFAULT false` presented it to any future
// aggregation as "the brand was absent". Found by the second-engineer
// review, which reproduced the empty row.
//
// The remedy proposed there — admit an L1 hit only when the workspace can
// already resolve the hash — was NOT taken: it would reduce L1 to a
// per-tenant cache, since a tenant can only resolve a hash it already
// captured. That is the opposite of §6's "all tenants asking the same
// question in the same window share one capture", which the same section
// calls the single largest cost lever. The defect was the missing answer,
// not the sharing.
//
// A tenant identifier still cannot enter: the envelope carries the engine's
// public response and nothing else, which is exactly what §10's exemption is
// granted for.

export interface L1Candidate {
  readonly promptId: string;
  readonly promptText: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  readonly ttlSeconds: number;
  readonly adapterVersion: string;
}

/**
 * What one shared entry holds — the engine's public answer, and nothing that
 * identifies who asked.
 *
 * Versioned because the value outlives a deploy: an entry written by the
 * previous build is still in the cache when the next one reads it, and an
 * envelope it cannot read must be a MISS rather than a crash or, worse, a
 * partially-populated row.
 */
export interface L1Envelope {
  readonly v: 1;
  /** Hex sha256 of the answer, as stored in `answer_captures.content_hash`. */
  readonly contentHash: string;
  /** The adapter's normalised response — what the parser reads. */
  readonly payload: Record<string, unknown>;
  /** The short human-readable excerpt shown in the UI. */
  readonly excerpt: string | null;
}

export interface L1Hit {
  readonly promptId: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  readonly contentHash: Buffer;
  /** The answer, so the suppressed row is a row the parser can actually read. */
  readonly payload: Record<string, unknown>;
  readonly excerpt: string | null;
}

/**
 * Parse one stored entry, or return undefined for anything unreadable.
 *
 * Unreadable covers a corrupt value, a foreign key collision, and an
 * envelope from a future build. All three are MISSES: a cell that falls
 * through to a live capture costs a vendor call, while a cell suppressed
 * against an entry we could not read costs a row that can never be scored.
 */
export function parseL1Envelope(raw: string): L1Envelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as Partial<L1Envelope>;
  if (candidate.v !== 1) return undefined;
  if (typeof candidate.contentHash !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.contentHash)) return undefined;
  if (typeof candidate.payload !== "object" || candidate.payload === null || Array.isArray(candidate.payload)) {
    return undefined;
  }
  const excerpt = candidate.excerpt;
  if (excerpt !== null && typeof excerpt !== "string") return undefined;
  return { v: 1, contentHash: candidate.contentHash, payload: candidate.payload, excerpt: excerpt ?? null };
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
    const envelope = parseL1Envelope(value);
    if (envelope === undefined) return;
    const contentHash = Buffer.from(envelope.contentHash, "hex");
    for (const candidate of cellsByKey.get(key) ?? []) {
      hits.set(cellKey(candidate), {
        promptId: candidate.promptId,
        engineKey: candidate.engineKey,
        sampleIndex: candidate.sampleIndex,
        contentHash,
        payload: envelope.payload,
        excerpt: envelope.excerpt,
      });
    }
  });

  return hits;
}

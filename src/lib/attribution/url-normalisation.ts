import { InvalidLandingUrlError, normalizeLanding } from "./beacon-dimensions.js";

// STORY-114 J2 / J3 - the rollup's join key.
//
// THERE IS ONE NORMALISATION. `normalizeCitationUrl` (src/lib/parser/citation-url.ts) is what stamps `citation_facts.url_hash`;
// the beacon reaches it through `normalizeLanding`; and the rollup reaches it through `joinUrlKey` below, applied to the stored URL
// STRING of every source (citation, beacon, Search Console) rather than to a stored hash. Re-keying from the string is what makes a
// rebuild effective after the normalisation changes: a stored hash would carry the OLD key forever.

/**
 * The version of the normalisation the join key comes from. A change to `normalizeCitationUrl`'s output re-partitions every historical
 * row, so it is a VERSIONED change: bump this, record the new digest in url-normalisation.spec.ts (it fails until you do), and rebuild
 * every project's rollup with the `attribution.rollup` job's `rebuild` payload. `citation_facts.url_hash` written under the old
 * version is not rewritten (the rollup re-derives its key from `normalized_url`), so the rebuild is enough.
 */
export const URL_NORMALISATION_VERSION = 1;

/** Inputs whose normalised form is pinned by version in the spec: the documented steps, one per line. */
export const URL_NORMALISATION_GOLDEN: readonly string[] = Object.freeze([
  "https://shop.example.com/guide",
  "https://shop.example.com/guide/",
  "https://SHOP.Example.COM/guide",
  "https://www.shop.example.com/guide",
  "https://shop.example.com:443/guide",
  "http://shop.example.com:80/guide",
  "https://shop.example.com/guide?utm_source=chatgpt.com&utm_medium=ai&gclid=abc&fbclid=1",
  "https://shop.example.com/guide?ref=home&page=2",
  "https://shop.example.com/guide#section",
  "https://shop.example.com/guide#:~:text=quoted%20passage",
  "https://shop.example.com",
  "https://shop.example.com/",
]);

export interface JoinUrlKey {
  readonly url: string;
  readonly hash: Buffer;
}

/** The normalised URL and its hash, or `null` for a string that is not an absolute http(s) URL (skipped, never joined wrongly). */
export function joinUrlKey(raw: string): JoinUrlKey | null {
  try {
    return normalizeLanding(raw);
  } catch (error) {
    if (error instanceof InvalidLandingUrlError) return null;
    throw error;
  }
}

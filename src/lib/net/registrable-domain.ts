import { parse } from "tldts";

// STORY-131 — api-specification.md §4.1: root_url is "normalised to its
// registrable domain, which becomes root_domain".
//
// tldts, not the last two labels. `bbc.co.uk` has a two-label public suffix, so
// naive splitting yields `co.uk` — and every .com.au and .co.jp customer
// collapses into a single root_domain. root_domain drives owned-citation share
// and tenant-visible brand matching, so that is a data-correctness bug, not a
// cosmetic one. The dependency was signed off for exactly this reason.

/** A URL whose registrable domain could not be derived — not a real site. */
export class UnparsableHostError extends Error {
  constructor(readonly input: string) {
    super("could not derive a registrable domain");
    this.name = "UnparsableHostError";
  }
}

/**
 * The registrable domain for a URL — `https://www.bbc.co.uk/news?utm_source=x`
 * gives `bbc.co.uk`.
 *
 * Returns the domain only. The query, fragment, path, port, and any `www.` are
 * discarded by construction rather than stripped one at a time: tldts reads the
 * host, and everything else in the URL is simply not consulted. A stripping
 * approach needs a rule per tracking-parameter family and grows one every time
 * someone finds a new one.
 */
export function toRegistrableDomain(input: string): string {
  const parsed = parse(input, { allowPrivateDomains: false });
  // `domain` is null for an IP literal, an unlisted TLD, or a bare public
  // suffix (`https://co.uk/` — a real string a caller can send, and not a site
  // anyone owns).
  if (parsed.domain === null || parsed.domain === "") throw new UnparsableHostError(input);
  return parsed.domain.toLowerCase();
}

/** True when the URL's host is an IP literal rather than a name. */
export function hostIsIpLiteral(input: string): boolean {
  const parsed = parse(input, { allowPrivateDomains: false });
  return parsed.hostname !== null && parsed.isIp === true;
}

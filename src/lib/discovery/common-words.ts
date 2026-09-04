// STORY-043 AC16 — "common-word brand names are detected against a dictionary
// and negative aliases are proposed automatically".
//
// The story explains why this small feature matters: "A brand named after an
// ordinary word will otherwise match prose from the first capture, and the
// customer's first impression is a matrix full of false positives." A project
// called Apron, Notion, Slack or Square matches every engine answer that uses
// the word in its ordinary sense, and every one of those is scored as a
// mention.
//
// A CURATED LIST, not a downloaded corpus. The requirement is not "is this an
// English word" — it is "would this word appear in prose about this brand's
// category anyway". A full dictionary would flag `Adobe` (a building material
// nobody discusses near software) while missing `Notion` if the list happened
// to omit it. These are the words that actually collide, kept short enough to
// read in a diff.

/**
 * Ordinary words that are also well-known brand names, or that read as generic
 * nouns in the sentences engines write.
 */
const COMMON_WORDS = new Set([
  // Ordinary nouns and verbs used as brand names.
  "apple", "amazon", "square", "stripe", "slack", "notion", "figma", "linear", "arc", "brave",
  "sonos", "shopify", "monday", "asana", "drift", "gong", "loom", "miro", "canva", "webflow",
  "ghost", "medium", "patch", "signal", "orbit", "atlas", "prism", "beacon", "anchor", "compass",
  // Words that are simply generic in any sentence about a product.
  "base", "box", "buffer", "bump", "chase", "close", "core", "craft", "dash", "digit",
  "flow", "focus", "forge", "front", "grain", "grid", "hive", "hub", "index", "intercom",
  "lattice", "layer", "lever", "lift", "link", "list", "loop", "mark", "mesh", "mint",
  "nest", "node", "north", "orange", "pace", "pass", "peak", "pilot", "pitch", "pivot",
  "plane", "plate", "point", "pulse", "range", "reach", "relay", "render", "rise", "root",
  "route", "scale", "scope", "shift", "shore", "sift", "slate", "spark", "spring", "stack",
  "stem", "stone", "storm", "stream", "strike", "swift", "tempo", "thread", "tide", "trace",
  "track", "trust", "vault", "verge", "vine", "wave", "wire", "zone",
]);

/** True when this brand name is an ordinary word that will collide with prose. */
export function isCommonWordBrand(brandName: string): boolean {
  const normalized = brandName.trim().toLowerCase();
  // Only SINGLE-word names collide. "Square Payments" is already unambiguous
  // in prose, and flagging it would propose negatives that suppress real
  // mentions — the opposite failure, and the more damaging one.
  if (normalized === "" || /\s/.test(normalized)) return false;
  return COMMON_WORDS.has(normalized);
}

/**
 * Negative aliases for a common-word brand — strings that must NEVER count as
 * a mention (api-specification.md §4.1).
 *
 * Proposed, never applied. §4.5's rule is that nothing discovered is applied
 * without appearing in the review payload with a confidence, and a negative
 * alias is the one kind of discovered value where a false positive SUPPRESSES
 * real data. It goes in front of a human.
 *
 * The phrases are the ordinary-sense uses: the bare lowercase word preceded by
 * an article or a preposition. `"the notion"` and `"a notion"` are prose;
 * `"Notion"` alone may well be the product.
 */
export function proposeNegativeAliases(brandName: string): string[] {
  if (!isCommonWordBrand(brandName)) return [];
  const word = brandName.trim().toLowerCase();
  return [`the ${word}`, `a ${word}`, `${word} of`, `${word} that`];
}

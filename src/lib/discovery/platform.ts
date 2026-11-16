import type { FingerprintPlatform } from "../../../contracts/projects/index.js";

// STORY-195 / FR-ONB-04 - which site platform a page was built on, read from the ONE document the fingerprint already holds. PURE: nothing here fetches.
//
// A platform is named only when a MARKER was found, and a marker counts only INSIDE a tag (a declared generator, or an asset URL in a src/href): prose that
// mentions "WordPress" or "cdn.shopify.com" is not a detection. Two readings:
//   a declared `<meta name="generator">`   0.95  the site says so itself
//   an asset URL only that platform serves 0.85  strong, but a site can embed another platform's asset
// Two DIFFERENT platforms at the strongest strength are ambiguous (a headless site with a Shopify buy button and a WordPress blog): none is named, because
// a wrong platform steers the user to a wrong "connect later" affordance.

export interface PlatformReading {
  readonly value: FingerprintPlatform;
  readonly confidence: number;
}

export const GENERATOR_CONFIDENCE = 0.95;
const ASSET_CONFIDENCE = 0.85;

const GENERATORS: ReadonlyArray<readonly [FingerprintPlatform, RegExp]> = [
  ["wordpress", /^\s*WordPress/i],
  ["wix", /^\s*Wix\.com/i],
  ["squarespace", /^\s*Squarespace/i],
  ["webflow", /^\s*Webflow/i],
  ["shopify", /^\s*Shopify/i],
  ["ghost", /^\s*Ghost/i],
  ["drupal", /^\s*Drupal/i],
  ["joomla", /^\s*Joomla/i],
  ["framer", /^\s*Framer/i],
  ["hubspot", /^\s*HubSpot/i],
];

const ASSETS: ReadonlyArray<readonly [FingerprintPlatform, RegExp]> = [
  ["wordpress", /\/wp-content\/|\/wp-includes\//i],
  ["shopify", /cdn\.shopify\.com|\.myshopify\.com/i],
  ["wix", /wixstatic\.com|parastorage\.com/i],
  ["squarespace", /static1\.squarespace\.com|squarespace-cdn\.com|sqspcdn\.com/i],
  ["webflow", /website-files\.com|\sdata-wf-(?:page|site)=/i],
  ["framer", /framerusercontent\.com/i],
  ["drupal", /\/sites\/default\/files\/|\/core\/misc\/drupal\.js/i],
  ["joomla", /\/media\/system\/js\/|\/components\/com_/i],
  ["hubspot", /\/_hcms\/|\.hs-sites\.com/i],
];

// `[^<>]*` (not `[^>]*`): a tag body can hold no `<`, so an unterminated `<a <a <a ...` fails at the next `<` and the scan stays LINEAR. With `[^>]*` every
// unterminated opener scanned to the end of the document (quadratic: 256 KB took 8.5 s), on the request thread.
const TAG_RE = /<(?:meta|link|script|img|a|iframe|source)\b[^<>]*>/gi;
/** Markers live in the head and early body; only this prefix is read, so the work is bounded whatever the fetcher returned. */
export const PLATFORM_SCAN_LIMIT_CHARS = 1024 * 1024;
const META_GENERATOR_RE = /<meta\b[^>]*>/i;

function generatorOf(tag: string): string | undefined {
  if (!/\bname\s*=\s*["']generator["']/i.test(tag)) return undefined;
  return /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
}

/** The platform a page declares or shows, or `undefined` when no marker was found or the markers disagree. */
export function detectPlatform(html: string): PlatformReading | undefined {
  const found = new Map<FingerprintPlatform, number>();
  const note = (platform: FingerprintPlatform, confidence: number): void => {
    found.set(platform, Math.max(found.get(platform) ?? 0, confidence));
  };

  for (const tag of html.slice(0, PLATFORM_SCAN_LIMIT_CHARS).match(TAG_RE) ?? []) {
    if (META_GENERATOR_RE.test(tag)) {
      const declared = generatorOf(tag);
      if (declared !== undefined) {
        for (const [platform, pattern] of GENERATORS) if (pattern.test(declared)) note(platform, GENERATOR_CONFIDENCE);
      }
    }
    for (const [platform, pattern] of ASSETS) if (pattern.test(tag)) note(platform, ASSET_CONFIDENCE);
  }

  if (found.size === 0) return undefined;
  const strongest = Math.max(...found.values());
  const top = [...found.entries()].filter(([, confidence]) => confidence === strongest);
  return top.length === 1 ? { value: top[0]![0], confidence: strongest } : undefined;
}

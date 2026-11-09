import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCitationUrl } from "../parser/citation-url.js";
import { normalizeLanding } from "./beacon-dimensions.js";
import { joinUrlKey, URL_NORMALISATION_VERSION, URL_NORMALISATION_GOLDEN } from "./url-normalisation.js";

// STORY-114 J2 / J3 - the join key is ONE normalisation, versioned.

const PAGE = "https://shop.example.com/guide";
const VARIANTS = [
  PAGE,
  "https://shop.example.com/guide/", // trailing slash
  "https://SHOP.Example.COM/guide", // host case
  "https://www.shop.example.com/guide", // www
  "https://shop.example.com:443/guide", // default port
  "https://shop.example.com/guide?utm_source=chatgpt.com&utm_medium=ai&gclid=abc", // documented tracking strip
  "https://shop.example.com/guide#section-2", // fragment
];

describe("STORY-114 S2 - the variants join to one key", () => {
  it("every variant, on the citation side and the beacon side, hashes identically", () => {
    const keys = new Set<string>();
    for (const variant of VARIANTS) {
      keys.add(joinUrlKey(variant)!.hash.toString("hex"));
      keys.add(normalizeLanding(variant).hash.toString("hex"));
      keys.add(normalizeCitationUrl(variant).urlHash.toString("hex"));
    }
    expect(keys.size).toBe(1);
  });
  it("an unparsable or non-http URL has no key, so it is skipped rather than joined wrongly", () => {
    expect(joinUrlKey("not a url")).toBeNull();
    expect(joinUrlKey("ftp://shop.example.com/x")).toBeNull();
  });
  it("genuinely different pages keep different keys (a tracking strip does not merge pages)", () => {
    expect(joinUrlKey(`${PAGE}?page=2`)!.hash.equals(joinUrlKey(PAGE)!.hash)).toBe(false);
    expect(joinUrlKey("https://shop.example.com/pricing")!.hash.equals(joinUrlKey(PAGE)!.hash)).toBe(false);
  });
});

describe("STORY-114 S3 - one shared function", () => {
  it("the join key is the citation normaliser's hash, and no file in the attribution library hashes a URL itself", () => {
    expect(joinUrlKey(PAGE)!.hash.equals(normalizeCitationUrl(PAGE).urlHash)).toBe(true);
    for (const file of ["url-normalisation.ts", "rollup-join.ts", "attribution-rollup.ts", "beacon-dimensions.ts"]) {
      const text = readFileSync(join(__dirname, file), "utf8");
      expect(text, file).not.toMatch(/createHash|\.searchParams\.delete|toLowerCase\(\)\s*\.\s*replace\(\s*\/\^www/);
    }
  });
});

describe("STORY-114 S4 - a normalisation change is a versioned change", () => {
  const digest = (): string => createHash("sha256").update(URL_NORMALISATION_GOLDEN.map((raw) => normalizeCitationUrl(raw).normalized).join("\n")).digest("hex");

  // When this fails the normalisation changed. Bump URL_NORMALISATION_VERSION, add the new digest below (keep the old ones), and
  // rebuild every project's rollup (the `rebuild` job payload): a change silently re-partitions every historical row.
  const KNOWN_DIGESTS: Readonly<Record<number, string>> = {
    1: "e5b5575ef834ad44a431f1e0fbceab366881f3edc37a2e9bd82483e6d021366d",
  };

  it("the current output matches the digest recorded for the current version", () => {
    expect(KNOWN_DIGESTS[URL_NORMALISATION_VERSION], "no digest recorded for this version").toBeDefined();
    expect(digest()).toBe(KNOWN_DIGESTS[URL_NORMALISATION_VERSION]);
  });
  it("the version is a positive integer", () => {
    expect(Number.isInteger(URL_NORMALISATION_VERSION) && URL_NORMALISATION_VERSION >= 1).toBe(true);
  });
});

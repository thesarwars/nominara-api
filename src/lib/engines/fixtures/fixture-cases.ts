import type { RawCapture } from "../contract.js";

// STORY-027 AC9 — fixture coverage per engine: a normal answer, a refusal,
// an empty answer, a truncated answer, a redirect-heavy citation set, and a
// priced-product element.
export const FIXTURE_CASES = [
  "normal",
  "refusal",
  "empty",
  "truncated",
  "redirect_heavy_citations",
  "priced_product_element",
] as const;

export type FixtureCase = (typeof FIXTURE_CASES)[number];

export type FixturePayloadSet = Record<FixtureCase, RawCapture>;

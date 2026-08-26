import type { FixturePayloadSet } from "../fixture-cases.js";

// STORY-027 D1 — hand-authored, NOT recorded from a real vendor response.
// See perplexity.ts's header for the full provenance note.
//
// chatgpt — tracking-engine.md §3: inline URLs, extracted by the citation
// pass. `structuredCitations` is absent on `normal`; URLs live in `text`.
export const chatgptFixtures: FixturePayloadSet = {
  normal: {
    text: "For a 50-person startup, consider HubSpot (https://www.hubspot.com/products/crm) for its free tier, or Pipedrive (https://www.pipedrive.com) for a simpler pipeline view.",
    format: "markdown",
    modelFingerprint: "gpt-4.1-mini-2025-04",
    truncated: false,
    responseTokensEst: 210,
    latencyMs: 6100,
    vendorRequestId: "oai-req-normal-0001",
    costUsd: 0.006,
  },
  refusal: {
    text: "I can't provide a ranked opinion on which CRM is best for your company.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 16,
    latencyMs: 3200,
    costUsd: 0.001,
    flags: ["engine_refused_to_answer"],
  },
  empty: {
    text: "",
    format: "markdown",
    truncated: false,
    responseTokensEst: 0,
    latencyMs: 2400,
    costUsd: 0.001,
    flags: ["empty_answer"],
  },
  truncated: {
    text: "A few CRMs suit a 50-person startup: HubSpot (https://www.hubspot.com) offers a free tier and strong marketing tooling, Pipedrive (https://www.pipedrive.com) keeps the pipeline visual and lean, and Zoho (https://www.zoho.com/crm",
    format: "markdown",
    truncated: true,
    responseTokensEst: 480,
    latencyMs: 14_200,
    costUsd: 0.009,
  },
  redirect_heavy_citations: {
    text: "See these vendor comparisons: https://www.bing.com/ck/a?u=vendor-a and https://www.bing.com/ck/a?u=vendor-b and https://www.bing.com/ck/a?u=vendor-c for more detail.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 190,
    latencyMs: 6800,
    costUsd: 0.006,
  },
  priced_product_element: {
    text: "HubSpot's Starter plan runs about $20/month per seat, while Pipedrive starts near $14/month per seat — see https://www.hubspot.com/pricing.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 88,
    latencyMs: 5900,
    costUsd: 0.005,
  },
};

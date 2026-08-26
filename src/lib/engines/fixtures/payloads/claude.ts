import type { FixturePayloadSet } from "../fixture-cases.js";

// STORY-027 D1 — hand-authored, NOT recorded from a real vendor response.
// See perplexity.ts's header for the full provenance note.
//
// claude — tracking-engine.md §3: inline URLs and titles. `structuredCitations`
// is absent on `normal`; URLs live in `text`.
export const claudeFixtures: FixturePayloadSet = {
  normal: {
    text: "A 50-person startup is often well served by HubSpot CRM (hubspot.com/products/crm) for its free entry tier, or Pipedrive (pipedrive.com) for a lean, visual pipeline.",
    format: "markdown",
    modelFingerprint: "claude-3-7-sonnet-2025-05",
    truncated: false,
    responseTokensEst: 260,
    latencyMs: 6900,
    vendorRequestId: "anthropic-req-normal-0001",
    costUsd: 0.015,
  },
  refusal: {
    text: "I'd rather not rank specific commercial products against each other here.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 15,
    latencyMs: 3400,
    costUsd: 0.002,
    flags: ["engine_refused_to_answer"],
  },
  empty: {
    text: "",
    format: "markdown",
    truncated: false,
    responseTokensEst: 0,
    latencyMs: 2600,
    costUsd: 0.001,
    flags: ["empty_answer"],
  },
  truncated: {
    text: "Several CRMs suit a 50-person startup: HubSpot (hubspot.com) for its generous free tier, Pipedrive (pipedrive.com) for pipeline simplicity, and Zoho (zoho.com/crm) for budget-conscious teams th",
    format: "markdown",
    truncated: true,
    responseTokensEst: 505,
    latencyMs: 16_000,
    costUsd: 0.021,
  },
  redirect_heavy_citations: {
    text: "A few independent comparisons are worth reading: duckduckgo.com/l/?uddg=vendor-a, duckduckgo.com/l/?uddg=vendor-b, and duckduckgo.com/l/?uddg=vendor-c.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 175,
    latencyMs: 7500,
    costUsd: 0.013,
  },
  priced_product_element: {
    text: "HubSpot's Starter tier is priced around $20/month per seat; Pipedrive starts near $14/month per seat (pipedrive.com/pricing).",
    format: "markdown",
    truncated: false,
    responseTokensEst: 90,
    latencyMs: 6700,
    costUsd: 0.012,
  },
};

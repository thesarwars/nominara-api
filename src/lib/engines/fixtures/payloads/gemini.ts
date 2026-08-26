import type { FixturePayloadSet } from "../fixture-cases.js";

// STORY-027 D1 — hand-authored, NOT recorded from a real vendor response.
// See perplexity.ts's header for the full provenance note.
//
// gemini — tracking-engine.md §3: grounding metadata; "redirect URIs must be
// resolved [by the parser] or every citation collapses to one vendor
// domain." `redirect_heavy_citations` below deliberately reproduces that
// collapse (>= 3 citations sharing one vendor grounding host) — resolving
// it is a future parser concern (worker-parse stage 3), not this adapter's.
export const geminiFixtures: FixturePayloadSet = {
  normal: {
    text: "For a 50-person startup, HubSpot and Pipedrive are frequently recommended CRMs, balancing ease of use with room to grow.",
    format: "markdown",
    structuredCitations: [
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/aaa1", title: "HubSpot CRM", slot: 1 },
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/bbb2", title: "Pipedrive", slot: 2 },
    ],
    modelFingerprint: "gemini-2.5-flash-2025-05",
    truncated: false,
    responseTokensEst: 230,
    latencyMs: 4400,
    vendorRequestId: "gemini-req-normal-0001",
    costUsd: 0.007,
  },
  refusal: {
    text: "I don't have a personal recommendation to offer on that.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 13,
    latencyMs: 2100,
    costUsd: 0.001,
    flags: ["engine_refused_to_answer"],
  },
  empty: {
    text: "",
    format: "markdown",
    truncated: false,
    responseTokensEst: 0,
    latencyMs: 1900,
    costUsd: 0.001,
    flags: ["empty_answer"],
  },
  truncated: {
    text: "A 50-person startup has several strong CRM options: HubSpot for its free entry tier and marketing tools, Pipedrive for a lean visual pipeline, and Zoho for cost-conscious te",
    format: "markdown",
    structuredCitations: [{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ccc3", slot: 1 }],
    truncated: true,
    responseTokensEst: 498,
    latencyMs: 11_000,
    costUsd: 0.011,
  },
  redirect_heavy_citations: {
    // >= 3 citations collapsing to the SAME vendor grounding host — the
    // exact failure mode NFR-SIM's redirect-resolution requirement guards
    // against, reproduced deliberately for the parser to resolve later.
    text: "Several sources compare CRM vendors for growing teams.",
    format: "markdown",
    structuredCitations: [
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ddd4", slot: 1 },
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/eee5", slot: 2 },
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/fff6", slot: 3 },
      { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/ggg7", slot: 4 },
    ],
    truncated: false,
    responseTokensEst: 260,
    latencyMs: 4600,
    costUsd: 0.008,
  },
  priced_product_element: {
    text: "HubSpot's Starter plan is about $20/month per seat, and Pipedrive starts around $14/month per seat.",
    format: "markdown",
    structuredCitations: [{ url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/hhh8", slot: 1 }],
    truncated: false,
    responseTokensEst: 92,
    latencyMs: 4200,
    costUsd: 0.007,
  },
};

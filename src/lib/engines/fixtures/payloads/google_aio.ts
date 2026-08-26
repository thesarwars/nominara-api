import type { FixturePayloadSet } from "../fixture-cases.js";

// STORY-027 D1 — hand-authored, NOT recorded from a real vendor response.
// See perplexity.ts's header for the full provenance note.
//
// google_aio — tracking-engine.md §3: `references[]` (source, domain, url,
// title, text), same shape as google_ai_mode's, carried here as
// `structuredCitations`. Typed elements (`ai_overview_element`,
// `table_element`, `shopping_element`, `images`) are AI Mode only — this
// engine's payloads never carry `structuredElements`. A price comparison
// renders as a paragraph here (§3's "the format differs by intent"),
// never a shopping element.
export const googleAioFixtures: FixturePayloadSet = {
  normal: {
    text: "For a 50-person startup, HubSpot and Pipedrive are commonly recommended CRM platforms.",
    format: "markdown",
    structuredCitations: [
      { url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM", snippet: "Free CRM for growing teams.", slot: 1 },
      { url: "https://www.pipedrive.com", title: "Pipedrive", snippet: "Sales CRM built for salespeople.", slot: 2 },
    ],
    modelFingerprint: "aio-2025-05",
    truncated: false,
    responseTokensEst: 180,
    latencyMs: 3000,
    vendorRequestId: "serp-aio-req-normal-0001",
    costUsd: 0.004,
  },
  refusal: {
    text: "No AI Overview opinion is available for this query.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 10,
    latencyMs: 1400,
    costUsd: 0.001,
    flags: ["engine_refused_to_answer"],
  },
  empty: {
    text: "",
    format: "markdown",
    truncated: false,
    responseTokensEst: 0,
    latencyMs: 1100,
    costUsd: 0.001,
    flags: ["empty_answer"],
  },
  truncated: {
    text: "Several CRMs suit a 50-person startup, including HubSpot for its free tier and Pipedrive for a simple, visua",
    format: "markdown",
    structuredCitations: [{ url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM", slot: 1 }],
    truncated: true,
    responseTokensEst: 260,
    latencyMs: 12_000,
    costUsd: 0.005,
  },
  redirect_heavy_citations: {
    text: "Multiple review sites compare CRM vendors for growing teams.",
    format: "markdown",
    structuredCitations: [
      { url: "https://www.google.com/url?q=https://vendor-a.example.com/review", slot: 1 },
      { url: "https://www.google.com/url?q=https://vendor-b.example.com/review", slot: 2 },
      { url: "https://www.google.com/url?q=https://vendor-c.example.com/review", slot: 3 },
    ],
    truncated: false,
    responseTokensEst: 150,
    latencyMs: 3200,
    costUsd: 0.004,
  },
  // NO shopping_element / structuredElements — a price comparison is a
  // paragraph on this engine (tracking-engine.md §3's "two Google surfaces
  // diverge" — priced product elements are AI Mode only).
  priced_product_element: {
    text: "HubSpot's Starter plan costs about $20 per month per seat, while Pipedrive starts near $14 per month per seat.",
    format: "markdown",
    structuredCitations: [{ url: "https://www.hubspot.com/pricing", title: "HubSpot Pricing", slot: 1 }],
    truncated: false,
    responseTokensEst: 90,
    latencyMs: 2900,
    costUsd: 0.004,
  },
};

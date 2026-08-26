import type { FixturePayloadSet } from "../fixture-cases.js";

// STORY-027 D1 — hand-authored, NOT recorded from a real vendor response.
// See perplexity.ts's header for the full provenance note.
//
// google_ai_mode — tracking-engine.md §3: `references[]` plus per-element
// `links[]`. Typed elements: `ai_overview_element`, `table_element`,
// `shopping_element`, `images`. "Always returns an answer" — priced product
// elements are AI Mode ONLY (§3, §5), so `priced_product_element` below
// carries a `shopping_element`, unlike google_aio's paragraph-only case.
export const googleAiModeFixtures: FixturePayloadSet = {
  normal: {
    text: "For a 50-person startup, HubSpot and Pipedrive are commonly recommended CRM platforms, each with distinct strengths.",
    format: "markdown",
    structuredCitations: [
      { url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM", snippet: "Free CRM for growing teams.", slot: 1 },
      { url: "https://www.pipedrive.com", title: "Pipedrive", snippet: "Sales CRM built for salespeople.", slot: 2 },
      { url: "https://www.capterra.com/crm-software/", title: "CRM Software Reviews", slot: 3 },
    ],
    structuredElements: [
      {
        kind: "ai_overview_element",
        links: [
          { url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM" },
          { url: "https://www.pipedrive.com", title: "Pipedrive" },
        ],
        description: "A comparison of CRM platforms suited to a 50-person startup.",
      },
    ],
    modelFingerprint: "ai-mode-2025-05",
    truncated: false,
    responseTokensEst: 300,
    latencyMs: 4200,
    vendorRequestId: "serp-aim-req-normal-0001",
    costUsd: 0.006,
  },
  refusal: {
    text: "No AI Mode opinion is available for this query.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 10,
    latencyMs: 1600,
    costUsd: 0.001,
    flags: ["engine_refused_to_answer"],
  },
  empty: {
    text: "",
    format: "markdown",
    truncated: false,
    responseTokensEst: 0,
    latencyMs: 1300,
    costUsd: 0.001,
    flags: ["empty_answer"],
  },
  truncated: {
    text: "Several CRMs suit a 50-person startup, including HubSpot for its free tier and Pipedrive for a simple, visual pipel",
    format: "markdown",
    structuredCitations: [{ url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM", slot: 1 }],
    structuredElements: [
      {
        kind: "ai_overview_element",
        links: [{ url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM" }],
        description: "A comparison of CRM platforms, cut off mid-summary.",
      },
    ],
    truncated: true,
    responseTokensEst: 300,
    latencyMs: 15_000,
    costUsd: 0.008,
  },
  redirect_heavy_citations: {
    text: "Multiple review sites compare CRM vendors for growing teams.",
    format: "markdown",
    structuredCitations: [
      { url: "https://www.google.com/url?q=https://vendor-a.example.com/review", slot: 1 },
      { url: "https://www.google.com/url?q=https://vendor-b.example.com/review", slot: 2 },
      { url: "https://www.google.com/url?q=https://vendor-c.example.com/review", slot: 3 },
    ],
    structuredElements: [
      {
        kind: "table_element",
        links: [
          { url: "https://www.google.com/url?q=https://vendor-a.example.com/review" },
          { url: "https://www.google.com/url?q=https://vendor-b.example.com/review" },
          { url: "https://www.google.com/url?q=https://vendor-c.example.com/review" },
        ],
      },
    ],
    truncated: false,
    responseTokensEst: 220,
    latencyMs: 4600,
    costUsd: 0.006,
  },
  priced_product_element: {
    text: "HubSpot's Starter plan is $20/month per seat; Pipedrive starts at $14/month per seat.",
    format: "markdown",
    structuredCitations: [
      { url: "https://www.hubspot.com/pricing", title: "HubSpot Pricing", slot: 1 },
      { url: "https://www.pipedrive.com/en/pricing", title: "Pipedrive Pricing", slot: 2 },
    ],
    structuredElements: [
      {
        kind: "shopping_element",
        links: [{ url: "https://www.hubspot.com/pricing", title: "HubSpot Pricing" }],
        price: "$20.00",
        rating: 4.4,
        reviewCount: 3800,
        availability: "in_stock",
        description: "HubSpot Starter — CRM Suite",
      },
      {
        kind: "shopping_element",
        links: [{ url: "https://www.pipedrive.com/en/pricing", title: "Pipedrive Pricing" }],
        price: "$14.00",
        rating: 4.5,
        reviewCount: 2900,
        availability: "in_stock",
        description: "Pipedrive Essential",
      },
    ],
    truncated: false,
    responseTokensEst: 95,
    latencyMs: 4000,
    costUsd: 0.006,
  },
};

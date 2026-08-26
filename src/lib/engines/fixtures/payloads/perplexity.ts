import type { FixturePayloadSet } from "../fixture-cases.js";

// STORY-027 D1 — hand-authored, NOT recorded from a real vendor response.
// The pre-flight capture story (STORY-001/EPIC-00) that AC9 assumes never
// ran. A follow-up story replaces this file wholesale with real recorded
// payloads once it does.
//
// perplexity — tracking-engine.md §3: "the reference engine for
// citation-accuracy validation." Structured citation array is the highest
// fidelity of any engine, so `normal` carries a non-empty
// `structuredCitations` array.
export const perplexityFixtures: FixturePayloadSet = {
  normal: {
    text: "For a 50-person startup, HubSpot and Pipedrive are the two most commonly recommended CRMs, with HubSpot favoured for its free tier and Pipedrive for pipeline simplicity.",
    format: "markdown",
    structuredCitations: [
      { url: "https://www.g2.com/categories/crm", title: "Best CRM Software", snippet: "Compare top-rated CRM platforms.", slot: 1 },
      { url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM", snippet: "Free CRM for growing teams.", slot: 2 },
      { url: "https://www.capterra.com/crm-software/", title: "CRM Software Reviews", snippet: "User reviews and ratings.", slot: 3 },
    ],
    modelFingerprint: "sonar-medium-2025-06",
    truncated: false,
    responseTokensEst: 340,
    latencyMs: 3050,
    vendorRequestId: "ppx-req-normal-0001",
    costUsd: 0.012,
  },
  refusal: {
    text: "I'm not able to give a personal opinion on that comparison.",
    format: "markdown",
    truncated: false,
    responseTokensEst: 14,
    latencyMs: 1800,
    costUsd: 0.002,
    flags: ["engine_refused_to_answer"],
  },
  empty: {
    text: "",
    format: "markdown",
    truncated: false,
    responseTokensEst: 0,
    latencyMs: 1200,
    costUsd: 0.001,
    flags: ["empty_answer"],
  },
  truncated: {
    text: "Several CRMs suit a 50-person startup, including HubSpot, Pipedrive, and Zoho — HubSpot offers a generous free tier and strong marketing tooling, while Pipedrive focuses on a lean, visual pipel",
    format: "markdown",
    structuredCitations: [{ url: "https://www.hubspot.com/products/crm", title: "HubSpot CRM", slot: 1 }],
    truncated: true,
    responseTokensEst: 512,
    latencyMs: 7900,
    costUsd: 0.018,
  },
  redirect_heavy_citations: {
    text: "Several independent review sites compare CRM vendors for growing teams; see the sources below.",
    format: "markdown",
    structuredCitations: [
      { url: "https://www.google.com/url?q=https://vendor-a.example.com/review", slot: 1 },
      { url: "https://www.google.com/url?q=https://vendor-b.example.com/review", slot: 2 },
      { url: "https://www.google.com/url?q=https://vendor-c.example.com/review", slot: 3 },
    ],
    truncated: false,
    responseTokensEst: 280,
    latencyMs: 3400,
    costUsd: 0.011,
  },
  priced_product_element: {
    text: "HubSpot's Starter plan is priced at $20/month per seat, while Pipedrive starts at $14/month per seat.",
    format: "markdown",
    structuredCitations: [{ url: "https://www.hubspot.com/pricing", title: "HubSpot Pricing", slot: 1 }],
    truncated: false,
    responseTokensEst: 96,
    latencyMs: 2900,
    costUsd: 0.009,
  },
};

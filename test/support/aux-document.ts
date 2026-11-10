import type { AuxDocument, AuxVariant, ContentBlock } from "../../src/lib/aux/document-model.js";

// STORY-051 — hand-built document models for rule tests. Building the object directly (rather than from HTML) is what lets a test
// put a section at exactly 1,800 tokens: the boundary is the point of every rule test.

export const PAGE_URL = "https://example.com/products/acme";

export const CLEAN_JSON_LD: unknown[] = [
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Acme",
    url: "https://example.com",
    logo: "https://example.com/logo.png",
    sameAs: ["https://www.linkedin.com/company/acme"],
    description: "Acme makes widgets.",
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Acme Widgets",
    featureList: ["Pipeline analytics", "Workflow automation"],
    offers: { "@type": "Offer", price: "47.00", priceCurrency: "USD" },
    aggregateRating: { "@type": "AggregateRating", ratingValue: "4.6", reviewCount: "120" },
    dateModified: "2026-10-01",
  },
];

export const CLEAN_TEXT =
  "Acme Widgets\nAcme Widgets starts at $47 per month. Rated 4.6/5 from 120 reviews.\nPipeline analytics\nSee every deal.\nWorkflow automation\nAutomate follow-ups.\nLast updated: 2026-10-01";

export function block(over: Partial<ContentBlock> = {}): ContentBlock {
  return {
    heading: "Section",
    level: 2,
    tokens: 100,
    // No structure by default: the whole section is one run. A test that wants a break sets both.
    longestUnstructuredTokens: over.longestUnstructuredTokens ?? over.tokens ?? 100,
    sentences: { count: 4, meanWords: 12, maxWords: 20 },
    longestParagraphChars: 200,
    tables: 0,
    lists: { ordered: 0, unordered: 0, definition: 0 },
    codeSpans: 0,
    ...over,
  };
}

export function variant(over: Partial<AuxVariant> = {}): AuxVariant {
  return {
    html: "<html><body><main><h1>Acme Widgets</h1></main></body></html>",
    mainText: CLEAN_TEXT,
    tokenCount: 1000,
    mainTokenCount: 800,
    headingTree: [
      {
        level: 1,
        text: "Acme Widgets",
        children: [
          { level: 2, text: "Pipeline analytics", children: [] },
          { level: 2, text: "Workflow automation", children: [] },
        ],
      },
    ],
    structured: { jsonLd: CLEAN_JSON_LD, microdata: [], rdfa: [], parseErrors: [] },
    ...over,
  };
}

/** A page that no rule fires on. Each test changes one thing. */
export function makeDoc(over: Partial<AuxDocument> & { raw?: AuxVariant; rendered?: AuxVariant | null } = {}): AuxDocument {
  const raw = over.raw ?? variant();
  const rendered = over.rendered === undefined ? raw : over.rendered;
  return {
    url: PAGE_URL,
    finalUrl: PAGE_URL,
    httpStatus: 200,
    redirectChain: [],
    headers: {},
    raw,
    rendered,
    structured: (rendered ?? raw).structured,
    meta: { title: "Acme Widgets | Acme", googlebotNoSnippet: false, hreflang: [], directives: [], dateModified: "2026-10-01" },
    blocks: [
      block({ heading: "Acme Widgets", level: 1, tokens: 60, tables: 1 }),
      block({ heading: "Pipeline analytics" }),
      block({ heading: "Workflow automation" }),
    ],
    links: { internal: 5, external: 1, nofollow: 0 },
    media: { images: 0, imagesWithAlt: 0 },
    timing: { ttfbMs: 200, loadMs: 1000, bytes: 100_000 },
    tokenizer: { name: "test-words", version: "0" },
    ...over,
  };
}

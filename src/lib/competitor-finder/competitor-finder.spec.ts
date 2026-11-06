import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPETITOR_FINDER_SCOPE_STATEMENT, competitorFinderEntitySchema, competitorFinderRequestSchema, competitorFinderResultSchema } from "../../../contracts/tools/index.js";
import { toolConversionPlan } from "../tools/conversion.js";
import { buildEntityRows } from "./build-rows.js";
import { deriveCategoryQuery } from "./category-query.js";
import { DetectedSpan, detectEntitySpans, digestOf } from "./detect-entities.js";

// STORY-081 - the pure core of the Competitor Finder. Scenario numbers are the story's Test scenarios table.

const ANSWER = [
  "For small-team invoicing, these tools come up most often:",
  "",
  "1. **Billwise** — simple invoices and reminders ([billwise.example](https://billwise.example/pricing)).",
  "2. **LedgerLark**: bookkeeping with bank sync.",
  "3. [Paygrid](https://paygrid.example) handles recurring billing.",
  "",
  "Salesforce is also widely discussed in the wider market, though it is not a fit here.",
].join("\n");

describe("STORY-081 scenario 1 - the category query is derived from the fetched page", () => {
  const html = `<html><head><title>Acme Invoicing | Invoices for freelancers</title><meta name="description" content="Acme Invoicing sends invoices and chases late payments for freelancers."></head><body><h1>Get paid faster</h1></body></html>`;
  it("scenario 1 - derives a query naming the category and not the page's own brand", () => {
    const query = deriveCategoryQuery(html, "acme-invoicing.example");
    expect(query).not.toBeNull();
    expect(query!.toLowerCase()).toContain("invoices");
    expect(query!.toLowerCase()).not.toContain("acme");
  });
  it("scenario 1 - a page with no usable text derives nothing (the run is refunded, not guessed)", () => {
    expect(deriveCategoryQuery("<html><body></body></html>", "x.example")).toBeNull();
    expect(deriveCategoryQuery("", "x.example")).toBeNull();
  });
  it("scenario 1 - the request is strict: a url only, no engine", () => {
    expect(competitorFinderRequestSchema.safeParse({ url: "https://acme.example" }).success).toBe(true);
    expect(competitorFinderRequestSchema.safeParse({ url: "https://acme.example", engine: "gemini" }).success).toBe(false);
    expect(competitorFinderRequestSchema.safeParse({ url: "ftp://acme.example" }).success).toBe(false);
  });
});

describe("STORY-081 scenarios 4 and 5 - every row is built from a detected span, with its excerpt", () => {
  const spans = detectEntitySpans(ANSWER, { excludeNames: [] });
  const rows = buildEntityRows({ text: ANSWER, spans, citations: [] });

  it("scenario 4 - every row's name is the text of its span, and carries an excerpt that contains it", () => {
    expect(rows.map((r) => r.name)).toEqual(["Billwise", "LedgerLark", "Paygrid"]);
    for (const row of rows) {
      expect(ANSWER.slice(row.span.char_start, row.span.char_end)).toBe(row.name);
      expect(row.excerpt.length).toBeGreaterThan(0);
      expect(row.excerpt).toContain(row.name);
    }
  });
  it("scenario 5 - a well-known competitor the model names in unspanned prose is ABSENT", () => {
    expect(ANSWER).toContain("Salesforce");
    expect(rows.map((r) => r.name)).not.toContain("Salesforce");
    expect(JSON.stringify(rows)).not.toContain("Salesforce");
  });
  it("scenario 4 - the cited domain is the one the answer linked for that entity, else null (never a guess)", () => {
    expect(rows.find((r) => r.name === "Billwise")!.cited_domain).toBe("billwise.example");
    expect(rows.find((r) => r.name === "Paygrid")!.cited_domain).toBe("paygrid.example");
    expect(rows.find((r) => r.name === "LedgerLark")!.cited_domain).toBeNull();
  });
  it("scenario 4 (decision 67b) - a row with no cited website is returned, labelled no_source_cited; a cited row is labelled cited", () => {
    const bare = rows.find((r) => r.name === "LedgerLark")!;
    expect(bare.source_status).toBe("no_source_cited");
    expect(rows.find((r) => r.name === "Billwise")!.source_status).toBe("cited");
    for (const r of rows) expect(r.source_status === "no_source_cited").toBe(r.cited_domain === null);
  });
  it("scenario 4 (decision 67b) - the contract refuses a label that disagrees with the domain", () => {
    const base = { name: "X", span: { char_start: 0, char_end: 1 }, excerpt: "X" };
    expect(competitorFinderEntitySchema.safeParse({ ...base, cited_domain: null, source_status: "cited" }).success).toBe(false);
    expect(competitorFinderEntitySchema.safeParse({ ...base, cited_domain: "x.example", source_status: "no_source_cited" }).success).toBe(false);
    expect(competitorFinderEntitySchema.safeParse({ ...base, cited_domain: null }).success).toBe(false);
  });
  it("scenario 4 - a structured citation whose host matches the entity supplies the domain", () => {
    const built = buildEntityRows({ text: ANSWER, spans, citations: [{ url: "https://www.ledgerlark.example/features", slot: 1 }] });
    expect(built.find((r) => r.name === "LedgerLark")!.cited_domain).toBe("ledgerlark.example");
  });
  it("the page's own brand is never reported as its own competitor", () => {
    const own = detectEntitySpans(ANSWER, { excludeNames: ["billwise"] });
    expect(buildEntityRows({ text: ANSWER, spans: own, citations: [] }).map((r) => r.name)).toEqual(["LedgerLark", "Paygrid"]);
  });
  it("an entity named twice is one row, at its first span", () => {
    const text = "1. **Billwise** — first.\n2. **Billwise** — again.";
    expect(buildEntityRows({ text, spans: detectEntitySpans(text, { excludeNames: [] }), citations: [] })).toHaveLength(1);
  });
  it("empty and structure-free answers detect nothing", () => {
    expect(detectEntitySpans("", { excludeNames: [] })).toEqual([]);
    expect(detectEntitySpans("Many tools exist, such as Salesforce and HubSpot.", { excludeNames: [] })).toEqual([]);
  });
});

describe("STORY-081 scenario 6 - a row without a span is not representable", () => {
  it("scenario 6 - DetectedSpan cannot be constructed outside the detector", () => {
    // @ts-expect-error the constructor is private
    expect(() => new DetectedSpan(0, 5, "x")).toThrow();
  });
  it("scenario 6 - the builder refuses a plain object posing as a span", () => {
    const forged = [{ start: 0, end: 8 }] as unknown as readonly DetectedSpan[];
    expect(() => buildEntityRows({ text: "Salesforce is big", spans: forged, citations: [] })).toThrow();
  });
  it("scenario 6 - a span forged with the real prototype and a real digest is refused (branding is module-private, not instanceof)", () => {
    const text = "Salesforce is big";
    const forged = [Object.assign(Object.create(DetectedSpan.prototype) as object, { start: 0, end: 10, sourceDigest: digestOf(text) })] as unknown as readonly DetectedSpan[];
    expect(() => buildEntityRows({ text, spans: forged, citations: [] })).toThrow();
  });
  it("scenario 6 - a span detected in one answer cannot build a row from another text", () => {
    const spans = detectEntitySpans("1. **Billwise** — x", { excludeNames: [] });
    expect(() => buildEntityRows({ text: "1. **Salesfor** — x", spans, citations: [] })).toThrow();
  });
  it("scenario 6 - the builder's signature takes no name list (structural)", () => {
    const source = readFileSync(new URL("./build-rows.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/names\s*[:?]/u);
  });
});

describe("STORY-081 scenario 7 and 12 - the result states its scope and pre-fills conversion", () => {
  const result = {
    schema_version: 1 as const,
    scope: { engine: "gemini", query: "q", captured_at: "2026-11-06T10:00:00.000Z", statement: COMPETITOR_FINDER_SCOPE_STATEMENT },
    entities: [{ name: "Billwise", span: { char_start: 5, char_end: 13 }, excerpt: "x Billwise", cited_domain: null, source_status: "no_source_cited" as const }],
    competitors: ["Billwise"],
  };
  it("scenario 7 - the scope is stated: one engine, one query, one moment", () => {
    expect(competitorFinderResultSchema.parse(result).scope).toMatchObject({ engine: "gemini", query: "q", captured_at: "2026-11-06T10:00:00.000Z" });
    expect(COMPETITOR_FINDER_SCOPE_STATEMENT.toLowerCase()).toContain("one engine, one query, one moment");
    expect(competitorFinderResultSchema.safeParse({ ...result, scope: undefined }).success).toBe(false);
  });
  it("scenario 7 - a row with no excerpt or span is not a valid result", () => {
    expect(competitorFinderResultSchema.safeParse({ ...result, entities: [{ name: "X", cited_domain: null }] }).success).toBe(false);
  });
  it("scenario 12 - the shared conversion contract pre-fills the detected entities as candidate competitors", () => {
    const plan = toolConversionPlan({ tool_key: "competitor_finder", status: "completed", brand_name: null, brand_url: "https://acme.example", target_url: null, query_text: "q", prompt_texts: null, converted_project_id: null, result_json: result });
    expect(plan.prefill.competitors).toEqual(["Billwise"]);
    expect(plan.prefill.root_url).toBe("https://acme.example");
  });
});

// The answer shape the one real engine (Gemini) produces: bold section headings, then `**Name:** description` bullets, then a criteria section.
const GEMINI_ANSWER = [
  "**Top Invoicing Software**",
  "",
  "Here are the leading options for freelancers:",
  "",
  "*   **FreshBooks:** Great for freelancers, with simple invoices and time tracking.",
  "*   **Wave:** Free invoicing for small businesses.",
  "*   [Zoho Invoice](https://www.zoho.com/invoice/) - free for small teams.",
  "",
  "**Key Considerations When Choosing**",
  "",
  "*   **Ease of Use:** Look for a clean interface.",
  "*   **Payment Options:** Accept cards and bank transfer.",
  "*   Integrations matter for many teams",
].join("\n");

describe("STORY-081 scenario 4 - headings, labels and sentences are not entities (Gemini-shaped answer)", () => {
  const spans = detectEntitySpans(GEMINI_ANSWER, { excludeNames: [] });
  const rows = buildEntityRows({ text: GEMINI_ANSWER, spans, citations: [] });
  it("scenario 4 - only the vendor names come back", () => {
    expect(rows.map((r) => r.name)).toEqual(["FreshBooks", "Wave", "Zoho Invoice"]);
  });
  it("scenario 12 - the conversion prefill holds only those names", () => {
    const result = {
      schema_version: 1 as const,
      scope: { engine: "gemini", query: "q", captured_at: "2026-11-06T10:00:00.000Z", statement: COMPETITOR_FINDER_SCOPE_STATEMENT },
      entities: rows,
      competitors: rows.map((r) => r.name),
    };
    const plan = toolConversionPlan({ tool_key: "competitor_finder", status: "completed", brand_name: null, brand_url: "https://acme.example", target_url: null, query_text: "q", prompt_texts: null, converted_project_id: null, result_json: result });
    expect(plan.prefill.competitors).toEqual(["FreshBooks", "Wave", "Zoho Invoice"]);
  });
  it("a bold phrase that is a whole line, a heading with a trailing colon, and a sentence-shaped list lead are not detected", () => {
    const text = "**Top Picks**\n**Invoicing Software:**\n- Pick tools that fit your team\n- **Billwise:** invoices";
    expect(detectEntitySpans(text, { excludeNames: [] }).map((s) => text.slice(s.start, s.end))).toEqual(["Billwise"]);
  });
});

describe("STORY-081 scenario 4 - a Gemini grounding wrapper citation titled with the entity's domain evidences the row", () => {
  const text = "*   **FreshBooks:** Great for freelancers.\n*   **LedgerLark:** bookkeeping.";
  const spans = detectEntitySpans(text, { excludeNames: [] });
  const wrapper = (title: string, slot: number) => ({ url: `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${slot}`, title, slot });
  it("scenario 4 - the wrapper's title hostname is the cited domain; the wrapper host is never reported", () => {
    const rows = buildEntityRows({ text, spans, citations: [wrapper("freshbooks.com", 1), wrapper("unrelated.example", 2)] });
    expect(rows.find((r) => r.name === "FreshBooks")!.cited_domain).toBe("freshbooks.com");
    expect(rows.find((r) => r.name === "LedgerLark")!.cited_domain).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("vertexaisearch");
  });
  it("scenario 4 - a title that is not a hostname gives no domain", () => {
    const rows = buildEntityRows({ text, spans, citations: [wrapper("FreshBooks - invoicing", 1)] });
    expect(rows.find((r) => r.name === "FreshBooks")!.cited_domain).toBeNull();
  });
});

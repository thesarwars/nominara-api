import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PatchRejectedError } from "./types.js";
import { buildJsonLdPatch } from "./jsonld.js";

// STORY-053 AC2 / AC4 / AC7 — a structured-data block is validated and parsed before it is offered, matched for upsert on its
// @type, derived only from the page's own text, and flagged for human review when it touches a compliance, metric or pricing value.

const PAGE_HTML = "<html><body><h1>Acme CRM</h1><h2>Pipeline analytics</h2><h2>Workflow automation</h2><h2>Custom reporting</h2></body></html>";
const PAGE_TEXT = "Acme CRM\nPipeline analytics\nWorkflow automation\nCustom reporting\nSOC 2 Type II certified\nStarts at 49 USD per month";
const base = { ruleCode: "AUX-R-014", targetUrl: "https://acme.com/crm", pageHtml: PAGE_HTML, pageText: PAGE_TEXT, existingBlocks: [] as Record<string, unknown>[], explanation: "e", derivation: "d" };
const sa = (props: Record<string, unknown>): Record<string, unknown> => ({ "@context": "https://schema.org", "@type": "SoftwareApplication", ...props });

describe("STORY-053 scenario 1 · a jsonld patch is valid, with a reversal and a precondition hash", () => {
  const d = buildJsonLdPatch({ ...base, proposed: sa({ featureList: ["Pipeline analytics", "Workflow automation"] }) });

  it("is kind jsonld, offered as a script block that parses back to the block it states", () => {
    expect(d.kind).toBe("jsonld");
    const m = /^<script type="application\/ld\+json">([\s\S]*)<\/script>$/.exec(d.contentAfter);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!)).toEqual(d.jsonldBlocks![0]);
    expect(d.jsonldBlocks).toHaveLength(1);
  });

  it("carries the sha256 of the page, a page_hash precondition and a reversal that removes the block", () => {
    expect(d.contentBeforeHash.equals(createHash("sha256").update(PAGE_HTML).digest())).toBe(true);
    expect(d.preconditions[0]!.kind).toBe("page_hash");
    expect(d.reversal.operation).toBe("remove_jsonld");
  });

  it("a verbatim feature list from the page's own headings is not a claim: no review flag", () => {
    expect(d.requiresHumanReview).toBe(false);
    expect(d.riskFlags).toEqual([]);
  });
});

describe("STORY-053 scenario 2 · every derived value is traceable to the page's own content or a template", () => {
  it("rejects a value that is not in the page's own text, naming it (never a new factual claim)", () => {
    try {
      buildJsonLdPatch({ ...base, proposed: sa({ featureList: ["Pipeline analytics", "AI forecasting"] }) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PatchRejectedError);
      expect((e as PatchRejectedError).reason).toBe("underived_value");
      expect((e as PatchRejectedError).detail).toMatchObject({ value: "AI forecasting" });
    }
  });

  it("matches the page text ignoring case and runs of whitespace, but never a different word", () => {
    expect(() => buildJsonLdPatch({ ...base, proposed: sa({ featureList: ["pipeline   ANALYTICS"] }) })).not.toThrow();
    expect(() => buildJsonLdPatch({ ...base, proposed: sa({ featureList: ["Pipeline analytic"] }) })).toThrowError(PatchRejectedError); // whole words only: "49" is not in "149"
    expect(() => buildJsonLdPatch({ ...base, proposed: sa({ featureList: ["Pipeline forecasting"] }) })).toThrowError(PatchRejectedError);
  });

  it("accepts a Nominara-template value only when the caller declares it as one, and says so in the draft", () => {
    const d = buildJsonLdPatch({ ...base, proposed: sa({ applicationCategory: "BusinessApplication" }), templateValues: ["BusinessApplication"] });
    expect(d.jsonldBlocks![0]).toMatchObject({ applicationCategory: "BusinessApplication" });
    expect(d.derivation).toContain("template");
  });

  it("checks nested values too, not only the top level", () => {
    expect(() => buildJsonLdPatch({ ...base, proposed: sa({ publisher: { "@type": "Organization", name: "Invented Corp" } }) })).toThrowError(PatchRejectedError);
  });

  it("a number or boolean is a claim and must appear in the text as written", () => {
    expect(() => buildJsonLdPatch({ ...base, proposed: sa({ offers: { "@type": "Offer", price: 49, priceCurrency: "USD" } }) })).not.toThrow(); // "49" and "USD" are in the page text
    expect(() => buildJsonLdPatch({ ...base, proposed: sa({ offers: { "@type": "Offer", price: 59, priceCurrency: "USD" } }) })).toThrowError(PatchRejectedError);
  });
});

describe("STORY-053 scenario 3 · a patch asserting a compliance, metric or pricing value is flagged for review", () => {
  it("a compliance claim sets the flag, the reason and claim_requires_review", () => {
    const d = buildJsonLdPatch({ ...base, ruleCode: "AUX-R-011", proposed: { "@context": "https://schema.org", "@type": "Organization", award: "SOC 2 Type II certified" } });
    expect(d.requiresHumanReview).toBe(true);
    expect(d.reviewReason).toMatch(/confirm/i);
    expect(d.riskFlags).toContain("claim_requires_review");
  });

  it("an offer (pricing) sets it", () => {
    const d = buildJsonLdPatch({ ...base, ruleCode: "AUX-R-012", proposed: sa({ offers: { "@type": "Offer", price: 49, priceCurrency: "USD" } }) });
    expect(d.requiresHumanReview).toBe(true);
    expect(d.riskFlags).toContain("claim_requires_review");
  });

  it("an aggregateRating (metric) sets it", () => {
    const text = `${PAGE_TEXT}\n4.8\n120`;
    const d = buildJsonLdPatch({ ...base, pageText: text, ruleCode: "AUX-R-015", proposed: sa({ aggregateRating: { "@type": "AggregateRating", ratingValue: 4.8, reviewCount: 120 } }) });
    expect(d.requiresHumanReview).toBe(true);
  });

  it("a certification named in a plain string property sets it (the value, not the key, is what makes it a claim)", () => {
    const text = `${PAGE_TEXT}\nHIPAA compliant`;
    const d = buildJsonLdPatch({ ...base, pageText: text, proposed: sa({ featureList: ["HIPAA compliant"] }) });
    expect(d.requiresHumanReview).toBe(true);
  });
});

describe("STORY-053 scenario 7 · a block of a type that already exists is merged, not duplicated", () => {
  const existing = sa({ name: "Acme CRM", featureList: ["Pipeline analytics"] });

  it("returns ONE block: the existing one with the proposed properties merged in", () => {
    const d = buildJsonLdPatch({ ...base, existingBlocks: [existing], proposed: sa({ featureList: ["Pipeline analytics", "Workflow automation"] }) });
    expect(d.jsonldBlocks).toHaveLength(1);
    expect(d.jsonldBlocks![0]).toEqual(sa({ name: "Acme CRM", featureList: ["Pipeline analytics", "Workflow automation"] }));
    expect(d.reversal.operation).toBe("restore_jsonld");
    expect(JSON.parse(d.reversal.content!)).toEqual(existing);
  });

  it("keeps the existing value where the proposal disagrees on a scalar, and says so rather than overwriting it", () => {
    const d = buildJsonLdPatch({ ...base, existingBlocks: [sa({ name: "Acme CRM" })], proposed: sa({ name: "Acme CRM", applicationCategory: "BusinessApplication" }), templateValues: ["BusinessApplication"] });
    expect(d.jsonldBlocks![0]).toMatchObject({ name: "Acme CRM", applicationCategory: "BusinessApplication" });
    const conflict = buildJsonLdPatch({ ...base, existingBlocks: [sa({ name: "Old" })], proposed: sa({ name: "Acme CRM", featureList: ["Pipeline analytics"] }) });
    expect(conflict.jsonldBlocks![0]).toMatchObject({ name: "Old" });
    expect(conflict.riskFlags).toContain("kept_existing:name");
  });

  it("a different @type is inserted as its own block", () => {
    const d = buildJsonLdPatch({ ...base, existingBlocks: [{ "@context": "https://schema.org", "@type": "Organization", name: "Acme" }], proposed: sa({ featureList: ["Pipeline analytics"] }) });
    expect(d.jsonldBlocks).toHaveLength(1);
    expect(d.jsonldBlocks![0]!["@type"]).toBe("SoftwareApplication");
    expect(d.reversal.operation).toBe("remove_jsonld");
  });

  it("matches @type given as an array in either side", () => {
    const d = buildJsonLdPatch({ ...base, existingBlocks: [{ "@context": "https://schema.org", "@type": ["Product", "SoftwareApplication"], name: "Acme CRM" }], proposed: sa({ featureList: ["Pipeline analytics"] }) });
    expect(d.jsonldBlocks![0]).toMatchObject({ name: "Acme CRM", featureList: ["Pipeline analytics"] });
    expect(d.reversal.operation).toBe("restore_jsonld");
  });

  it("merging nothing new is not a patch: an identical proposal is rejected as no_change", () => {
    try {
      buildJsonLdPatch({ ...base, existingBlocks: [existing], proposed: sa({ featureList: ["Pipeline analytics"] }) });
      expect.unreachable();
    } catch (e) {
      expect((e as PatchRejectedError).reason).toBe("no_change");
    }
  });
});

describe("STORY-053 AC7 · the block is validated and parsed before it is offered", () => {
  it.each([
    ["no @type", { "@context": "https://schema.org", name: "x" }],
    ["no @context", { "@type": "Organization", name: "x" }],
    ["a non-schema.org context", { "@context": "https://evil.example/ctx", "@type": "Organization", name: "x" }],
    ["a non-object", ["Organization"]],
    ["an empty @type", { "@context": "https://schema.org", "@type": "" }],
  ])("rejects %s", (_label, proposed) => {
    expect(() => buildJsonLdPatch({ ...base, proposed })).toThrowError(PatchRejectedError);
  });

  it("accepts the block as a JSON string and rejects a string that does not parse", () => {
    const ok = buildJsonLdPatch({ ...base, proposed: JSON.stringify(sa({ featureList: ["Pipeline analytics"] })) });
    expect(ok.jsonldBlocks).toHaveLength(1);
    try {
      buildJsonLdPatch({ ...base, proposed: '{"@context": "https://schema.org", "@type": ' });
      expect.unreachable();
    } catch (e) {
      expect((e as PatchRejectedError).reason).toBe("invalid_jsonld");
    }
  });

  it("escapes < in the serialised block so no value can close the script element", () => {
    const text = `${PAGE_TEXT}\n</script><b>`;
    const d = buildJsonLdPatch({ ...base, pageText: text, proposed: sa({ featureList: ["</script><b>"] }) });
    expect(d.contentAfter.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(/>([\s\S]*)<\/script>$/.exec(d.contentAfter)![1]!).featureList).toEqual(["</script><b>"]);
  });

  it("bounds depth and size", () => {
    let deep: Record<string, unknown> = { name: "Acme CRM" };
    for (let i = 0; i < 40; i += 1) deep = { name: "Acme CRM", nested: deep };
    expect(() => buildJsonLdPatch({ ...base, proposed: sa({ nested: deep }) })).toThrowError(PatchRejectedError);
  });
});

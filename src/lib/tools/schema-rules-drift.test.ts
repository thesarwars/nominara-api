import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SCHEMA_BUILDER_RULE_CODES } from "../../../contracts/tools/index.js";
import { CATALOG_ROWS } from "../../../test/support/aux-rules.js";
import type { GuardedResponse } from "../net/guarded-fetch.js";
import type { ToolCatalogRow } from "./aux-audit-run.js";
import { checkUrlStructuredData } from "./schema-builder-url-check.js";

// STORY-083 AC5 / owner decision 85c - THE DRIFT CHECK for the browser's copy of the structured-data rules.
//
// Check on pasted markup runs in the browser, because pasted markup must never leave it (decision 78a), so the browser holds its own copy of the rules (the client's
// `lib/tools/schema.ts#check`). "No second rule implementation" cannot be literally true there; what CAN be true is that the copy never silently disagrees with the
// engine. This file is the API's half of that: a corpus of pasted JSON-LD, and for each paste the findings the ENGINE (the one the audit and URL mode run) yields.
// The page the engine reads each paste on states a price (see PAGE_BODY). The corpus is committed (`contracts/tools/schema-rules-corpus.json`) so the client can run its own `check()` over the same pastes and compare. A rule change in the
// engine that is not carried into the corpus fails HERE; a browser copy that has not followed the corpus fails THERE.
//
// WHAT IS COMPARED: the multiset of `{rule_code, severity}` per paste. Not the property path (the engine names the offer, the browser the missing field) and not the
// parse position (the engine's is V8's offset in the page, the browser's is its own engine's message): those are presentation, and comparing them would make the check
// fail for a reason that is not a changed rule. AUX-R-017 (question headings without markup) needs page text a paste does not have, so no case can raise it.
//
// To regenerate after a deliberate rule change: `UPDATE_SCHEMA_RULES_CORPUS=1 pnpm exec vitest run src/lib/tools/schema-rules-drift.test.ts`, review the diff, commit it, and
// tell the client to re-pin.

const CORPUS_PATH = path.resolve(import.meta.dirname, "../../../contracts/tools/schema-rules-corpus.json");
const ld = (value: unknown): string => `<script type="application/ld+json">\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n</script>`;
const ctx = "https://schema.org";
const org = { "@context": ctx, "@type": "Organization", name: "Acme", url: "https://acme.example", logo: "https://acme.example/logo.png", sameAs: ["https://x.example/acme"], description: "Widgets." };
const product = { "@context": ctx, "@type": "Product", name: "Acme CRM", offers: { "@type": "Offer", price: "37", priceCurrency: "USD" }, featureList: ["Pipelines", "Reports"] };

export const CASES: readonly { readonly id: string; readonly paste: string }[] = [
  { id: "complete-organization", paste: ld(org) },
  { id: "complete-product", paste: ld(product) },
  { id: "malformed-trailing-comma", paste: ld('{"@context": "https://schema.org", "@type": "Product", "name": "x",}') },
  { id: "malformed-truncated", paste: ld('{"@context": "https://schema.org", "@type": "Product", ') },
  { id: "missing-context", paste: ld({ "@type": "Organization", name: "Acme", url: "https://acme.example", logo: "l", sameAs: ["s"], description: "d" }) },
  { id: "missing-type-in-graph", paste: ld({ "@context": ctx, "@graph": [{ "@type": "Organization", name: "Acme", url: "https://acme.example", logo: "l", sameAs: ["s"], description: "d" }, { name: "Untyped" }] }) },
  { id: "no-primary-entity", paste: ld({ "@context": ctx, "@type": "BreadcrumbList", itemListElement: [] }) },
  { id: "organization-missing-profiles", paste: ld({ "@context": ctx, "@type": "Organization", name: "Acme" }) },
  { id: "product-without-price", paste: ld({ ...product, offers: { "@type": "Offer" } }) },
  { id: "product-without-offers", paste: ld({ "@context": ctx, "@type": "Product", name: "Acme CRM", featureList: ["Pipelines"] }) },
  { id: "product-without-currency", paste: ld({ ...product, offers: { "@type": "Offer", price: "37" } }) },
  { id: "product-without-feature-list", paste: ld({ "@context": ctx, "@type": "Product", name: "Acme CRM", offers: { "@type": "Offer", price: "37", priceCurrency: "USD" } }) },
  { id: "rating-without-review-count", paste: ld({ ...product, aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8" } }) },
  { id: "rating-with-review-count", paste: ld({ ...product, aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8", reviewCount: "120" } }) },
  { id: "unrecognised-type", paste: ld({ "@context": ctx, "@type": "Widgetz", name: "Acme" }) },
  { id: "invalid-type-name", paste: ld({ "@context": ctx, "@type": "not a type!", name: "Acme" }) },
  { id: "non-schema-context", paste: ld({ ...org, "@context": "https://example.com/vocab" }) },
  { id: "two-organizations-two-names", paste: ld(org) + "\n" + ld({ ...org, name: "Acme Corp" }) },
  { id: "software-application-bare", paste: ld({ "@context": ctx, "@type": "SoftwareApplication", name: "Acme CRM" }) },
  { id: "two-blocks-one-broken", paste: ld(org) + "\n" + ld('{"@context": "https://schema.org",') },
];

const corpusSchema = z
  .object({
    version: z.literal(1),
    compared: z.tuple([z.literal("rule_code"), z.literal("severity")]),
    cases: z.array(z.object({ id: z.string().min(1), paste: z.string().min(1), findings: z.array(z.object({ rule_code: z.string(), severity: z.string() }).strict()) }).strict()),
  })
  .strict();

const CATALOG: readonly ToolCatalogRow[] = CATALOG_ROWS.map((r) => ({ code: r.code, category: r.category, title: r.title, weight: r.weight, rule_version: r.ruleVersion, thresholds: r.thresholds, task_threshold: r.taskThreshold, auto_fixable: r.autoFixable, rationale: r.rationale }));
const URL_ = "https://drift.example/";
// The page a paste would sit on. The engine's AUX-R-012 only fires on a page that talks about a price, so the page does; a paste has no page, which is the very reason
// the browser's copy must be read against the engine and not assumed equal.
const PAGE_BODY = "<main><h1>Drift</h1><p>Pricing: $37 per month, billed yearly.</p></main>";

async function engineFindings(paste: string): Promise<{ rule_code: string; severity: string }[]> {
  const page = `<!doctype html><html lang="en"><head><title>Drift</title>${paste}</head><body>${PAGE_BODY}</body></html>`;
  const reply: GuardedResponse = { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(page), finalUrl: URL_, redirectChain: [], truncated: false, ttfbMs: 1, loadMs: 1 };
  const out = await checkUrlStructuredData({ url: URL_, catalog: CATALOG }, { fetch: async () => reply });
  if (out.kind !== "checked") throw new Error("the engine could not check the corpus page");
  return out.result.findings.map((f) => ({ rule_code: f.rule_code, severity: f.severity })).sort((a, b) => (a.rule_code + a.severity < b.rule_code + b.severity ? -1 : 1));
}

describe("STORY-083 AC5 (85c) - the browser rule copy's drift check, API half", () => {
  it("regenerates the corpus when asked", async () => {
    if (process.env.UPDATE_SCHEMA_RULES_CORPUS !== "1") return;
    const cases = await Promise.all(CASES.map(async (c) => ({ id: c.id, paste: c.paste, findings: await engineFindings(c.paste) })));
    writeFileSync(CORPUS_PATH, JSON.stringify({ version: 1, compared: ["rule_code", "severity"], cases }, null, 2) + "\n");
  });

  it("AC5 - every paste in the committed corpus yields, in the engine, exactly the findings the corpus records", async () => {
    const corpus = corpusSchema.parse(JSON.parse(readFileSync(CORPUS_PATH, "utf8")));
    expect(corpus.cases.map((c) => c.id)).toEqual(CASES.map((c) => c.id));
    for (const c of corpus.cases) {
      expect(c.paste, `${c.id}: the corpus paste is the case's paste`).toBe(CASES.find((k) => k.id === c.id)!.paste);
      expect(await engineFindings(c.paste), `${c.id}: the engine and the corpus disagree - a rule changed; regenerate the corpus and tell the client to re-pin`).toEqual(c.findings);
    }
  });

  it("AC5 - the corpus exercises every rule a paste can raise, so a rule the browser lacks cannot hide", () => {
    const corpus = corpusSchema.parse(JSON.parse(readFileSync(CORPUS_PATH, "utf8")));
    const raised = new Set(corpus.cases.flatMap((c) => c.findings.map((f) => f.rule_code)));
    const raisable = SCHEMA_BUILDER_RULE_CODES.filter((code) => code !== "AUX-R-017");
    expect([...raised].sort()).toEqual([...raisable].sort());
    expect(corpus.cases.some((c) => c.findings.length === 0), "at least one clean paste, so a rule that over-fires is caught").toBe(true);
  });
});

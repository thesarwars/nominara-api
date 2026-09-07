import { describe, expect, it } from "vitest";
import { resolveSlots, slotValue, type SlotContext } from "./slots.js";

// STORY-045 — §4 step 2 RESOLVE SLOTS.
//
//   2. RESOLVE SLOTS  from project context: category, competitors[],
//      personas[], verticals[], size_bands[], integrations[],
//      compliance_terms[], capabilities[]
//
// THREE OF §4's TEMPLATE SLOTS ARE NOT IN THAT LIST — `segment`, `use_case`
// and `headcount` — so they are derived, and every derivation is recorded on
// the resolved slot rather than applied invisibly. That record is what makes
// a prompt auditable: "Best crm for mid market teams?" is only checkable
// against the project if you can see what `segment` came from.

const FULL: SlotContext = {
  brandName: "HubSpot CRM",
  categorySlug: "crm",
  competitors: ["Salesforce", "Pipedrive"],
  personas: ["marketing_director"],
  verticals: ["b2b_saas"],
  sizeBands: ["mid_market"],
  integrations: ["slack", "gmail"],
  complianceTerms: ["soc2"],
  capabilities: ["pipeline_automation", "lead_scoring"],
};

describe("STORY-045 · resolveSlots — the directly resolved slots", () => {
  it("resolves every slot §4 step 2 names", () => {
    const bag = resolveSlots(FULL);
    expect(slotValue(bag, "brand")).toBe("HubSpot CRM");
    expect(slotValue(bag, "category")).toBe("crm");
    expect(slotValue(bag, "competitor")).toBe("Salesforce");
    expect(slotValue(bag, "persona")).toBe("marketing director");
    expect(slotValue(bag, "vertical")).toBe("b2b saas");
    expect(slotValue(bag, "size_band")).toBe("mid market");
    expect(slotValue(bag, "integration")).toBe("slack");
    expect(slotValue(bag, "compliance_term")).toBe("soc2");
    expect(slotValue(bag, "capability")).toBe("pipeline automation");
  });

  it("humanises snake_case identifiers, because the value goes into a sentence", () => {
    // The request example carries `personas: ["non_technical_marketing_director"]`.
    // Interpolated raw that reads "Which crm should non_technical_marketing_director
    // be looking at?" — a prompt no buyer would type, sent to an engine as
    // though one had.
    const bag = resolveSlots({ ...FULL, personas: ["non_technical_marketing_director"] });
    expect(slotValue(bag, "persona")).toBe("non technical marketing director");
  });

  it("keeps a value that is already human text exactly as supplied", () => {
    // Casing is NOT normalised: a brand's own name is the brand's own name,
    // and "hubspot crm" in a prompt is a different string for entity matching.
    const bag = resolveSlots({ ...FULL, competitors: ["Salesforce Sales Cloud"] });
    expect(slotValue(bag, "competitor")).toBe("Salesforce Sales Cloud");
  });

  it("keeps every candidate value in supplied order, not just the first", () => {
    // FR-FAN-01a's backfill and batch_size > 1 both need alternatives to draw
    // on; the emitter takes the first, deterministically.
    const bag = resolveSlots(FULL);
    expect(bag.competitor?.map((s) => s.value)).toEqual(["Salesforce", "Pipedrive"]);
    expect(bag.integration?.map((s) => s.value)).toEqual(["slack", "gmail"]);
  });

  it("omits a slot with nothing to fill it rather than filling it with a placeholder", () => {
    // An unfillable slot is what triggers §4 step 3's anonymous fallback. A
    // "general" or "your industry" placeholder would make every template
    // fillable and the fallback dead code — and put invented context into a
    // customer-visible prompt.
    const bag = resolveSlots({ brandName: "Acme" });
    expect(bag.category).toBeUndefined();
    expect(bag.competitor).toBeUndefined();
    expect(slotValue(bag, "category")).toBeUndefined();
  });

  it("drops empty and whitespace-only values", () => {
    const bag = resolveSlots({ ...FULL, competitors: ["", "   ", "Salesforce"] });
    expect(bag.competitor?.map((s) => s.value)).toEqual(["Salesforce"]);
  });

  it("deduplicates values that humanise to the same string, case-insensitively", () => {
    // "slack" and "Slack" are one integration. Left in, they generate two
    // prompts differing only in casing — which text_hash dedupe then rejects,
    // after the work of generating them and with a `rejected_duplicate` a
    // customer has to make sense of.
    const bag = resolveSlots({ ...FULL, integrations: ["slack", "Slack", "slack"] });
    expect(bag.integration?.map((s) => s.value)).toEqual(["slack"]);
    const mixed = resolveSlots({ ...FULL, integrations: ["slack", "gmail_inbox", "Gmail Inbox"] });
    expect(mixed.integration?.map((s) => s.value)).toEqual(["slack", "gmail inbox"]);
  });
});

describe("STORY-045 · resolveSlots — the three derived slots", () => {
  it("derives `segment` and records what it came from", () => {
    const bag = resolveSlots(FULL);
    const segment = bag.segment?.[0];
    expect(segment?.value).toBe("mid market b2b saas teams");
    expect(segment?.origin).toBe("derived");
    expect(segment?.derivedFrom).toEqual(["size_band", "vertical"]);
  });

  it("derives `segment` from whatever is available, most specific first", () => {
    expect(slotValue(resolveSlots({ verticals: ["b2b_saas"] }), "segment")).toBe("b2b saas teams");
    expect(slotValue(resolveSlots({ sizeBands: ["mid_market"] }), "segment")).toBe("mid market teams");
    expect(slotValue(resolveSlots({ personas: ["marketing_director"] }), "segment")).toBe("marketing directors");
  });

  it("does not derive `segment` from nothing", () => {
    expect(slotValue(resolveSlots({ brandName: "Acme" }), "segment")).toBeUndefined();
  });

  it("derives `use_case` from capabilities", () => {
    const bag = resolveSlots(FULL);
    const useCase = bag.use_case?.[0];
    expect(useCase?.value).toBe("pipeline automation");
    expect(useCase?.origin).toBe("derived");
    expect(useCase?.derivedFrom).toEqual(["capability"]);
  });

  it("derives `headcount` ONLY from a size band that is already numeric", () => {
    // No document enumerates size bands, and none maps one to a head count.
    // A band-to-range table (mid_market -> "200-1000") would put a number
    // nobody can derive into customer-visible prompt text, so a qualitative
    // band yields no headcount at all and §4's `scale_fit.a1` simply does not
    // fire for it.
    expect(slotValue(resolveSlots({ sizeBands: ["mid_market"] }), "headcount")).toBeUndefined();
    expect(slotValue(resolveSlots({ sizeBands: ["50-200"] }), "headcount")).toBe("50-200");
    expect(slotValue(resolveSlots({ sizeBands: ["500+"] }), "headcount")).toBe("500+");
  });

  it("records the origin of every slot, derived or not", () => {
    // `generator_meta` carries this, so a prompt's provenance survives into
    // the row rather than living only in whatever the caller happened to send.
    const bag = resolveSlots(FULL);
    expect(bag.category?.[0]?.origin).toBe("context");
    expect(bag.segment?.[0]?.origin).toBe("derived");
  });

  it("never derives a slot the context supplied directly", () => {
    // If a caller ever supplies `segment`, the derivation must not overwrite
    // it — their own vocabulary beats our composition of it.
    const bag = resolveSlots({ ...FULL, segments: ["enterprise revenue teams"] });
    expect(slotValue(bag, "segment")).toBe("enterprise revenue teams");
    expect(bag.segment?.[0]?.origin).toBe("context");
  });
});

describe("STORY-045 · resolveSlots is deterministic", () => {
  it("returns identical bags for identical context — FR-FAN-01d", () => {
    expect(JSON.stringify(resolveSlots(FULL))).toBe(JSON.stringify(resolveSlots(FULL)));
  });

  it("does not depend on key order in the context object", () => {
    // Written out rather than spread from FULL: `exactOptionalPropertyTypes`
    // makes `FULL.brandName` a `string | undefined` that cannot be assigned
    // back to an optional `string`, and the point of the test is the KEY
    // ORDER, which a spread would not change anyway.
    const reordered: SlotContext = {
      capabilities: ["pipeline_automation", "lead_scoring"],
      brandName: "HubSpot CRM",
      sizeBands: ["mid_market"],
      verticals: ["b2b_saas"],
      categorySlug: "crm",
      competitors: ["Salesforce", "Pipedrive"],
      complianceTerms: ["soc2"],
      integrations: ["slack", "gmail"],
      personas: ["marketing_director"],
    };
    expect(JSON.stringify(resolveSlots(reordered))).toBe(JSON.stringify(resolveSlots(FULL)));
  });
});

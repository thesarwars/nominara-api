import { describe, expect, it } from "vitest";
import { funnelStageSchema, generatableArchetypeSchema, GENERATABLE_ARCHETYPES, intentArchetypeSchema } from "./archetype.schema.js";
import { generatePromptsFieldsSchema, generatePromptsRequestSchema } from "./generate-prompts-request.schema.js";
import { generatePromptsResponseSchema, promptNoveltySchema } from "./generate-prompts-response.schema.js";

// STORY-045 — the shape questions, answerable with no database and no HTTP
// round trip. api-specification.md §5, tracking-engine.md §4.

describe("STORY-045 · the archetype unions", () => {
  it("has exactly the fifteen generatable archetypes, in §4's order", () => {
    expect(GENERATABLE_ARCHETYPES).toHaveLength(15);
    expect(GENERATABLE_ARCHETYPES[0]).toBe("recommendation");
    expect(GENERATABLE_ARCHETYPES[14]).toBe("buyer_shortlist");
  });

  it("does NOT let the generator be asked for `custom`", () => {
    // `custom` is what a manually created prompt carries. Accepting it here
    // would mean either an empty pass or an invented template.
    expect(generatableArchetypeSchema.safeParse("custom").success).toBe(false);
    expect(intentArchetypeSchema.safeParse("custom").success).toBe(true);
  });

  it("keeps `awareness` in the funnel union even though no archetype maps to it", () => {
    // The column's CHECK permits it and a future archetype will need it.
    // Trimming the union to today's fifteen would make adding one a contract
    // change.
    expect(funnelStageSchema.safeParse("awareness").success).toBe(true);
  });
});

describe("STORY-045 · generatePromptsRequest", () => {
  it("accepts an empty body and defaults to a full fifteen-candidate pass", () => {
    // FR-FAN-01a by construction: 15 archetypes x batch_size 1.
    const result = generatePromptsFieldsSchema.parse({});
    expect(result.batch_size).toBe(1);
    expect(result.topic_hint).toBeUndefined();
  });

  it("defaults every documented sub-object to §5's values when the object is present", () => {
    const result = generatePromptsFieldsSchema.parse({
      archetype_plan: {},
      generation: {},
      dedupe: {},
      options: {},
    });
    expect(result.archetype_plan).toEqual({ mode: "full_coverage" });
    expect(result.generation).toEqual({
      strategy: "template_first",
      naturalizer_enabled: true,
      temperature: 0.35,
      single_batched_call: true,
    });
    expect(result.dedupe).toEqual({ method: "pgvector_cosine", similarity_threshold: 0.92, scope: "project" });
    expect(result.options).toEqual({ auto_activate: false, priority_subset_size: 6 });
  });

  it("accepts §5's documented request, minus its own contradictory batch_size", () => {
    const result = generatePromptsRequestSchema.safeParse({
      topic_hint: "lead management",
      brand_context: {
        brand_name: "HubSpot CRM",
        brand_aliases: ["HubSpot", "HS CRM"],
        root_domain: "hubspot.com",
        category_slug: "crm",
        verticals: ["b2b_saas", "sales_enablement"],
        competitors: [{ name: "Salesforce", aliases: ["SFDC"] }],
        personas: ["non_technical_marketing_director"],
        size_bands: ["mid_market"],
      },
      archetype_plan: { mode: "full_coverage", include: [...GENERATABLE_ARCHETYPES], exclude: [] },
      generation: { strategy: "template_first", naturalizer_enabled: true, temperature: 0.35, single_batched_call: true },
      dedupe: { method: "pgvector_cosine", similarity_threshold: 0.92, scope: "project" },
      options: { auto_activate: false, priority_subset_size: 6 },
    });
    expect(result.success).toBe(true);
  });

  // batch_size is PER ARCHETYPE (see the schema's own note on why §5's
  // example cannot be read any other way without breaking FR-FAN-01a).
  it("caps batch_size at 4, because each archetype has 2–4 surface templates", () => {
    expect(generatePromptsRequestSchema.safeParse({ batch_size: 4 }).success).toBe(true);
    // §5's illustrative `5` is unsatisfiable per archetype — there is no
    // fifth distinct template to draw on, and a short pass would leave the
    // caller to work that out themselves.
    expect(generatePromptsRequestSchema.safeParse({ batch_size: 5 }).success).toBe(false);
    expect(generatePromptsRequestSchema.safeParse({ batch_size: 0 }).success).toBe(false);
  });

  it("rejects an unknown key rather than ignoring it — at every level", () => {
    // security-and-tenancy.md §9. It matters most on the tuning knobs: a
    // typo'd `naturalizer_enabled` that was silently dropped would leave the
    // naturaliser on and make FR-FAN-01d's determinism fail intermittently.
    expect(generatePromptsRequestSchema.safeParse({ naturalizer_enabled: false }).success).toBe(false);
    expect(generatePromptsRequestSchema.safeParse({ generation: { naturaliser_enabled: false } }).success).toBe(false);
    expect(generatePromptsRequestSchema.safeParse({ options: { autoActivate: true } }).success).toBe(false);
    expect(generatePromptsRequestSchema.safeParse({ brand_context: { brand: "HubSpot" } }).success).toBe(false);
  });

  it("rejects an archetype named in both include and exclude, naming the path", () => {
    const result = generatePromptsRequestSchema.safeParse({
      archetype_plan: { include: ["recommendation", "alternatives"], exclude: ["recommendation"] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["archetype_plan", "exclude"]);
  });

  it("rejects a plan that excludes every archetype", () => {
    // Otherwise this is a valid-looking 200 with zero variants and full
    // coverage over nothing.
    const result = generatePromptsRequestSchema.safeParse({
      archetype_plan: { exclude: [...GENERATABLE_ARCHETYPES] },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["archetype_plan"]);
  });

  it("keeps a partial exclusion valid", () => {
    const result = generatePromptsRequestSchema.safeParse({ archetype_plan: { exclude: ["objection_risk"] } });
    expect(result.success).toBe(true);
  });

  it("refuses a similarity threshold of 0, which would reject every candidate", () => {
    expect(generatePromptsRequestSchema.safeParse({ dedupe: { similarity_threshold: 0 } }).success).toBe(false);
    expect(generatePromptsRequestSchema.safeParse({ dedupe: { similarity_threshold: 1 } }).success).toBe(true);
  });

  it("keeps `auto_activate` and `model_first` on the wire — they are refused by the service, not the shape", () => {
    // Both are documented and both are capability gaps rather than invalid
    // requests. Refusing them here would mean deleting a refinement — and
    // moving the contract — the day they become supported.
    expect(generatePromptsRequestSchema.safeParse({ options: { auto_activate: true } }).success).toBe(true);
    expect(generatePromptsRequestSchema.safeParse({ generation: { strategy: "model_first" } }).success).toBe(true);
  });
});

describe("STORY-045 · generatePromptsResponse", () => {
  const variant = {
    prompt_id: "01a00000-0000-7000-8000-000000000001",
    text: "Which CRM do you recommend for mid-market sales teams?",
    text_hash: `sha256:${"a".repeat(64)}`,
    intent_archetype: "recommendation" as const,
    funnel_stage: "consideration" as const,
    template_id: "recommendation.v1",
    naturalized: false,
    brand_named: false,
    competitor_named: false,
    slots: { category: "CRM", segment: "mid-market sales teams" },
    novelty: { max_cosine_to_existing: null, nearest_prompt_id: null },
    is_priority: true,
    status: "archived" as const,
  };

  it("accepts a full pass", () => {
    const result = generatePromptsResponseSchema.safeParse({
      generation_batch_id: "01a00000-0000-7000-8000-0000000000ff",
      variants: [variant],
      rejected: [],
      coverage: [{ intent_archetype: "recommendation", represented: true, variant_count: 1, used_anonymous_fallback: false }],
      summary: { requested: 15, generated: 15, accepted: 15, rejected_duplicate: 0, activated: 0, priority_flagged: 6 },
      cached: false,
    });
    expect(result.success).toBe(true);
  });

  it("permits a null novelty, because nothing computes an embedding yet", () => {
    // G3 / STORY-133. `null` means NOT MEASURED. The alternative — 0 — claims
    // "measured, and maximally distant from everything", which reads as a
    // novelty check that passed.
    expect(promptNoveltySchema.safeParse({ max_cosine_to_existing: null, nearest_prompt_id: null }).success).toBe(true);
    expect(promptNoveltySchema.safeParse({ max_cosine_to_existing: 0.87, nearest_prompt_id: "01a00000-0000-7000-8000-000000000002" }).success).toBe(true);
  });

  it("requires the hash in the same `sha256:<hex>` form §6 uses", () => {
    expect(generatePromptsResponseSchema.safeParse({
      generation_batch_id: "01a00000-0000-7000-8000-0000000000ff",
      variants: [{ ...variant, text_hash: "a".repeat(64) }],
      rejected: [],
      coverage: [],
      summary: { requested: 0, generated: 0, accepted: 0, rejected_duplicate: 0, activated: 0, priority_flagged: 0 },
      cached: false,
    }).success).toBe(false);
  });

  it("keeps the summary to §5's six members", () => {
    // A member the specification does not document is a member some client
    // starts depending on. The brand-anonymous count is derivable from
    // `variants[].brand_named`, so it is not one of them.
    const result = generatePromptsResponseSchema.safeParse({
      generation_batch_id: "01a00000-0000-7000-8000-0000000000ff",
      variants: [],
      rejected: [],
      coverage: [],
      summary: { requested: 0, generated: 0, accepted: 0, rejected_duplicate: 0, activated: 0, priority_flagged: 0, brand_anonymous: 6 },
      cached: false,
    });
    expect(result.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { createPromptRequestSchema } from "./create-prompt-request.schema.js";
import { promptListItemSchema, promptListQuerySchema, promptListResponseSchema } from "./prompt-list-response.schema.js";

// STORY-134 — the shape questions. api-specification.md §3,
// page-inventory.md §6.

const ID = "01a06ccd-0000-7000-8000-000000000001";

describe("STORY-134 · promptListQuery — the four filters that are ABSENT", () => {
  it("accepts the three real columns", () => {
    expect(promptListQuerySchema.safeParse({ status: "active" }).success).toBe(true);
    expect(promptListQuerySchema.safeParse({ intent_archetype: "scale_fit" }).success).toBe(true);
    expect(promptListQuerySchema.safeParse({ funnel_stage: "decision" }).success).toBe(true);
  });

  it("REFUSES a filter whose producer does not exist — never silently ignores it", () => {
    // §3 lists seven filters and four have no producer: `engine`, `presence`
    // and `sentiment` come from capture runs, `topic cluster` from STORY-047.
    //
    // A filter that is accepted and ignored is worse than one that 400s: the
    // customer believes they narrowed the list, and a prompt they were
    // looking for is missing for a reason no part of the UI can show them.
    for (const absent of [{ engine: "chatgpt" }, { presence: "absent" }, { sentiment: "negative" }, { cluster_id: ID }]) {
      const result = promptListQuerySchema.safeParse(absent);
      expect(result.success, JSON.stringify(absent)).toBe(false);
    }
  });

  it("clamps the limit rather than rejecting a large one", () => {
    // The pagination precedent: clamp-then-validate, so a caller asking for
    // 5000 gets a page rather than an error.
    expect(promptListQuerySchema.parse({ limit: 5000 }).limit).toBe(200);
    expect(promptListQuerySchema.parse({}).limit).toBe(50);
  });

  it("refuses a status the column's CHECK would reject", () => {
    expect(promptListQuerySchema.safeParse({ status: "deleted" }).success).toBe(false);
  });
});

describe("STORY-134 · promptListItem", () => {
  const item = {
    id: ID,
    text: "most reliable crm for a 50-rep sales team",
    text_hash: `sha256:${"a".repeat(64)}`,
    intent_archetype: "scale_fit" as const,
    funnel_stage: "consideration" as const,
    status: "active" as const,
    is_priority: true,
    generation_source: "generated" as const,
    generation_batch_id: "01a06ccd-0000-7000-8000-0000000000ff",
    cluster_id: null,
    stability_score: null,
    last_captured_at: null,
    created_at: "2026-09-07T00:00:00.000Z",
  };

  it("accepts a row that has never been captured", () => {
    // The normal case today. All three producers are Slice 4 or later.
    expect(promptListItemSchema.safeParse(item).success).toBe(true);
  });

  it("keeps the three unproduced members NULLABLE, never defaulted to 0", () => {
    // `stability_score: 0` would assert perfect instability, and `FR-PA-07`
    // warns below 0.5 — so a default of 0 would put an "unstable" warning on
    // every prompt in the product. `last_captured_at` defaulted to now would
    // claim a capture that never happened.
    expect(promptListItemSchema.safeParse({ ...item, stability_score: 0.91 }).success).toBe(true);
    expect(promptListItemSchema.safeParse({ ...item, stability_score: undefined }).success).toBe(false);
    expect(promptListItemSchema.safeParse({ ...item, last_captured_at: undefined }).success).toBe(false);
  });

  it("carries `generation_source` on the wire, because §6 renders them differently", () => {
    // `FR-PA-04b`: a Search Console query is labelled "real Google query",
    // "distinct from 'generated'" — the two are never conflated, so the
    // client cannot be left to guess from the archetype.
    expect(promptListItemSchema.safeParse({ ...item, generation_source: "manual" }).success).toBe(true);
    expect(promptListItemSchema.safeParse({ ...item, generation_source: "gsc_query" }).success).toBe(true);
  });

  it("carries NO cell data", () => {
    // `FR-PA-01a`'s rank, share of voice, sentiment glyph and cache state are
    // Slice 4's. Publishing a shape for them now would have STORY-091 build
    // against a contract nothing can fill.
    expect(promptListItemSchema.safeParse({ ...item, cells: [] }).success).toBe(false);
    expect(promptListItemSchema.safeParse({ ...item, share_of_voice: 0.44 }).success).toBe(false);
  });
});

describe("STORY-134 · promptListResponse — FR-PA-03a's header", () => {
  const response = {
    prompts: [],
    summary: { active: 47, paused: 0, archived: 3, cap: 50 },
  };

  it("carries the header's counts server-side", () => {
    expect(promptListResponseSchema.safeParse(response).success).toBe(true);
  });

  it("counts PAUSED separately, because a paused prompt still holds a slot", () => {
    // `PROMPT_OCCUPIES_SLOT` is `status <> 'archived'`. A header that showed
    // only active/cap would tell a customer with 40 active and 8 paused that
    // they have 10 slots free on a cap of 50, when they have 2.
    const withoutPaused = { prompts: [], summary: { active: 47, archived: 3, cap: 50 } };
    expect(promptListResponseSchema.safeParse(withoutPaused).success).toBe(false);
  });

  it("rejects an undocumented summary member", () => {
    expect(promptListResponseSchema.safeParse({ ...response, summary: { ...response.summary, total: 50 } }).success).toBe(false);
  });
});

describe("STORY-134 · createPromptRequest", () => {
  it("takes the text and nothing else", () => {
    expect(createPromptRequestSchema.safeParse({ text: "best crm for a 10-person startup" }).success).toBe(true);
  });

  it("refuses a claimed archetype — a manual prompt is `custom`", () => {
    // The sixteenth enum value exists for exactly this. Letting a caller
    // claim `head_to_head` would report a provenance that is not true, and
    // the archetype is what §6's matrix filters and the coverage row counts.
    expect(createPromptRequestSchema.safeParse({ text: "x?", intent_archetype: "head_to_head" }).success).toBe(false);
  });

  it("refuses a supplied status — manual entry is capped, not archivable on arrival", () => {
    // STORY-046 AC7: manual entry is "always free and still subject to the
    // cap". A caller asking for `archived` would be asking to bypass it.
    expect(createPromptRequestSchema.safeParse({ text: "x?", status: "archived" }).success).toBe(false);
  });

  it("refuses a supplied text_hash — it is derived", () => {
    expect(createPromptRequestSchema.safeParse({ text: "x?", text_hash: "sha256:00" }).success).toBe(false);
  });

  it("trims and bounds the text to the column's limit", () => {
    expect(createPromptRequestSchema.safeParse({ text: "   " }).success).toBe(false);
    expect(createPromptRequestSchema.safeParse({ text: "x".repeat(501) }).success).toBe(false);
    expect(createPromptRequestSchema.parse({ text: "  best crm?  " }).text).toBe("best crm?");
  });
});

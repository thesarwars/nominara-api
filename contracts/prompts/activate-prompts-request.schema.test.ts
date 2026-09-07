import { describe, expect, it } from "vitest";
import { activatePromptsRequestSchema } from "./activate-prompts-request.schema.js";
import { activatePromptsResponseSchema, promptResponseSchema } from "./activate-prompts-response.schema.js";
import { updatePromptRequestSchema } from "./update-prompt-request.schema.js";

// STORY-046 — the shape questions. api-specification.md §3,
// plans-and-entitlements.md §10.

const ID = "01a06ccd-0000-7000-8000-000000000001";
const OTHER = "01a06ccd-0000-7000-8000-000000000002";

describe("STORY-046 · activatePromptsRequest", () => {
  it("takes the chosen subset by id", () => {
    expect(activatePromptsRequestSchema.safeParse({ prompt_ids: [ID, OTHER] }).success).toBe(true);
  });

  it("refuses an empty list rather than treating it as a no-op", () => {
    // An empty activation is a request that cannot mean anything. Accepting
    // it would return a successful-looking response for a call that did
    // nothing, and once activation charges it would be a zero-value debit
    // path nobody meant to open.
    expect(activatePromptsRequestSchema.safeParse({ prompt_ids: [] }).success).toBe(false);
  });

  it("rejects an unknown key", () => {
    // security-and-tenancy.md §9. It matters here because the obvious
    // mistake is sending a COUNT — `{ count: 8 }` — and a silently ignored
    // count would activate nothing while looking accepted.
    expect(activatePromptsRequestSchema.safeParse({ prompt_ids: [ID], count: 8 }).success).toBe(false);
    expect(activatePromptsRequestSchema.safeParse({ count: 8 }).success).toBe(false);
  });

  it("rejects anything that is not a uuid", () => {
    expect(activatePromptsRequestSchema.safeParse({ prompt_ids: ["not-a-uuid"] }).success).toBe(false);
  });
});

describe("STORY-046 · activatePromptsResponse", () => {
  const base = {
    activated_prompt_ids: [ID],
    summary: { requested: 1, activated: 1, already_active: 0, slots_remaining: 7 },
    coverage: { activated: 8, generated: 15 },
    prompts_active: 33,
    prompts_cap: 40,
    credits_charged: 0 as const,
  };

  it("accepts a full response", () => {
    expect(activatePromptsResponseSchema.safeParse(base).success).toBe(true);
  });

  it("carries FR-CRD-08's coverage as TWO integers, not a ratio", () => {
    // "The coverage chip shows activated / generated, so a capped project
    // never appears to have full coverage." A single percentage renders 8/10
    // and 40/50 identically while meaning very different things.
    expect(activatePromptsResponseSchema.safeParse({ ...base, coverage: { activated: 8 } }).success).toBe(false);
    expect(activatePromptsResponseSchema.safeParse({ ...base, coverage: 0.53 }).success).toBe(false);
  });

  it("reports `already_active` so a replay is distinguishable from a no-op", () => {
    // AC12's idempotency, made observable: `activated: 0, already_active: 8`
    // says the first attempt landed. A bare `activated: 0` cannot.
    const replay = { ...base, summary: { requested: 8, activated: 0, already_active: 8, slots_remaining: 7 } };
    expect(activatePromptsResponseSchema.safeParse(replay).success).toBe(true);
  });

  it("types `credits_charged` as the LITERAL 0", () => {
    // The device `discover.ts` uses for its own "discovery charges nothing":
    // a future edit that introduces the debit cannot ship without changing
    // this contract. A plain `number` would let a charge appear silently in
    // a field nobody re-reviewed.
    expect(activatePromptsResponseSchema.safeParse({ ...base, credits_charged: 1 }).success).toBe(false);
    expect(activatePromptsResponseSchema.safeParse({ ...base, credits_charged: 0 }).success).toBe(true);
  });

  it("rejects an undocumented summary member", () => {
    const extra = { ...base, summary: { ...base.summary, charged: 8 } };
    expect(activatePromptsResponseSchema.safeParse(extra).success).toBe(false);
  });
});

describe("STORY-046 · promptResponse", () => {
  const base = {
    prompt_id: ID,
    project_id: OTHER,
    text: "Which crm do you recommend for mid market teams?",
    text_hash: `sha256:${"a".repeat(64)}`,
    status: "active" as const,
    is_priority: false,
    supersedes_prompt_id: null,
    prompts_active: 33,
    prompts_cap: 40,
    credits_charged: 0 as const,
  };

  it("accepts a plain status change", () => {
    expect(promptResponseSchema.safeParse(base).success).toBe(true);
  });

  it("carries `supersedes_prompt_id` for an EDIT, where prompt_id is a NEW row", () => {
    // FR-FAN-01f. An edit returns a different id than the one in the path,
    // which is unusual enough for a PATCH that the response has to say so —
    // a client assuming the id was stable would keep polling a superseded
    // row and watch its metrics stop.
    expect(promptResponseSchema.safeParse({ ...base, prompt_id: OTHER, supersedes_prompt_id: ID }).success).toBe(true);
  });

  it("requires the member rather than omitting it when there was no edit", () => {
    // Present-and-null, not absent: a client reading `supersedes_prompt_id`
    // should not have to distinguish "no edit" from "this server version
    // does not report edits".
    const { supersedes_prompt_id: _omitted, ...withoutMember } = base;
    expect(promptResponseSchema.safeParse(withoutMember).success).toBe(false);
  });
});

describe("STORY-046 · updatePromptRequest", () => {
  it("accepts each of the three documented changes alone", () => {
    expect(updatePromptRequestSchema.safeParse({ status: "paused" }).success).toBe(true);
    expect(updatePromptRequestSchema.safeParse({ is_priority: true }).success).toBe(true);
    expect(updatePromptRequestSchema.safeParse({ text: "a better wording?" }).success).toBe(true);
  });

  it("refuses an empty body", () => {
    // A PATCH with nothing in it returns 200 for a change that never
    // happened, which is indistinguishable from a change the server dropped.
    expect(updatePromptRequestSchema.safeParse({}).success).toBe(false);
  });

  it("keeps all three status values — pause and archive are NOT the same", () => {
    // `PROMPT_OCCUPIES_SLOT` is `status <> 'archived'`, so pausing frees
    // nothing and archiving frees a slot. Collapsing them to a boolean would
    // let a customer exceed their cap by pausing and adding.
    for (const status of ["active", "paused", "archived"]) {
      expect(updatePromptRequestSchema.safeParse({ status }).success, status).toBe(true);
    }
    expect(updatePromptRequestSchema.safeParse({ status: "deleted" }).success).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(updatePromptRequestSchema.safeParse({ paused: true }).success).toBe(false);
    // The obvious wrong guess: text_hash is DERIVED, never supplied.
    expect(updatePromptRequestSchema.safeParse({ text: "x?", text_hash: "sha256:00" }).success).toBe(false);
  });

  it("trims and bounds the new text to the column's limit", () => {
    expect(updatePromptRequestSchema.safeParse({ text: "   " }).success).toBe(false);
    expect(updatePromptRequestSchema.safeParse({ text: "x".repeat(501) }).success).toBe(false);
    expect(updatePromptRequestSchema.safeParse({ text: "x".repeat(500) }).success).toBe(true);
  });
});

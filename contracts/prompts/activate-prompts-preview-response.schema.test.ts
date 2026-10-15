import { describe, expect, it } from "vitest";
import { activatePromptsPreviewResponseSchema } from "./activate-prompts-preview-response.schema.js";

describe("STORY-046 AC3 - activatePromptsPreviewResponse", () => {
  const base = { credits: 2, prompts: { requested: 12, already_active: 0, free: 10, charged: 2 }, credits_charged: 0 };

  it("accepts a quote, and 0 is a valid (free) figure", () => {
    expect(activatePromptsPreviewResponseSchema.safeParse(base).success).toBe(true);
    expect(activatePromptsPreviewResponseSchema.safeParse({ ...base, credits: 0 }).success).toBe(true);
  });

  it("types credits_charged as the literal 0: a preview never debits", () => {
    expect(activatePromptsPreviewResponseSchema.safeParse({ ...base, credits_charged: 2 }).success).toBe(false);
  });

  it("rejects a negative, fractional or absent price, and an undocumented member", () => {
    expect(activatePromptsPreviewResponseSchema.safeParse({ ...base, credits: -1 }).success).toBe(false);
    expect(activatePromptsPreviewResponseSchema.safeParse({ ...base, credits: 1.5 }).success).toBe(false);
    const { credits: _omitted, ...without } = base;
    expect(activatePromptsPreviewResponseSchema.safeParse(without).success).toBe(false);
    expect(activatePromptsPreviewResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

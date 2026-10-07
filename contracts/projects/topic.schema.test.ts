import { describe, expect, it } from "vitest";
import { renameTopicRequestSchema, topicListResponseSchema, TOPIC_LABEL_MAX } from "./index.js";

describe("NEW-B-3 · topic contracts", () => {
  it("rename trims and rejects blank, over-long and unknown keys", () => {
    expect(renameTopicRequestSchema.parse({ label: "  Pricing  " }).label).toBe("Pricing");
    expect(renameTopicRequestSchema.safeParse({ label: "   " }).success).toBe(false);
    expect(renameTopicRequestSchema.safeParse({ label: "x".repeat(TOPIC_LABEL_MAX + 1) }).success).toBe(false);
    expect(renameTopicRequestSchema.safeParse({ label: "ok", label_source: "auto" }).success).toBe(false);
    expect(renameTopicRequestSchema.safeParse({}).success).toBe(false);
  });
  it("an empty list is valid", () => {
    expect(topicListResponseSchema.parse({ topics: [] })).toEqual({ topics: [] });
  });
});

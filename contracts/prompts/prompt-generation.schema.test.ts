import { describe, expect, it } from "vitest";
import {
  generatePromptsAcceptedResponseSchema,
  promptGenerationFailureCodeSchema,
  promptGenerationSchema,
} from "./prompt-generation.schema.js";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const base = { generation_batch_id: ID, project_id: ID, requested_at: "2026-11-10T10:00:00.000Z" };
const result = {
  generation_batch_id: ID,
  variants: [],
  rejected: [],
  coverage: [],
  summary: { requested: 0, generated: 0, accepted: 0, rejected_duplicate: 0, activated: 0, priority_flagged: 0 },
  cached: false,
};

describe("STORY-045 / decision 95(a) · the generation read contract", () => {
  it("the 202 body is a pending pointer and nothing else", () => {
    expect(generatePromptsAcceptedResponseSchema.safeParse({ generation_batch_id: ID, status: "pending", poll_url: "/v1/x" }).success).toBe(true);
    expect(generatePromptsAcceptedResponseSchema.safeParse({ generation_batch_id: ID, status: "running", poll_url: "/v1/x" }).success).toBe(false);
    expect(generatePromptsAcceptedResponseSchema.safeParse({ generation_batch_id: ID, status: "pending", poll_url: "/v1/x", variants: [] }).success).toBe(false);
  });

  it("a pending generation carries no result, no failure and no completion time", () => {
    expect(promptGenerationSchema.safeParse({ ...base, status: "pending", result: null, failure_code: null, completed_at: null }).success).toBe(true);
    expect(promptGenerationSchema.safeParse({ ...base, status: "pending", result, failure_code: null, completed_at: null }).success).toBe(false);
  });

  it("a succeeded generation must carry the pass, a failed one must not", () => {
    const done = "2026-11-10T10:00:05.000Z";
    expect(promptGenerationSchema.safeParse({ ...base, status: "succeeded", result, failure_code: null, completed_at: done }).success).toBe(true);
    expect(promptGenerationSchema.safeParse({ ...base, status: "succeeded", result: null, failure_code: null, completed_at: done }).success).toBe(false);
    expect(promptGenerationSchema.safeParse({ ...base, status: "failed", result, failure_code: "generation_failed", completed_at: done }).success).toBe(false);
  });

  it("a failed generation names why, from a closed set, and is never a partial result", () => {
    const done = "2026-11-10T10:00:05.000Z";
    expect(promptGenerationSchema.safeParse({ ...base, status: "failed", result: null, failure_code: "generation_failed", completed_at: done }).success).toBe(true);
    expect(promptGenerationSchema.safeParse({ ...base, status: "failed", result: null, failure_code: null, completed_at: done }).success).toBe(false);
    expect(promptGenerationFailureCodeSchema.safeParse("something else").success).toBe(false);
  });

  it("a settled generation has a completion time and an unsettled one does not", () => {
    expect(promptGenerationSchema.safeParse({ ...base, status: "failed", result: null, failure_code: "dispatch_failed", completed_at: null }).success).toBe(false);
    expect(promptGenerationSchema.safeParse({ ...base, status: "running", result: null, failure_code: null, completed_at: "2026-11-10T10:00:05.000Z" }).success).toBe(false);
  });
});

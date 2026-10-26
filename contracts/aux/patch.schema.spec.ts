import { describe, expect, it } from "vitest";
import { auxGuidanceSchema, auxPatchSchema } from "./patch.schema.js";

const HASH = `sha256:${"a".repeat(64)}`;
const patch = {
  patch_id: "0190b1c0-0000-7000-8000-000000000001", finding_id: "0190b1c0-0000-7000-8000-000000000002", project_id: "0190b1c0-0000-7000-8000-000000000003",
  rule_code: "AUX-R-001", kind: "robots", target_url: "https://acme.com/robots.txt", content_before_hash: HASH, content_after: "User-agent: GPTBot\nAllow: /\n",
  unified_diff: null, jsonld_blocks: null, reversal: { operation: "remove_block", content: "x" }, preconditions: [{ kind: "file_hash", value: HASH }],
  explanation: "e", derivation: "d", requires_human_review: false, review_reason: null, risk_flags: [], page_matches: null, earlier_patch_ids: [],
  free: true, credits_charged: 0, created_at: "2026-10-23T00:00:00.000Z",
};

describe("STORY-053 scenario 1 · the patch on the wire", () => {
  it("accepts a robots patch with a reversal and a precondition hash", () => {
    expect(auxPatchSchema.parse(patch)).toEqual(patch);
  });

  it("scenario 11 · says it is free: free is the literal true and credits_charged the literal 0", () => {
    expect(auxPatchSchema.safeParse({ ...patch, free: false }).success).toBe(false);
    expect(auxPatchSchema.safeParse({ ...patch, credits_charged: 1 }).success).toBe(false);
    expect(auxPatchSchema.safeParse({ ...patch, free: undefined }).success).toBe(false);
  });

  it("scenario 9 · page_matches is true, false or null, and null is not a default", () => {
    for (const v of [true, false, null]) expect(auxPatchSchema.parse({ ...patch, page_matches: v }).page_matches).toBe(v);
    expect(auxPatchSchema.safeParse({ ...patch, page_matches: undefined }).success).toBe(false);
  });

  it("rejects an unknown key, an unknown kind and a malformed hash", () => {
    expect(auxPatchSchema.safeParse({ ...patch, extra: 1 }).success).toBe(false);
    expect(auxPatchSchema.safeParse({ ...patch, kind: "llms_txt" }).success).toBe(false);
    expect(auxPatchSchema.safeParse({ ...patch, content_before_hash: "abc" }).success).toBe(false);
  });

  it("a file_absent precondition has a null value; a hash precondition cannot have a malformed one", () => {
    expect(auxPatchSchema.safeParse({ ...patch, preconditions: [{ kind: "file_absent", value: null }] }).success).toBe(true);
    expect(auxPatchSchema.safeParse({ ...patch, preconditions: [{ kind: "file_hash", value: "nope" }] }).success).toBe(false);
  });
});

describe("STORY-053 scenario 10 · guidance", () => {
  it("needs at least one step, and an alignment link may be null", () => {
    expect(auxGuidanceSchema.safeParse({ summary: "s", steps: [], alignment_link: null }).success).toBe(false);
    expect(auxGuidanceSchema.parse({ summary: "s", steps: ["a"], alignment_link: { path: "/geo/alignment", target_url: null } }).alignment_link?.target_url).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { alignmentTargetsQuerySchema, alignmentTargetsResponseSchema } from "./index.js";

const ID = "0192f0aa-0000-7000-8000-000000000001";
const ok = { project_id: ID, clusters: [{ cluster_id: ID, label: "crm", prompt_count: 3 }], pages: [{ target_url: "https://a.test/", sources: ["project_root"] }], sessions: [], corpus: { passages: 0, domains: [] }, credits_charged: 0 };

describe("GET /geo/alignment/targets · contract", () => {
  it("AT-C1 the query is strict and needs a lowercase uuid project_id", () => {
    expect(alignmentTargetsQuerySchema.safeParse({ project_id: ID }).success).toBe(true);
    expect(alignmentTargetsQuerySchema.safeParse({ project_id: ID, extra: 1 }).success).toBe(false);
    expect(alignmentTargetsQuerySchema.safeParse({}).success).toBe(false);
  });
  it("AT-C2 the response is strict, free, and a page names at least one source", () => {
    expect(alignmentTargetsResponseSchema.safeParse(ok).success).toBe(true);
    expect(alignmentTargetsResponseSchema.safeParse({ ...ok, credits_charged: 1 }).success).toBe(false);
    expect(alignmentTargetsResponseSchema.safeParse({ ...ok, pages: [{ target_url: "https://a.test/", sources: [] }] }).success).toBe(false);
    expect(alignmentTargetsResponseSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
  it("AT-C3 an unmeasured session figure is null, and 0 stays a distinct value", () => {
    const session = { session_id: ID, target_url: "https://a.test/", cluster_id: ID, status: "pending", alignment: null, target_band: null, percentile_vs_cited_docs: null, coverage_ratio: null, updated_at: "2026-11-09T00:00:00.000Z" };
    expect(alignmentTargetsResponseSchema.safeParse({ ...ok, sessions: [session] }).success).toBe(true);
    expect(alignmentTargetsResponseSchema.safeParse({ ...ok, sessions: [{ ...session, status: "ready", alignment: 0, coverage_ratio: 0, percentile_vs_cited_docs: 0 }] }).success).toBe(true);
  });
});

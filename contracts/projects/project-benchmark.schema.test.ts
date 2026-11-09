import { describe, expect, it } from "vitest";
import { projectBenchmarkParamsSchema, projectBenchmarkResponseSchema, topSourceDomainsSchema } from "./project-benchmark.schema.js";

const id = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
const engine = { engine_key: "chatgpt", metric_date: "2026-11-09", sample_size: 20, median_visibility: 41.2, p25_visibility: 30, p75_visibility: 52.5, median_aux_score: 66, top_source_domains: [{ domain: "g2.com", context_weight: 0.2 }] };

describe("GET /projects/{id}/benchmark response", () => {
  it("accepts an aggregate at exactly the minimum of 20 workspaces", () => {
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: [engine] }).success).toBe(true);
  });
  it("refuses a sample below 20: such a group has no row, so it can never be on the wire", () => {
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: [{ ...engine, sample_size: 19 }] }).success).toBe(false);
  });
  it("answers null, not an empty list, when no aggregate exists; a project with no category is the same", () => {
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: null }).success).toBe(true);
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: null, engines: null }).success).toBe(true);
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: [] }).success).toBe(false);
  });
  it("is strict: a workspace id (or anything else unknown) cannot ride along", () => {
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: null, workspace_id: id }).success).toBe(false);
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: [{ ...engine, workspace_id: id }] }).success).toBe(false);
  });
  it("refuses a missing or non-uuid project id on the path", () => {
    expect(projectBenchmarkParamsSchema.safeParse({ id }).success).toBe(true);
    expect(projectBenchmarkParamsSchema.safeParse({ id: "nope" }).success).toBe(false);
    expect(projectBenchmarkParamsSchema.safeParse({ id, x: 1 }).success).toBe(false);
  });
});

describe("platform_metrics.top_source_domains (jsonb)", () => {
  it("is a list of at most ten {domain, context_weight} entries with a weight in [0, 1]", () => {
    expect(topSourceDomainsSchema.safeParse([]).success).toBe(true);
    expect(topSourceDomainsSchema.safeParse([{ domain: "g2.com", context_weight: 1.2 }]).success).toBe(false);
    expect(topSourceDomainsSchema.safeParse(Array.from({ length: 11 }, (_, i) => ({ domain: `d${String(i)}.com`, context_weight: 0.1 }))).success).toBe(false);
    expect(topSourceDomainsSchema.safeParse([{ domain: "g2.com", context_weight: 0.2, workspace_id: id }]).success).toBe(false);
  });
});

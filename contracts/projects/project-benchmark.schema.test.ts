import { describe, expect, it } from "vitest";
import { projectBenchmarkParamsSchema, projectBenchmarkResponseSchema, topSourceDomainsSchema } from "./project-benchmark.schema.js";

const id = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
const engine = { engine_key: "chatgpt", metric_date: "2026-11-09", workspace_count_band: "20+", median_visibility: 41, p25_visibility: 30, p75_visibility: 53, median_aux_score: 66, top_source_domains: [{ domain: "g2.com" }] };

describe("GET /projects/{id}/benchmark response", () => {
  it("accepts an aggregate carrying the band \"20+\"", () => {
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: [engine] }).success).toBe(true);
  });
  it("owner decision 93 - the workspace count is only ever the band: an exact count (20, 23) or any other band is refused", () => {
    for (const count of [19, 20, 23, "20", "19+", "25+"]) {
      expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: [{ ...engine, workspace_count_band: count }] }).success).toBe(false);
    }
    expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: [{ ...engine, sample_size: 23 }] }).success).toBe(false);
  });
  it("owner decision 93 - every percentile and the AUX median is a whole number", () => {
    for (const key of ["median_visibility", "p25_visibility", "p75_visibility", "median_aux_score"]) {
      expect(projectBenchmarkResponseSchema.safeParse({ project_id: id, category_slug: "crm", engines: [{ ...engine, [key]: 41.2 }] }).success).toBe(false);
    }
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
  it("is an ordered list of at most ten {domain} entries and carries no weight", () => {
    expect(topSourceDomainsSchema.safeParse([]).success).toBe(true);
    expect(topSourceDomainsSchema.safeParse([{ domain: "g2.com" }]).success).toBe(true);
    expect(topSourceDomainsSchema.safeParse(Array.from({ length: 11 }, (_, i) => ({ domain: `d${String(i)}.com` }))).success).toBe(false);
    expect(topSourceDomainsSchema.safeParse([{ domain: "g2.com", context_weight: 0.2 }]).success).toBe(false);
    expect(topSourceDomainsSchema.safeParse([{ domain: "g2.com", workspace_id: id }]).success).toBe(false);
  });
});

import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectBenchmarkParamsSchema, projectBenchmarkResponseSchema } from "../../../contracts/projects/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { ProjectBenchmarkController } from "./project-benchmark.controller.js";
import { ProjectBenchmarkService } from "./project-benchmark.service.js";

vi.mock("../../lib/telemetry/metrics.js", () => ({ incrementCounter: vi.fn() }));

// STORY-176 · GET /v1/projects/{id}/benchmark — the read path of the category aggregate. Decision 91: a benchmark with no platform_metrics
// row is answered as null by the API.

const ID = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";

function clientAnswering(project: unknown[], published: unknown[] = []) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: sql.includes("FROM platform_metrics") ? published : project };
    }),
  };
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client } as never);
  return queries;
}

describe("GET /projects/{id}/benchmark · controller", () => {
  it("is declared with the contract schemas, so the path id is validated (400, not a uuid-cast 500) and the response is the documented shape", () => {
    const contract = Reflect.getMetadata(API_CONTRACT_KEY, ProjectBenchmarkController.prototype.read) as Record<string, unknown>;
    expect(contract).toMatchObject({ operationId: "getProjectBenchmark", paramsSchema: projectBenchmarkParamsSchema, responseSchema: projectBenchmarkResponseSchema });
  });
});

describe("GET /projects/{id}/benchmark · service", () => {
  beforeEach(() => vi.mocked(incrementCounter).mockClear());

  it("answers null engines when no aggregate exists for the category: null, not [] and not zeros", async () => {
    clientAnswering([{ category_slug: "crm" }], []);
    const result = await new ProjectBenchmarkService().read(ID);
    expect(result).toEqual({ project_id: ID, category_slug: "crm", engines: null });
    expect(incrementCounter).toHaveBeenCalledWith("nominara_project_benchmark_reads_total", { outcome: "none" });
  });

  it("answers null engines for a project with no category, and never reads platform_metrics for it", async () => {
    const queries = clientAnswering([{ category_slug: null }]);
    expect(await new ProjectBenchmarkService().read(ID)).toEqual({ project_id: ID, category_slug: null, engines: null });
    expect(queries.some((q) => q.sql.includes("platform_metrics"))).toBe(false);
  });

  it("carries a published aggregate through with whole numbers and the band, never the exact workspace count (decision 93)", async () => {
    clientAnswering([{ category_slug: "crm" }], [
      { engine_key: "chatgpt", metric_date: "2026-11-01", sample_size: 23, median_visibility: "41.000", p25_visibility: "30.000", p75_visibility: "53.000", median_aux_score: "66.000", top_source_domains: [{ domain: "g2.com" }] },
    ]);
    const result = await new ProjectBenchmarkService().read(ID);
    expect(result.engines![0]).toEqual({ engine_key: "chatgpt", metric_date: "2026-11-01", workspace_count_band: "20+", median_visibility: 41, p25_visibility: 30, p75_visibility: 53, median_aux_score: 66, top_source_domains: [{ domain: "g2.com" }] });
    expect(JSON.stringify(result)).not.toMatch(/sample_size|23/);
    expect(incrementCounter).toHaveBeenCalledWith("nominara_project_benchmark_reads_total", { outcome: "published" });
  });

  it("reads only rows inside the nightly batch window (7 days ending today, UTC), so a category that fell below 20 is not shown with old figures", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-08T12:00:00Z"), toFake: ["Date"] });
    try {
      const queries = clientAnswering([{ category_slug: "crm" }], []);
      await new ProjectBenchmarkService().read(ID);
      const read = queries.find((q) => q.sql.includes("FROM platform_metrics"))!;
      expect(read.sql).toMatch(/metric_date\s*>=\s*\$2/);
      expect(read.params).toEqual(["crm", "2026-11-02"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a project this workspace cannot see is a 404 (the read carries workspace_id = app.current_workspace())", async () => {
    const queries = clientAnswering([]);
    await expect(new ProjectBenchmarkService().read(ID)).rejects.toBeInstanceOf(NotFoundError);
    expect(queries[0]!.sql).toContain("workspace_id = app.current_workspace()");
  });
});

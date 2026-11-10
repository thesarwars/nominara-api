import { Injectable } from "@nestjs/common";
import type { ProjectBenchmarkResponse } from "../../../contracts/projects/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { readProjectBenchmark } from "../../lib/rollup/category-benchmarks.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-176 — `GET /projects/{id}/benchmark`. Reads the project's category and the published aggregate for it from `platform_metrics`
// (global, anonymised, at least 20 distinct workspaces). A category with no aggregate, and a project with no category, answer `engines: null`
// (decision 91). Reads only this database; no network call and no write, so it runs in the ambient transaction.
@Injectable()
export class ProjectBenchmarkService {
  async read(projectId: string): Promise<ProjectBenchmarkResponse> {
    const result = await readProjectBenchmark(currentTenantStore()!.client, projectId);
    if (result === undefined) throw new NotFoundError({ message: "no such project" });
    incrementCounter("nominara_project_benchmark_reads_total", { outcome: result.engines === null ? "none" : "published" });
    return result;
  }
}

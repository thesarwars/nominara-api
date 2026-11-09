import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { projectBenchmarkResponseSchema, topSourceDomainsSchema, type ProjectBenchmarkResponse } from "../../../contracts/projects/index.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-176 — category-relative benchmarks.
//
// WRITE. `refreshCategoryBenchmarks` asks `app.refresh_platform_metrics` (migration 0190, ADR-0005) to recompute `platform_metrics` for a project's
// category. The aggregate crosses the tenant boundary, so it is NOT computed here: a job inside one workspace's context sees one workspace. The
// function is the one place that reads other workspaces' rows (named columns only) and it returns two counts. What this file adds is WHICH
// categories and days to recompute, so that a category override moves a project out of the old slug and into the new one (AC4).
//
// READ. `readProjectBenchmark` answers the benchmark of the project's category from `platform_metrics`, a global table with no workspace column. A
// category with fewer than 20 contributing workspaces has no row, and that is answered as NULL, never as zeros (decision 91, AC2).

/** NFR-SEC-05 / decision 88(d): distinct contributing workspaces. The SQL function holds the same number as `c_min_workspaces`; the integration spec pins both at the boundary. */
export const MIN_BENCHMARK_WORKSPACES = 20;

/** The function refuses a wider range; a longer history is recomputed in windows of this many days. */
const FUNCTION_MAX_DAYS = 400;

const logger = new Logger("category-benchmarks");

export interface CategoryBenchmarkRefreshInput {
  readonly workspaceId: string;
  readonly projectId: string;
  /** The workspace-local days the rollup just recomputed. */
  readonly dates: readonly string[];
  /** The job's reason (a label for the metric). */
  readonly reason: string | undefined;
  /** The slug the project held before a category override. The recompute removes the project from it. */
  readonly previousCategorySlug?: string | undefined;
}

export interface CategoryBenchmarkRefreshResult {
  readonly categories: number;
  readonly written: number;
  readonly removed: number;
}

// A date-only ISO string parses as UTC midnight, so adding whole days is exact (no DST: this is UTC arithmetic).
const addDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Recomputes the aggregate for the project's CURRENT category and, after an override, its previous one. A project with no category (and no
 * previous one) rolls up as before and contributes to nothing: `categories: 0`.
 *
 * After an override the whole span of the project's metric history is recomputed, because every day it ever contributed to the old slug must lose it.
 * Idempotent: the function recomputes from current data, so a redelivered job lands the same state.
 *
 * Runs in the job's tenant transaction. Its own queries carry `workspace_id = app.current_workspace()`; the cross-tenant read is the function's.
 */
export async function refreshCategoryBenchmarks(tx: ClientBase, input: CategoryBenchmarkRefreshInput): Promise<CategoryBenchmarkRefreshResult> {
  return trace.getTracer("nominara.rollup").startActiveSpan("rollup.category_recompute", async (span) => {
    try {
      const project = await tx.query<{ category_slug: string | null }>(
        "SELECT category_slug FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL",
        [input.projectId],
      );
      const categories = [...new Set([project.rows[0]?.category_slug, input.previousCategorySlug].filter((c): c is string => c !== null && c !== undefined))];
      if (categories.length === 0) return { categories: 0, written: 0, removed: 0 };

      const override = input.previousCategorySlug !== undefined;
      const days = [...input.dates];
      if (override) {
        const span_ = await tx.query<{ first: string | null; last: string | null }>(
          `SELECT min(metric_date)::text AS first, max(metric_date)::text AS last
             FROM metric_daily
            WHERE project_id = $1 AND workspace_id = app.current_workspace() AND entity_type = 'brand'`,
          [input.projectId],
        );
        const { first, last } = span_.rows[0] ?? { first: null, last: null };
        if (first !== null) days.push(first);
        if (last !== null) days.push(last);
      }
      if (days.length === 0) return { categories: categories.length, written: 0, removed: 0 };

      const sorted = days.sort();
      const to = sorted[sorted.length - 1]!;
      let written = 0;
      let removed = 0;
      for (let from = sorted[0]!; from <= to; from = addDays(from, FUNCTION_MAX_DAYS + 1)) {
        const windowEnd = addDays(from, FUNCTION_MAX_DAYS) < to ? addDays(from, FUNCTION_MAX_DAYS) : to;
        const result = await tx.query<{ groups_written: number; groups_removed: number }>(
          "SELECT groups_written, groups_removed FROM app.refresh_platform_metrics($1::date, $2::date, $3::text[])",
          [from, windowEnd, categories],
        );
        written += result.rows[0]?.groups_written ?? 0;
        removed += result.rows[0]?.groups_removed ?? 0;
      }

      span.setAttribute("nominara.rollup.categories", categories.length);
      span.setAttribute("nominara.rollup.groups_written", written);
      span.setAttribute("nominara.rollup.groups_removed", removed);
      incrementCounter("nominara_rollup_category_recompute_total", { reason: input.reason ?? "rollup" });
      // The workspace id and the project id only: no slug, no score, nothing of another workspace's (which this job never sees).
      logger.log({ event: "rollup.category_recompute", workspace_id: input.workspaceId, project_id: input.projectId, categories: categories.length, groups_written: written, groups_removed: removed });
      return { categories: categories.length, written, removed };
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

interface BenchmarkRow {
  engine_key: string;
  metric_date: string;
  sample_size: number;
  median_visibility: string;
  p25_visibility: string;
  p75_visibility: string;
  median_aux_score: string;
  top_source_domains: unknown;
}

/**
 * The project's category benchmark, or `undefined` when the project is not visible to this workspace (so the caller answers 404, and a
 * project in another workspace is indistinguishable from none). `engines: null` means no aggregate exists: too few contributing workspaces,
 * or no category. Never an empty list and never zeros.
 */
export async function readProjectBenchmark(tx: Pick<ClientBase, "query">, projectId: string): Promise<ProjectBenchmarkResponse | undefined> {
  const project = await tx.query<{ category_slug: string | null }>(
    "SELECT category_slug FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL",
    [projectId],
  );
  const row = project.rows[0];
  if (row === undefined) return undefined;
  if (row.category_slug === null) return { project_id: projectId, category_slug: null, engines: null };

  // `platform_metrics` is global: no workspace predicate exists or applies. Each engine's newest day.
  const published = await tx.query<BenchmarkRow>(
    `SELECT DISTINCT ON (engine_key) engine_key, metric_date::text AS metric_date, sample_size,
            median_visibility::text, p25_visibility::text, p75_visibility::text, median_aux_score::text, top_source_domains
       FROM platform_metrics
      WHERE category_slug = $1
      ORDER BY engine_key, metric_date DESC`,
    [row.category_slug],
  );
  if (published.rows.length === 0) return { project_id: projectId, category_slug: row.category_slug, engines: null };

  return projectBenchmarkResponseSchema.parse({
    project_id: projectId,
    category_slug: row.category_slug,
    engines: published.rows.map((r) => ({
      engine_key: r.engine_key,
      metric_date: r.metric_date,
      sample_size: r.sample_size,
      median_visibility: Number(r.median_visibility),
      p25_visibility: Number(r.p25_visibility),
      p75_visibility: Number(r.p75_visibility),
      median_aux_score: Number(r.median_aux_score),
      top_source_domains: topSourceDomainsSchema.parse(r.top_source_domains),
    })),
  });
}

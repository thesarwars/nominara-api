import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool, PoolClient } from "pg";
import { WORKSPACE_COUNT_BAND, projectBenchmarkResponseSchema, topSourceDomainsSchema, type ProjectBenchmarkResponse } from "../../../contracts/projects/index.js";
import { SCORING_VERSION } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-176 — category-relative benchmarks.
//
// WRITE. A NIGHTLY job (`rollup.category_benchmark`) asks `app.apply_benchmark_membership` to move projects whose category changed into it (at most once per
// 7 days each), then asks `app.refresh_platform_metrics` (migration 0190, ADR-0005) to recompute `platform_metrics` for each category over the last
// `BENCHMARK_WINDOW_DAYS` days. The aggregate crosses the tenant boundary, so it is NOT computed inside any workspace's rollup: a job inside one workspace's
// context sees one workspace, and a category-wide recompute inside a tenant's transaction would hold its lock until that tenant committed (decision 93).
// A category override therefore moves nothing at once; the batch applies it. See the migration header for the differencing hazard this closes.
//
// READ. `readProjectBenchmark` answers the benchmark of the project's category from `platform_metrics`, a global table with no workspace column. A
// category with fewer than 20 contributing workspaces has no row, a row older than the batch window is not served, and both answer NULL, never zeros (decision 91, AC2).

/** NFR-SEC-05 / decision 88(d): distinct contributing workspaces. The SQL function holds the same number as `c_min_workspaces`; the integration spec pins both at the boundary. */
export const MIN_BENCHMARK_WORKSPACES = 20;

/** Decision 93: published figures are whole numbers and the count is a band. The SQL rounds; the contract's `z.number().int()` refuses anything else on the wire. */
export const BENCHMARK_WORKSPACE_BAND = WORKSPACE_COUNT_BAND;

/**
 * The nightly batch recomputes the last this-many UTC days (ending today), and the read path serves nothing older. One number for both, so a figure that
 * the batch no longer maintains is never shown: a category that has fallen below 20 stops answering within a window, instead of keeping old figures.
 * A project's category change waits for the batch and then for a 7-day cooldown (`app.apply_benchmark_membership` holds that constant).
 */
export const BENCHMARK_WINDOW_DAYS = 7;

/** Bounds on one category's recompute: it takes a lock per category, and a tenant's request never waits behind it (it is its own job). */
export const BENCHMARK_LOCK_TIMEOUT_MS = 5_000;
export const BENCHMARK_STATEMENT_TIMEOUT_MS = 120_000;

// A date-only ISO string parses as UTC midnight, so adding whole days is exact (no DST: this is UTC arithmetic).
const addDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);

/** The days the nightly batch recomputes and the read path serves: the last `BENCHMARK_WINDOW_DAYS` UTC days ending on `now`'s. */
export function benchmarkWindow(now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { from: addDays(to, -(BENCHMARK_WINDOW_DAYS - 1)), to };
}

export interface CategoryRefreshOptions {
  readonly now: Date;
  readonly scoringVersion?: string;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export interface CategoryRefreshResult {
  readonly written: number;
  readonly removed: number;
}

/**
 * The nightly membership step: every project's benchmark category moves to the category it holds now, at most once per 7 days. One short transaction of
 * its own, on a pool connection, with transaction-local timeouts. Returns the number of projects moved (a count, never which).
 */
export async function applyBenchmarkMembership(pool: Pool, options: Pick<CategoryRefreshOptions, "lockTimeoutMs" | "statementTimeoutMs"> = {}): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await setLocalTimeouts(client, options);
      const result = await client.query<{ projects_moved: number }>("SELECT projects_moved FROM app.apply_benchmark_membership()");
      await client.query("COMMIT");
      return result.rows[0]?.projects_moved ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/** `set_config(..., is_local => true)`: both limits die with the transaction, so a pooled session never carries them to the next caller. */
async function setLocalTimeouts(client: Pick<PoolClient, "query">, options: Pick<CategoryRefreshOptions, "lockTimeoutMs" | "statementTimeoutMs">): Promise<void> {
  await client.query("SELECT set_config('lock_timeout', $1, true)", [String(options.lockTimeoutMs ?? BENCHMARK_LOCK_TIMEOUT_MS)]);
  await client.query("SELECT set_config('statement_timeout', $1, true)", [String(options.statementTimeoutMs ?? BENCHMARK_STATEMENT_TIMEOUT_MS)]);
}

/**
 * Recomputes ONE category's aggregate over the batch window, in its own short transaction (decision 93 / M6): not a step of any workspace's rollup, so
 * a failure here can never roll a tenant's rollup back and the category lock is never held across a tenant's transaction. The function reads other
 * workspaces' rows (named columns only) and returns two counts; this adds WHICH category and days, and the bounds.
 *
 * Idempotent: the function recomputes from current data, so a redelivered or repeated job lands the same state.
 */
export async function refreshCategoryBenchmark(pool: Pool, category: string, options: CategoryRefreshOptions): Promise<CategoryRefreshResult> {
  return trace.getTracer("nominara.rollup").startActiveSpan("rollup.category_recompute", async (span) => {
    const client = await pool.connect();
    try {
      const { from, to } = benchmarkWindow(options.now);
      await client.query("BEGIN");
      try {
        await setLocalTimeouts(client, options);
        const result = await client.query<{ groups_written: number; groups_removed: number }>(
          "SELECT groups_written, groups_removed FROM app.refresh_platform_metrics($1::date, $2::date, $3::text[], $4::text)",
          [from, to, [category], options.scoringVersion ?? SCORING_VERSION],
        );
        await client.query("COMMIT");
        const written = result.rows[0]?.groups_written ?? 0;
        const removed = result.rows[0]?.groups_removed ?? 0;
        span.setAttribute("nominara.rollup.groups_written", written);
        span.setAttribute("nominara.rollup.groups_removed", removed);
        incrementCounter("nominara_rollup_category_recompute_total", { reason: "nightly" });
        return { written, removed };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      client.release();
      span.end();
    }
  });
}

/**
 * The categories the nightly batch recomputes: the whole taxonomy, and any category that still has a published row but is no longer in it (a value that
 * predates the taxonomy), so such a row is re-evaluated and removed rather than left to age. Both tables are global and readable by every runtime role.
 */
export async function listBenchmarkCategories(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ slug: string }>(
    `SELECT slug FROM business_categories
     UNION
     SELECT category_slug FROM platform_metrics
     ORDER BY 1`,
  );
  return result.rows.map((r) => r.slug);
}

interface BenchmarkRow {
  engine_key: string;
  metric_date: string;
  median_visibility: string;
  p25_visibility: string;
  p75_visibility: string;
  median_aux_score: string;
  top_source_domains: unknown;
}

/**
 * The project's category benchmark, or `undefined` when the project is not visible to this workspace (so the caller answers 404, and a
 * project in another workspace is indistinguishable from none). `engines: null` means no aggregate is served: too few contributing workspaces, a row
 * older than the batch window, or no category. Never an empty list and never zeros. `now` is injectable for tests.
 */
export async function readProjectBenchmark(tx: Pick<ClientBase, "query">, projectId: string, now: Date = new Date()): Promise<ProjectBenchmarkResponse | undefined> {
  const project = await tx.query<{ category_slug: string | null }>(
    "SELECT category_slug FROM projects WHERE id = $1 AND workspace_id = app.current_workspace() AND deleted_at IS NULL",
    [projectId],
  );
  const row = project.rows[0];
  if (row === undefined) return undefined;
  if (row.category_slug === null) return { project_id: projectId, category_slug: null, engines: null };

  // `platform_metrics` is global: no workspace predicate exists or applies. Each engine's newest day, and only within the window the nightly batch maintains.
  const { from } = benchmarkWindow(now);
  const published = await tx.query<BenchmarkRow>(
    `SELECT DISTINCT ON (engine_key) engine_key, metric_date::text AS metric_date,
            median_visibility::text, p25_visibility::text, p75_visibility::text, median_aux_score::text, top_source_domains
       FROM platform_metrics
      WHERE category_slug = $1 AND metric_date >= $2::date
      ORDER BY engine_key, metric_date DESC`,
    [row.category_slug, from],
  );
  if (published.rows.length === 0) return { project_id: projectId, category_slug: row.category_slug, engines: null };

  // The exact `sample_size` is not even selected: it is never published. Every row has at least 20 workspaces, and the only band is "20+".
  return projectBenchmarkResponseSchema.parse({
    project_id: projectId,
    category_slug: row.category_slug,
    engines: published.rows.map((r) => ({
      engine_key: r.engine_key,
      metric_date: r.metric_date,
      workspace_count_band: BENCHMARK_WORKSPACE_BAND,
      median_visibility: Number(r.median_visibility),
      p25_visibility: Number(r.p25_visibility),
      p75_visibility: Number(r.p75_visibility),
      median_aux_score: Number(r.median_aux_score),
      top_source_domains: topSourceDomainsSchema.parse(r.top_source_domains),
    })),
  });
}

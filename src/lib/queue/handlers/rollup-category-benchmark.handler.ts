import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import {
  applyBenchmarkMembership,
  benchmarkWindow,
  listBenchmarkCategories,
  refreshCategoryBenchmark,
  type CategoryRefreshOptions,
  type CategoryRefreshResult,
} from "../../rollup/category-benchmarks.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-176 / owner decision 93 — `rollup.category_benchmark`: the nightly batch behind `platform_metrics`.
//
//   1. app.apply_benchmark_membership — every project whose category changed since the last batch counts under its new category from now on, at most once per
//      7 days each. A category override moves nothing until this runs, so an attacker cannot override and read the effect straight away.
//   2. app.refresh_platform_metrics, ONE CATEGORY AT A TIME over the last `BENCHMARK_WINDOW_DAYS` days, each in its own short transaction with transaction-local
//      lock_timeout and statement_timeout.
//
// ⚠ NOT A STEP OF ANY WORKSPACE'S ROLLUP (it was, and held a category lock inside every tenant's transaction until that tenant committed). It is tenant-less: no
// workspace to name, so the queue is not tenant-scoped, and it needs no owner connection, because the cross-tenant read is inside the two definer functions
// the runtime role may execute (ADR-0005). A failure here can never roll a tenant's rollup back.
//
// ⚠ ONE CATEGORY FAILING DOES NOT STOP THE OTHERS, and a category that could not be recomputed is not a clean one: after every category was tried, the job FAILS
// (naming the count, never a slug) so the retry ladder re-runs it. All steps are idempotent, so re-running the ones that succeeded costs nothing.
//
// ⚠ DEBOUNCED: one job per UTC day (the topology's idempotency key), single-flight across replicas by the session advisory lock taken as a TRY — a replica that
// does not get it yields and loses nothing, because the next night asks the same question.
//
// The log line and the metrics carry counts only: no slug, score, domain or workspace (there is none).

const tracer = trace.getTracer("nominara.rollup");

export interface RollupCategoryBenchmarkDeps {
  readonly now?: () => Date;
  /** The per-category recompute, injectable so a test can make one category fail. */
  readonly refreshCategory?: (pool: Pool, category: string, options: CategoryRefreshOptions) => Promise<CategoryRefreshResult>;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export type RollupCategoryBenchmarkOutcome =
  | { readonly status: "complete"; readonly projectsMoved: number; readonly categories: number; readonly written: number; readonly removed: number }
  | { readonly status: "yielded" };

export function createRollupCategoryBenchmarkHandler(context: QueueHandlerContext, deps: RollupCategoryBenchmarkDeps = {}): JobProcessor<RollupCategoryBenchmarkOutcome> {
  const logger = new Logger("rollup.category_benchmark");
  const now = deps.now ?? (() => new Date());
  const refreshCategory = deps.refreshCategory ?? refreshCategoryBenchmark;

  // `_client` is the pooled connection `createJobProcessor` checks out for a non-tenant queue; this handler opens its own short transactions on the pool.
  return async (_client: ClientBase, _job: Job): Promise<RollupCategoryBenchmarkOutcome> => {
    const lockConnection = await context.pool.connect();
    const lockKey = globalQueueLockKey("rollup.category_benchmark");
    let held = false;
    try {
      held = await tryAdvisorySessionLock(lockConnection, lockKey);
      if (!held) {
        incrementCounter("nominara_rollup_category_benchmark_runs_total", { status: "yielded" });
        logger.warn({ event: "rollup.category_benchmark.yielded" });
        return { status: "yielded" };
      }
      return await tracer.startActiveSpan("rollup.category_benchmark", async (span) => {
        try {
          const timeouts = {
            ...(deps.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: deps.lockTimeoutMs }),
            ...(deps.statementTimeoutMs === undefined ? {} : { statementTimeoutMs: deps.statementTimeoutMs }),
          };
          const at = now();
          const projectsMoved = await applyBenchmarkMembership(context.pool, timeouts);
          const categories = await listBenchmarkCategories(context.pool);
          let written = 0;
          let removed = 0;
          let failed = 0;
          for (const category of categories) {
            try {
              const result = await refreshCategory(context.pool, category, { now: at, ...timeouts });
              written += result.written;
              removed += result.removed;
            } catch (error) {
              failed += 1;
              incrementCounter("nominara_rollup_category_recompute_failed_total");
              // The database's error code only: a message can carry row values, and the slug says which category was thin.
              logger.error({ event: "rollup.category_benchmark.category_failed", code: (error as { code?: unknown }).code ?? "unknown" });
            }
          }
          const window = benchmarkWindow(at);
          span.setAttribute("nominara.rollup.projects_moved", projectsMoved);
          span.setAttribute("nominara.rollup.categories", categories.length);
          span.setAttribute("nominara.rollup.categories_failed", failed);
          span.setAttribute("nominara.rollup.groups_written", written);
          span.setAttribute("nominara.rollup.groups_removed", removed);
          incrementCounter("nominara_rollup_category_benchmark_runs_total", { status: failed === 0 ? "complete" : "partial" });
          logger.log({ event: "rollup.category_benchmark.run", projects_moved: projectsMoved, categories: categories.length, categories_failed: failed, groups_written: written, groups_removed: removed, window_from: window.from, window_to: window.to });
          if (failed > 0) throw new Error(`category benchmark recompute failed for ${String(failed)} of ${String(categories.length)} categories`);
          return { status: "complete" as const, projectsMoved, categories: categories.length, written, removed };
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      });
    } finally {
      if (held && !(await releaseAdvisorySessionLock(lockConnection, lockKey))) {
        logger.error({ event: "rollup.category_benchmark.lock_not_held_at_release" });
      }
      lockConnection.release();
    }
  };
}

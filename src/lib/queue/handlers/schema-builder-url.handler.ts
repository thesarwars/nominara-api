import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { schemaBuilderUrlJobPayloadSchema, type SchemaBuilderUrlJobPayload, type SchemaBuilderUrlResult } from "../../../../contracts/tools/index.js";
import type { ProjectsService } from "../../../modules/projects/projects.service.js";
import type { ToolsService } from "../../../modules/tools/tools.service.js";
import type { Cache } from "../../cache/cache.port.js";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import { EntitlementResolver } from "../../entitlements/entitlement-resolver.js";
import type { ToolCatalogRow } from "../../tools/aux-audit-run.js";
import { checkUrlStructuredData, type UrlCheckDeps, type UrlCheckOutcome } from "../../tools/schema-builder-url-check.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { PHASES_DONE, type JobPhases } from "../worker-factory.js";
import type { QueueHandlerContext } from "../handlers.js";

// STORY-083 AC5 / owner decision 82 - Schema Builder URL mode, the worker half. It runs as a `lookup.execute` job whose payload says `tool: "schema_builder"` (the
// dispatcher is in lookup-execute.handler.ts), on the interactive pool.
//
//   prepare   one short tenant transaction: is the run still `running`? (a redelivery after it settled does nothing) and the rule catalog.
//   run       NO transaction: the page through the guarded fetcher and the shared structured-data rules (src/lib/tools/schema-builder-url-check.ts).
//   commit    one short tenant transaction: the result and the settlement through ToolsService.finishRun.
//
// WHAT IT WRITES: `tool_runs` through ToolsService.finishRun, and nothing else. No `aux_audits`, `aux_findings` or `patches` row, no fact row, no ledger row (the run is
// free and the database refuses a debit on it). THERE IS NO SECOND FETCH PATH: the fetch is schema-builder-url-check.ts's, and that file imports `guardedFetch`.

const logger = new Logger("lookup.execute.schema-builder-url");
const tracer = trace.getTracer("nominara-api");

export interface SchemaBuilderUrlDeps {
  readonly cache?: Cache;
  /** Test seam: the network (the guarded fetcher) and the timeout. */
  readonly check?: UrlCheckDeps;
  /** Test seam: the lifecycle half of ToolsService. */
  readonly tools?: () => Promise<Pick<ToolsService, "finishRun">>;
  readonly now?: () => Date;
}

interface Prepared {
  readonly payload: SchemaBuilderUrlJobPayload & { workspaceId: string };
  readonly catalog: readonly ToolCatalogRow[];
}

interface Fetched {
  readonly outcome: UrlCheckOutcome;
  readonly durationMs: number;
}

function isFinalAttempt(job: Job): boolean {
  const attempts = job.opts?.attempts;
  return attempts !== undefined && (job.attemptsMade ?? 0) + 1 >= attempts;
}

export function createSchemaBuilderUrlPhases(context: QueueHandlerContext, deps: SchemaBuilderUrlDeps = {}): JobPhases<Prepared, Fetched> {
  const now = deps.now ?? ((): Date => new Date());
  let cacheReady: Promise<Cache> | undefined;
  const liveCache = (): Promise<Cache> =>
    (cacheReady ??=
      deps.cache !== undefined
        ? Promise.resolve(deps.cache)
        : (async () => {
            const adapter = new ValkeyCacheAdapter(context.env.VALKEY_CACHE_URL);
            await adapter.connect();
            return adapter;
          })());
  // Imported when first used, not at load: the cycle lookup-execute.handler.ts documents (ProjectsService <-> the handler registry).
  const tools =
    deps.tools ??
    (async (): Promise<ToolsService> => {
      const { ToolsService: Service } = await import("../../../modules/tools/tools.service.js");
      return new Service(new EntitlementResolver(await liveCache(), context.pool), {
        create: () => {
          throw new Error("a schema-builder job never converts a run");
        },
      } as unknown as ProjectsService);
    });

  const prepare = async (tx: ClientBase, job: Job): Promise<Prepared | typeof PHASES_DONE> => {
    const payload = schemaBuilderUrlJobPayloadSchema.parse((job.data as { payload: unknown }).payload) as Prepared["payload"];
    // THE RUN ROW IS THE TRUTH, not the payload: a redelivery after the run settled does nothing (at-least-once delivery).
    const run = await tx.query<{ status: string }>("SELECT status FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1", [payload.toolRunId]);
    if (run.rows[0]?.status !== "running") return PHASES_DONE;
    // The catalog is global, versioned data: the same rows the in-project audit judges by.
    const catalog = await tx.query<Omit<ToolCatalogRow, "weight"> & { weight: string | number }>(
      "SELECT code, category, title, weight, rule_version, thresholds, task_threshold, auto_fixable, rationale FROM aux_rule_catalog",
    );
    return { payload, catalog: catalog.rows.map((r) => ({ ...r, weight: Number(r.weight) })) };
  };

  const run = async (prepared: Prepared): Promise<Fetched> => {
    const { payload } = prepared;
    const started = now();
    return await tracer.startActiveSpan("tools.schema_builder_url.run", async (span) => {
      try {
        span.setAttributes({ "nominara.workspace_id": payload.workspaceId, "nominara.run_id": payload.toolRunId });
        const outcome = await checkUrlStructuredData({ url: payload.targetUrl, catalog: prepared.catalog }, deps.check ?? {});
        span.setAttribute("nominara.schema_builder_url.outcome", outcome.kind);
        return { outcome, durationMs: Math.max(0, now().getTime() - started.getTime()) };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  };

  const commit = async (_tx: ClientBase, prepared: Prepared, fetched: Fetched): Promise<void> => {
    const { payload } = prepared;
    const { outcome } = fetched;
    const checked = outcome.kind === "checked";
    // An unreachable page is a `failed` run (nothing was delivered); the result names the reason and says nothing about the page.
    const result: SchemaBuilderUrlResult = checked ? outcome.result : { schema_version: 1, source: "url", state: "unreachable", reason: outcome.reason };
    await (await tools()).finishRun(payload.toolRunId, {
      result,
      durationMs: fetched.durationMs,
      cacheLayer: "live",
      ...(checked ? {} : { failed: true, errorCode: "page_unreachable" }),
    });
    const label = checked ? "checked" : outcome.reason;
    incrementCounter("nominara_tools_schema_builder_url_runs_total", { outcome: checked ? "checked" : "unreachable", reason: checked ? "none" : outcome.reason });
    observeValue("nominara_tools_schema_builder_url_duration_ms", fetched.durationMs, { outcome: checked ? "checked" : "unreachable" });
    // Ids, the outcome and a count: never the URL, a finding or a field path.
    logger.log({ event: "tools.schema_builder_url.finished", workspace_id: payload.workspaceId, run_id: payload.toolRunId, outcome: label, findings: checked ? outcome.result.findings.length : null });
  };

  /** The last attempt settles the run as failed instead of dead-lettering a run nobody will otherwise close. */
  const recover = async (_tx: ClientBase, job: Job): Promise<boolean> => {
    if (!isFinalAttempt(job)) return false;
    const payload = schemaBuilderUrlJobPayloadSchema.parse((job.data as { payload: unknown }).payload);
    await (await tools()).finishRun(payload.toolRunId, { failed: true, errorCode: "schema_builder_job_failed" });
    logger.warn({ event: "tools.schema_builder_url.job_failed", run_id: payload.toolRunId });
    return true;
  };

  return { prepare, run, commit, recover };
}

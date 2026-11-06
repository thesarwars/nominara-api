import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { auxAuditToolJobPayloadSchema, type AuxAuditToolJobPayload, type AuxAuditToolResult } from "../../../../contracts/tools/index.js";
import type { ProjectsService } from "../../../modules/projects/projects.service.js";
import type { ToolsService } from "../../../modules/tools/tools.service.js";
import { cacheKeyNamespace } from "../../cache/key-namespace.js";
import type { Cache } from "../../cache/cache.port.js";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import { EntitlementResolver } from "../../entitlements/entitlement-resolver.js";
import { toRegistrableDomain } from "../../net/registrable-domain.js";
import { runToolAudit, type ToolAuditDeps, type ToolAuditOutcome, type ToolCatalogRow } from "../../tools/aux-audit-run.js";
import { writeSiteFilesCache } from "../../aux/site-files-cache.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { PHASES_DONE, type JobPhases } from "../worker-factory.js";
import type { QueueHandlerContext } from "../handlers.js";

// STORY-082 - the AUX audit tool's worker half. It runs as a `lookup.execute` job whose payload says `tool: "aux_audit"` (the dispatcher is in
// lookup-execute.handler.ts), on the dedicated interactive pool.
//
//   prepare   one short tenant transaction: is the run still `running`? is the domain VERIFIED in this workspace? the rule catalog.
//   run       NO transaction: the site files and (full mode) the pages, raw AND rendered, through the EXISTING guarded fetcher, page crawl, rules and score
//             (src/lib/tools/aux-audit-run.ts). A site-files answer is written to the per-host cache here, outside any transaction.
//   commit    one short tenant transaction: the result, the headline and the settlement. Nothing delivered is refunded in full; a partial audit is charged in full.
//
// WHAT IT WRITES: `tool_runs` through ToolsService.finishRun and one cache key. No `aux_audits`, `aux_findings` or `patches` row, no fact row (FR-TL-11).
// THERE IS NO SECOND FETCH PATH: the fetches are tool-audit.ts's, and that file imports `guardedFetch` and no socket module.

const logger = new Logger("lookup.execute.aux-audit");
const tracer = trace.getTracer("nominara-api");

export interface AuxAuditToolDeps {
  readonly cache?: Cache;
  readonly audit?: ToolAuditDeps;
  readonly now?: () => Date;
}

interface Prepared {
  readonly payload: AuxAuditToolJobPayload & { workspaceId: string };
  readonly verified: boolean;
  readonly catalog: readonly ToolCatalogRow[];
}

interface Fetched {
  readonly outcome: ToolAuditOutcome;
  readonly durationMs: number;
}

function isFinalAttempt(job: Job): boolean {
  const attempts = job.opts?.attempts;
  return attempts !== undefined && (job.attemptsMade ?? 0) + 1 >= attempts;
}

export function createAuxAuditToolPhases(context: QueueHandlerContext, deps: AuxAuditToolDeps = {}): JobPhases<Prepared, Fetched> {
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
  const tools = async (): Promise<ToolsService> => {
    const { ToolsService: Service } = await import("../../../modules/tools/tools.service.js");
    return new Service(new EntitlementResolver(await liveCache(), context.pool), {
      create: () => {
        throw new Error("an aux-audit job never converts a run");
      },
    } as unknown as ProjectsService);
  };

  const prepare = async (tx: ClientBase, job: Job): Promise<Prepared | typeof PHASES_DONE> => {
    const payload = auxAuditToolJobPayloadSchema.parse((job.data as { payload: unknown }).payload) as Prepared["payload"];
    // THE RUN ROW IS THE TRUTH, not the payload: a redelivery after the run settled does nothing (at-least-once delivery).
    const run = await tx.query<{ status: string }>("SELECT status FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1", [payload.toolRunId]);
    if (run.rows[0]?.status !== "running") return PHASES_DONE;
    // AUTHORIZE: the domain is verified when a project of THIS workspace holds a verified row for it (the table is the authority). Fails closed.
    let domain: string;
    try {
      domain = toRegistrableDomain(payload.targetUrl);
    } catch {
      domain = "";
    }
    const verified = domain === "" ? false : (await tx.query("SELECT 1 FROM domain_verifications dv JOIN projects p ON p.id = dv.project_id WHERE dv.domain = $1 AND dv.verified_at IS NOT NULL AND p.deleted_at IS NULL LIMIT 1", [domain])).rows.length > 0;
    // The catalog is versioned data; its weights are asserted again when the engine loads it.
    const catalog = await tx.query<Omit<ToolCatalogRow, "weight"> & { weight: string | number }>(
      "SELECT code, category, title, weight, rule_version, thresholds, task_threshold, auto_fixable, rationale FROM aux_rule_catalog",
    );
    return { payload, verified, catalog: catalog.rows.map((r) => ({ ...r, weight: Number(r.weight) })) };
  };

  const run = async (prepared: Prepared): Promise<Fetched> => {
    const { payload } = prepared;
    const started = now();
    return await tracer.startActiveSpan("tools.aux_audit.run", async (span) => {
      try {
        span.setAttributes({ "nominara.workspace_id": payload.workspaceId, "nominara.run_id": payload.toolRunId, "nominara.aux.mode": payload.mode, "nominara.aux.verified": prepared.verified });
        const outcome = await runToolAudit({ url: payload.targetUrl, mode: payload.mode, pages: payload.pages ?? 1, verified: prepared.verified, credits: payload.credits, catalog: prepared.catalog }, deps.audit ?? {});
        if (outcome.kind === "done" && payload.mode === "site_files") {
          // Cached per host (AC1) so a repeat check costs nothing and adds no load. A cache that cannot be written is logged, never fatal: the answer is still delivered.
          try {
            await writeSiteFilesCache(await liveCache(), cacheKeyNamespace(), outcome.result.host, outcome.result.site_files);
          } catch (error) {
            logger.warn({ event: "tools.aux_audit.cache_write_failed", workspace_id: payload.workspaceId, error: error instanceof Error ? error.name : "unknown" });
          }
        }
        span.setAttribute("nominara.aux.kind", outcome.kind);
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
    const result: AuxAuditToolResult | null = outcome.kind === "done" ? outcome.result : null;
    // Nothing delivered (no site file answered, or not one page could be audited): `failed`, and the charge is returned in full. Otherwise the run is
    // charged in full - including a partial audit, whose unreachable pages the result names.
    const delivered = outcome.kind === "done" && outcome.delivered;
    await (await tools()).finishRun(payload.toolRunId, {
      failed: !delivered,
      result,
      // `null` is "not measured": a site-files check judges no page, so it publishes no score and no page count; a full audit that reached no page measured zero pages.
      headline: outcome.kind === "done" ? { aux_score: outcome.auxScore, pages_scanned: payload.mode === "full" ? outcome.pagesScanned : null } : {},
      durationMs: fetched.durationMs,
      cacheLayer: "live",
      ...(delivered ? {} : { errorCode: outcome.kind === "unreachable" ? "site_unreachable" : "no_page_reachable" }),
    });
    incrementCounter("nominara_tools_aux_audit_runs_total", { mode: payload.mode, outcome: delivered ? "delivered" : outcome.kind === "unreachable" ? "site_unreachable" : "no_page_reachable" });
    observeValue("nominara_tools_aux_audit_duration_ms", fetched.durationMs, { mode: payload.mode });
    logger.log({ event: "tools.aux_audit.finished", workspace_id: payload.workspaceId, run_id: payload.toolRunId, mode: payload.mode, delivered, verified: prepared.verified });
  };

  /** The last attempt settles the run as failed and refunds it, rather than dead-lettering a charge that was never earned. */
  const recover = async (_tx: ClientBase, job: Job): Promise<boolean> => {
    if (!isFinalAttempt(job)) return false;
    const payload = auxAuditToolJobPayloadSchema.parse((job.data as { payload: unknown }).payload);
    await (await tools()).finishRun(payload.toolRunId, { failed: true, errorCode: "audit_job_failed" });
    logger.warn({ event: "tools.aux_audit.job_failed", run_id: payload.toolRunId });
    return true;
  };

  return { prepare, run, commit, recover };
}

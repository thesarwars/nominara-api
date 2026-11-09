import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { COMPETITOR_FINDER_CREDITS, type CompetitorFinderAccepted, type CompetitorFinderRequest } from "../../../contracts/tools/index.js";
import { PreconditionUnmetError, PriceChangedError, UnsafeTargetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { parseConfirmedCredits, requireConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { GuardedFetchRefusal } from "../../lib/net/guarded-fetch.js";
import { UnparsableHostError } from "../../lib/net/registrable-domain.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { compensateDailyCounter } from "../../lib/usage/daily-cap.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { afterCommit, currentTenantStore, withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";
import { ToolsService } from "./tools.service.js";
import { VisibilityScanService } from "./visibility-scan.service.js";

// STORY-081 - POST /v1/tools/competitor-finder. THE REQUEST NEVER FETCHES THE PAGE AND NEVER TOUCHES AN ENGINE (KAD-06).
//
// It does three things in the request's own transaction: refuses an unsafe URL (the SAME guard project creation uses - DNS is resolved, no socket is opened),
// charges the flat price through ToolsService.startRun (a ledger debit in the same transaction as the run row), and enqueues `lookup.execute` after commit.
// The page fetch (through the audited guarded fetcher), the category query and the one capture all happen in the worker. The result is read from
// GET /v1/tools/runs/{id}, like every tool's.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("tools.competitor-finder");

@Injectable()
export class CompetitorFinderService {
  constructor(
    private readonly tools: ToolsService,
    private readonly scans: VisibilityScanService,
    private readonly entitlements: EntitlementResolver,
    private readonly urls: UrlGuard,
    private readonly queues: QueueProducer,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async start(tenant: TenantContext, body: CompetitorFinderRequest, confirmedCredits: string | readonly string[] | undefined): Promise<CompetitorFinderAccepted> {
    return await tracer.startActiveSpan("tools.competitor_finder.start", async (span) => {
      try {
        span.setAttribute("nominara.workspace_id", tenant.workspaceId);
        // Both refusals are BEFORE anything is written: the header, then the URL.
        const confirmed = requireConfirmedCredits(parseConfirmedCredits(confirmedCredits));
        if (confirmed !== COMPETITOR_FINDER_CREDITS) {
          throw new PriceChangedError({ message: "the confirmed price does not match this tool's price", details: { shown: confirmed, recomputed: COMPETITOR_FINDER_CREDITS, reason: "the confirmed figure is not the flat price of a Competitor Finder run" } });
        }
        try {
          await this.urls.validateAndNormalize(body.url);
        } catch (error) {
          if (error instanceof GuardedFetchRefusal) throw new UnsafeTargetError({ message: "this URL cannot be fetched", details: { reason: error.reason } });
          if (error instanceof UnparsableHostError) {
            throw new ValidationFailedError({ message: "url has no registrable domain", details: { issues: [{ path: ["url"], message: "not a domain anyone can own" }] } });
          }
          throw error;
        }
        const store = currentTenantStore();
        if (store === undefined) throw new Error("CompetitorFinderService requires an active tenant context");
        const resolved = await this.entitlements.resolveForWorkspace(tenant.workspaceId);
        // One capture, on one engine: the first of the plan's Tools set that can capture (FR-TL-07: no picker).
        const engines = await this.scans.engineSet(store.client, resolved);
        const engine = engines[0];
        if (engine === undefined) {
          throw new PreconditionUnmetError({ message: "no engine in your plan's Tools set can capture yet, so nothing was started and nothing was charged", details: { reason: "no_capturable_scope" } });
        }
        const started = await this.tools.startRun({ toolKey: "competitor_finder", brandUrl: body.url, engineKeys: [engine.engine_key], credits: COMPETITOR_FINDER_CREDITS, entitlements: resolved.entitlements });
        const payload = { tool: "competitor_finder", toolRunId: started.id, targetUrl: body.url, engine: engine.engine_key, locale: "en-US", startedAt: new Date().toISOString() };
        afterCommit(() => {
          this.queues
            .enqueueTenantJob("lookup.execute", tenant.workspaceId, payload, { idempotencyKey: `lookup:${started.id}`, priorityVariant: "interactive" })
            .catch((error: unknown) => {
              // Charged and never to be answered: settle it NOW as failed and refunded.
              logger.error({ event: "tools.competitor_finder.enqueue_failed", workspace_id: tenant.workspaceId, run_id: started.id, error: error instanceof Error ? error.name : "unknown" });
              incrementCounter("nominara_tools_competitor_finder_enqueue_failed_total");
              void this.abandon(tenant, started.id, engine.engine_key);
            });
        });
        incrementCounter("nominara_tools_competitor_finder_requests_total", { result: "started" });
        logger.log({ event: "tools.competitor_finder.accepted", workspace_id: tenant.workspaceId, run_id: started.id });
        return {
          tool_run_id: started.id,
          status: "running" as const,
          credits_charged: started.creditsCharged,
          engine: { engine_key: engine.engine_key, display_name: engine.display_name },
          poll: `/v1/tools/runs/${started.id}`,
        };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        incrementCounter("nominara_tools_competitor_finder_requests_total", { result: "refused" });
        // Nothing was started or charged: the daily allowance the guard consumed for this request is given back.
        await this.giveBackDailyAllowance(tenant);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async abandon(tenant: TenantContext, runId: string, engine: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, tenant, async () => {
        await this.tools.finishRun(runId, { enginesSucceeded: [], enginesFailed: [engine], errorCode: "finder_not_queued" });
      });
    } catch (error) {
      logger.error({ event: "tools.competitor_finder.abandon_failed", workspace_id: tenant.workspaceId, run_id: runId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      client.release();
    }
  }

  private async giveBackDailyAllowance(tenant: TenantContext): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, tenant, async (tx) => compensateDailyCounter(tx, tenant.workspaceId, "lookup"));
    } catch (error) {
      logger.warn({ event: "tools.competitor_finder.daily_cap_compensation_failed", workspace_id: tenant.workspaceId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      client.release();
    }
  }
}

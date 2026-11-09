import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import type { SchemaBuilderUrlAccepted, SchemaBuilderUrlRequest, SchemaBuilderUrlResult } from "../../../contracts/tools/index.js";
import { UnsafeTargetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { GuardedFetchRefusal } from "../../lib/net/guarded-fetch.js";
import { UnparsableHostError } from "../../lib/net/registrable-domain.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { afterCommit, currentTenantStore, withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";
import { ToolsService } from "./tools.service.js";

// STORY-083 AC5 / owner decision 82 - POST /v1/tools/schema-builder/url: the URL path of Schema Builder Check. THE REQUEST NEVER FETCHES THE PAGE (KAD-06).
//
// It refuses an unsafe URL (the SAME guard project creation uses: DNS is resolved, no socket is opened), writes a `running` free run through ToolsService (one
// table, one owning service), and enqueues `lookup.execute` AFTER the commit. The page is fetched, judged and the run finished in the worker
// (src/lib/queue/handlers/schema-builder-url.handler.ts). The result is read from GET /v1/tools/runs/{id}, like every tool's.
//
// A SEPARATE SERVICE from SchemaBuilderService on purpose: that one is the paste path's SAVE, and its spec asserts it can reach no queue, fetch or network. This one
// reaches the queue, and only the queue.
//
// FREE: credits are 0, no entitlement is read, and the database refuses a debit on a schema_builder row (`ck_tr_free_tools`).

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("tools.schema-builder-url");

/** The result a Schema Builder run must carry from its first write (the table requires it); it says nothing about the page. */
const PENDING_RESULT: SchemaBuilderUrlResult = { schema_version: 1, source: "url", state: "pending" };

@Injectable()
export class SchemaBuilderUrlService {
  constructor(
    private readonly tools: ToolsService,
    private readonly urls: UrlGuard,
    private readonly queues: QueueProducer,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async start(tenant: TenantContext, body: SchemaBuilderUrlRequest): Promise<SchemaBuilderUrlAccepted> {
    return await tracer.startActiveSpan("tools.schema_builder_url.start", async (span) => {
      try {
        span.setAttribute("nominara.workspace_id", tenant.workspaceId);
        // Refused BEFORE anything is written: an internal address is a 422 and no run exists.
        try {
          await this.urls.validateAndNormalize(body.url);
        } catch (error) {
          if (error instanceof GuardedFetchRefusal) throw new UnsafeTargetError({ message: "this URL cannot be fetched", details: { reason: error.reason } });
          if (error instanceof UnparsableHostError) {
            throw new ValidationFailedError({ message: "url has no registrable domain", details: { issues: [{ path: ["url"], message: "not a domain anyone can own" }] } });
          }
          throw error;
        }
        if (currentTenantStore() === undefined) throw new Error("SchemaBuilderUrlService requires an active tenant context");

        const started = await this.tools.startRun({ toolKey: "schema_builder", targetUrl: body.url, resultJson: PENDING_RESULT, credits: 0 });
        const payload = { tool: "schema_builder", toolRunId: started.id, targetUrl: body.url, startedAt: new Date().toISOString() };
        afterCommit(() => {
          this.queues
            .enqueueTenantJob("lookup.execute", tenant.workspaceId, payload, { idempotencyKey: `lookup:${started.id}`, priorityVariant: "interactive" })
            .catch((error: unknown) => {
              // Accepted and never to be answered: settle it NOW as failed.
              logger.error({ event: "tools.schema_builder_url.enqueue_failed", workspace_id: tenant.workspaceId, run_id: started.id, error: error instanceof Error ? error.name : "unknown" });
              incrementCounter("nominara_tools_schema_builder_url_enqueue_failed_total");
              void this.abandon(tenant, started.id);
            });
        });
        incrementCounter("nominara_tools_schema_builder_url_requests_total", { result: "started" });
        // Ids only: never the URL.
        logger.log({ event: "tools.schema_builder_url.accepted", workspace_id: tenant.workspaceId, run_id: started.id });
        return { tool_run_id: started.id, tool_key: "schema_builder" as const, mode: "check" as const, source: "url" as const, status: "running" as const, credits_charged: 0 as const, poll: `/v1/tools/runs/${started.id}` };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        incrementCounter("nominara_tools_schema_builder_url_requests_total", { result: "refused" });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async abandon(tenant: TenantContext, runId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, tenant, async () => {
        await this.tools.finishRun(runId, { failed: true, errorCode: "schema_builder_not_queued" });
      });
    } catch (error) {
      logger.error({ event: "tools.schema_builder_url.abandon_failed", workspace_id: tenant.workspaceId, run_id: runId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      client.release();
    }
  }
}

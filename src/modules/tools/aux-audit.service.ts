import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import {
  auxAuditToolResultSchema,
  type AuxAuditToolAccepted,
  type AuxAuditToolEstimate,
  type AuxAuditToolRequest,
} from "../../../contracts/tools/index.js";
import { PriceChangedError, UnsafeTargetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { auxAuditEstimate } from "../../lib/aux/audit-band.js";
import { pageCapForPlan } from "../../lib/aux/page-selection.js";
import { readSiteFilesCache } from "../../lib/aux/site-files-cache.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { parseConfirmedCredits, requireConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { GuardedFetchRefusal } from "../../lib/net/guarded-fetch.js";
import { UnparsableHostError } from "../../lib/net/registrable-domain.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { afterCommit, currentTenantStore, withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";
import { ToolsService } from "./tools.service.js";

// STORY-082 - POST /v1/tools/aux-audit and its free estimate. THE REQUEST NEVER FETCHES THE SITE (KAD-06).
//
// It refuses an unsafe URL (the SAME guard project creation uses - DNS is resolved, no socket is opened), then
//   site_files  charges 0. A per-host cache hit answers from the cache in this very request - the run is written `completed`, no job, no fetch. A miss enqueues.
//   full        recomputes the page-band price in the request transaction and requires it echoed in X-Nominara-Confirmed-Credits (absent 400, a mismatch 409,
//               both before any debit); the debit and the run row commit together; the job is enqueued after commit.
// VERIFICATION IS READ, NEVER PRICED: it decides the scope the response reports and the worker enforces, and the figure above does not take it as an input.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("tools.aux-audit");

@Injectable()
export class AuxAuditToolService {
  constructor(
    private readonly tools: ToolsService,
    private readonly entitlements: EntitlementResolver,
    private readonly urls: UrlGuard,
    private readonly queues: QueueProducer,
    @Inject(CACHE) private readonly cache: Cache,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** The free paired estimate: the band, the figure, and what it includes. Recomputed from the page count on every call; no ledger row, no run, no job. */
  async estimate(pages: number | undefined): Promise<AuxAuditToolEstimate> {
    const cap = await this.pageCap();
    try {
      const estimate = auxAuditEstimate(pages ?? cap, cap);
      incrementCounter("nominara_tools_aux_audit_estimates_total", { band: estimate.band.beyond_first_band ? "beyond_first" : "first" });
      return estimate;
    } catch (error) {
      if (error instanceof RangeError) throw this.pagesRefused(cap);
      throw error;
    }
  }

  async start(tenant: TenantContext, body: AuxAuditToolRequest, confirmedCredits: string | readonly string[] | undefined): Promise<AuxAuditToolAccepted> {
    return await tracer.startActiveSpan("tools.aux_audit.start", async (span) => {
      try {
        span.setAttributes({ "nominara.workspace_id": tenant.workspaceId, "nominara.aux.mode": body.mode });
        // Every refusal is BEFORE anything is written. The URL first: an internal address is a 422 whatever the price header says.
        let rootDomain: string;
        try {
          rootDomain = (await this.urls.validateAndNormalize(body.url)).rootDomain;
        } catch (error) {
          if (error instanceof GuardedFetchRefusal) throw new UnsafeTargetError({ message: "this URL cannot be fetched", details: { reason: error.reason } });
          if (error instanceof UnparsableHostError) {
            throw new ValidationFailedError({ message: "url has no registrable domain", details: { issues: [{ path: ["url"], message: "not a domain anyone can own" }] } });
          }
          throw error;
        }
        const store = currentTenantStore();
        if (store === undefined) throw new Error("AuxAuditToolService requires an active tenant context");
        const host = new URL(body.url).hostname.toLowerCase();
        const verified = (await store.client.query("SELECT 1 FROM domain_verifications dv JOIN projects p ON p.id = dv.project_id WHERE dv.domain = $1 AND dv.verified_at IS NOT NULL AND p.deleted_at IS NULL LIMIT 1", [rootDomain])).rows.length > 0;

        if (body.mode === "site_files") return await this.startSiteFiles(tenant, body.url, host, verified);

        const cap = await this.pageCap();
        let estimate: AuxAuditToolEstimate;
        try {
          estimate = auxAuditEstimate(body.pages ?? cap, cap);
        } catch (error) {
          if (error instanceof RangeError) throw this.pagesRefused(cap);
          throw error;
        }
        const confirmed = requireConfirmedCredits(parseConfirmedCredits(confirmedCredits));
        if (confirmed !== estimate.credits) {
          throw new PriceChangedError({ message: "the confirmed price does not match this audit's price", details: { shown: confirmed, recomputed: estimate.credits, reason: "the confirmed figure is not the price of the requested page band" } });
        }
        const resolved = await this.entitlements.resolveForWorkspace(tenant.workspaceId);
        const started = await this.tools.startRun({ toolKey: "aux_audit", brandName: host, targetUrl: body.url, credits: estimate.credits, entitlements: resolved.entitlements });
        this.enqueue(tenant, started.id, { mode: "full", targetUrl: body.url, pages: estimate.pages, credits: estimate.credits });
        incrementCounter("nominara_tools_aux_audit_requests_total", { mode: "full", result: "started" });
        logger.log({ event: "tools.aux_audit.accepted", workspace_id: tenant.workspaceId, run_id: started.id, mode: "full", verified });
        return { tool_run_id: started.id, mode: "full" as const, status: "running" as const, cached: false, credits_charged: started.creditsCharged, pages_requested: estimate.pages, scope: verified ? ("key_pages" as const) : ("public_surface" as const), domain_verified: verified, poll: `/v1/tools/runs/${started.id}` };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        incrementCounter("nominara_tools_aux_audit_requests_total", { mode: body.mode, result: "refused" });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async startSiteFiles(tenant: TenantContext, url: string, host: string, verified: boolean): Promise<AuxAuditToolAccepted> {
    const started = await this.tools.startRun({ toolKey: "aux_audit", brandName: host, targetUrl: url, credits: 0 });
    // A cache that cannot be read is a miss, never an error: the check then runs.
    const cached = await readSiteFilesCache(this.cache, cacheKeyNamespace(), host).catch((error: unknown) => {
      logger.warn({ event: "tools.aux_audit.cache_read_failed", workspace_id: tenant.workspaceId, error: error instanceof Error ? error.name : "unknown" });
      return null;
    });
    if (cached !== null) {
      // SERVED FROM THE CACHE: no fetch, no job, no charge. The run is settled here so the timeline and re-opening work like any other run.
      const result = auxAuditToolResultSchema.parse({ schema_version: 1, mode: "site_files", url, host, domain_verified: verified, scope: "public_surface", site_files: cached, audit: null });
      await this.tools.finishRun(started.id, { result, headline: { aux_score: null, pages_scanned: null }, cacheLayer: "l1", durationMs: 0 });
      incrementCounter("nominara_tools_aux_audit_site_files_cache_total", { result: "hit" });
      incrementCounter("nominara_tools_aux_audit_requests_total", { mode: "site_files", result: "cached" });
      logger.log({ event: "tools.aux_audit.site_files_cache_hit", workspace_id: tenant.workspaceId, run_id: started.id });
      return { tool_run_id: started.id, mode: "site_files", status: "completed", cached: true, credits_charged: 0, pages_requested: null, scope: "public_surface", domain_verified: verified, poll: `/v1/tools/runs/${started.id}` };
    }
    incrementCounter("nominara_tools_aux_audit_site_files_cache_total", { result: "miss" });
    this.enqueue(tenant, started.id, { mode: "site_files", targetUrl: url, pages: null, credits: 0 });
    incrementCounter("nominara_tools_aux_audit_requests_total", { mode: "site_files", result: "started" });
    logger.log({ event: "tools.aux_audit.accepted", workspace_id: tenant.workspaceId, run_id: started.id, mode: "site_files", verified });
    return { tool_run_id: started.id, mode: "site_files", status: "running", cached: false, credits_charged: 0, pages_requested: null, scope: "public_surface", domain_verified: verified, poll: `/v1/tools/runs/${started.id}` };
  }

  private enqueue(tenant: TenantContext, runId: string, job: { mode: "site_files" | "full"; targetUrl: string; pages: number | null; credits: number }): void {
    const payload = { tool: "aux_audit", toolRunId: runId, ...job, startedAt: new Date().toISOString() };
    afterCommit(() => {
      this.queues
        .enqueueTenantJob("lookup.execute", tenant.workspaceId, payload, { idempotencyKey: `lookup:${runId}`, priorityVariant: "interactive" })
        .catch((error: unknown) => {
          // Charged and never to be answered: settle it NOW as failed and refunded.
          logger.error({ event: "tools.aux_audit.enqueue_failed", workspace_id: tenant.workspaceId, run_id: runId, error: error instanceof Error ? error.name : "unknown" });
          incrementCounter("nominara_tools_aux_audit_enqueue_failed_total");
          void this.abandon(tenant, runId);
        });
    });
  }

  private pagesRefused(cap: number): Error {
    return new ValidationFailedError({ message: `pages must be a whole number from 1 to ${String(cap)}, the most pages your plan audits at once`, details: { issues: [{ path: ["pages"], message: `at most ${String(cap)} pages per audit on your plan` }] } });
  }

  /** The plan's page cap. Provisional and the same on every plan today (page-selection.ts); read through the plan so the day it differs, the quote differs with it. */
  private async pageCap(): Promise<number> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("AuxAuditToolService requires an active tenant context");
    const plan = await store.client.query<{ plan_key: string }>("SELECT plan_key FROM workspaces WHERE id = app.current_workspace()");
    return pageCapForPlan(plan.rows[0]?.plan_key ?? "");
  }

  private async abandon(tenant: TenantContext, runId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, tenant, async () => {
        await this.tools.finishRun(runId, { failed: true, errorCode: "audit_not_queued" });
      });
    } catch (error) {
      logger.error({ event: "tools.aux_audit.abandon_failed", workspace_id: tenant.workspaceId, run_id: runId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      client.release();
    }
  }
}

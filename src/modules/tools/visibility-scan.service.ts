import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import {
  SCAN_SAMPLE_STATEMENT,
  VISIBILITY_SCAN_CREDITS,
  visibilityScanResultSchema,
  type ScanStreamAccepted,
  type ScanStreamCompleted,
  type ScanStreamEngineResult,
  type ToolRunDetail,
  type VisibilityScanEstimateResponse,
  type VisibilityScanRequest,
} from "../../../contracts/tools/index.js";
import { ConflictError, PreconditionUnmetError, PriceChangedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { SseStream } from "../../api/streaming/sse-stream.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { hashIdempotencyKey, requestBodyHash, tenantKey } from "../../lib/cache/valkey-keys.js";
import { parseConfirmedCredits, requireConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { readWallet } from "../../lib/credits/wallet.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { captureReadyEngineKeys } from "../../lib/engines/registry.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { compensateDailyCounter } from "../../lib/usage/daily-cap.js";
import { DID_NOT_CHECK } from "../../lib/tools/presentation.js";
import { selectScanEngines } from "../../lib/visibility-scan/engine-set.js";
import { readScanEvents } from "../../lib/visibility-scan/scan-events.js";
import { aggregateScan } from "../../lib/visibility-scan/scan-aggregate.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { afterCommit, currentTenantStore, withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";
import { ToolsService } from "./tools.service.js";

// STORY-079 - the Visibility Scan: POST /v1/tools/visibility-scan and its free estimate (api-specification.md section 9, system-architecture.md 6.2).
//
// THE REQUEST NEVER TOUCHES AN ENGINE (KAD-06). It validates, charges the flat price through ToolsService.startRun (a ledger debit in the same transaction as
// the run row), and ENQUEUES `lookup.execute` on the dedicated interactive pool after commit. The engines run in the worker; this process only reads what the
// worker publishes (per-engine events in the cache, the settled run in the database) and relays it as server-sent events.
//
// A STREAM HOLDS NO TRANSACTION. It is a poll: a few cache reads and, once a second, one short tenant transaction to ask whether the run has settled.
//
// RECONNECT IS A REPEAT OF THE SAME REQUEST. The Idempotency-Key names the run: a second POST with the same key and body attaches to the SAME run,
// replays every engine that has landed, and resumes - it charges nothing and starts nothing. (The route is not `@Idempotent()`: that replay stores a response
// body, and a stream has none.) A dropped connection never aborts the run: the worker does not know the client exists.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("tools.visibility-scan");

/** How often the stream looks at the event keys. */
export const SCAN_POLL_MS = 250;
/** How often it asks the database whether the run has settled (also asked whenever every engine has reported). */
const SETTLE_CHECK_MS = 1_000;
/** NFR-API-09: a stream terminates at 60 s with a terminal event. Ours ends at 55 s with a PARTIAL one, so the helper's own deadline is only a backstop. */
export const SCAN_STREAM_PARTIAL_MS = 55_000;
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
const CLAIM_WAIT_MS = 3_000;

export interface ScanAccepted {
  readonly runId: string;
  readonly engines: readonly string[];
  readonly availableAfter: number;
  readonly resumed: boolean;
  readonly startedAtMs: number;
}

/** Who is asking, for the audit row the route writes itself (a streaming route has no AuditInterceptor). */
export interface ScanRequestMeta {
  readonly actorType: "user" | "api_key";
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
}

export interface ScanStreamSink {
  write(chunk: string): unknown;
  end(): unknown;
  /** Registers the callback for the client going away. */
  onClose(callback: () => void): void;
}

export interface ScanRequestHeaders {
  readonly confirmedCredits: string | readonly string[] | undefined;
  readonly idempotencyKey: string | readonly string[] | undefined;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return Array.isArray(value) ? (value[0] as string | undefined) : (value as string | undefined);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class VisibilityScanService {
  constructor(
    private readonly tools: ToolsService,
    private readonly entitlements: EntitlementResolver,
    private readonly queues: QueueProducer,
    private readonly audit: AuditChainService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CACHE) private readonly cache: Cache,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------------------------
  // The free estimate (NFR-API-11): the price, the engines named, nothing selectable. Runs in the ambient transaction. Writes nothing.
  // ---------------------------------------------------------------------------------------------------------------------------------
  async estimate(): Promise<VisibilityScanEstimateResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("VisibilityScanService requires an active tenant context");
    const { client, context } = store;
    const engines = await this.engineSet(client, context.workspaceId);
    const wallet = await readWallet(client, context.workspaceId);
    const available = wallet?.available ?? 0;
    incrementCounter("nominara_tools_scan_estimates_total");
    return {
      tool_key: "visibility_scan",
      credits: VISIBILITY_SCAN_CREDITS,
      rate: "flat",
      engines,
      engines_selectable: false,
      sample_statement: SCAN_SAMPLE_STATEMENT,
      wallet: { available, available_after: available - VISIBILITY_SCAN_CREDITS, shortfall: Math.max(0, VISIBILITY_SCAN_CREDITS - available) },
      consumes: { project_slots: 0, prompt_slots: 0, scheduled_envelope: false },
    };
  }

  /** The plan's engine set, with display names, for one workspace. */
  private async engineSet(client: ClientBase, workspaceId: string): Promise<{ engine_key: string; display_name: string }[]> {
    const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
    const size = Number(resolved.entitlements["tools.engine_set"]?.value);
    // The plan floor is compared in the database (plans.sort_order), exactly as the catalog's entitled-engines view does: no tier name is parsed in code.
    const rows = await client.query<{ key: string; display_name: string }>(
      `SELECT e.key, e.display_name
         FROM engines e
         JOIN plans floor ON floor.key = e.min_plan_key
         JOIN workspaces w ON w.id = app.current_workspace()
         JOIN plans own ON own.key = w.plan_key
        WHERE e.status = 'active' AND floor.sort_order <= own.sort_order`,
    );
    const names = new Map(rows.rows.map((row) => [row.key, row.display_name]));
    return selectScanEngines({ size: Number.isFinite(size) ? size : 0, entitled: [...names.keys()], captureReady: captureReadyEngineKeys() }).map((key) => ({ engine_key: key, display_name: names.get(key) ?? key }));
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Accept: validate, charge, enqueue - or attach to the run this Idempotency-Key already started.
  // ---------------------------------------------------------------------------------------------------------------------------------
  async accept(tenant: TenantContext, body: VisibilityScanRequest, headers: ScanRequestHeaders, meta: ScanRequestMeta): Promise<ScanAccepted> {
    return await tracer.startActiveSpan("tools.scan.accept", async (span) => {
      let created = false;
      try {
        span.setAttribute("nominara.workspace_id", tenant.workspaceId);
        // AC "gated on the confirmed-credits header": absent is a 400 and a figure that is not the flat price is a 409 price_changed. Both BEFORE anything is written.
        const confirmed = requireConfirmedCredits(parseConfirmedCredits(headers.confirmedCredits));
        if (confirmed !== VISIBILITY_SCAN_CREDITS) {
          throw new PriceChangedError({ message: "the confirmed price does not match this scan's price", details: { shown: confirmed, recomputed: VISIBILITY_SCAN_CREDITS, reason: "the confirmed figure is not the flat price of a Visibility Scan" } });
        }
        const key = firstHeader(headers.idempotencyKey)?.trim();
        if (key === undefined || key === "") {
          throw new ValidationFailedError({
            message: "a scan requires an Idempotency-Key header: it is what lets a dropped connection reattach to the run instead of paying twice",
            details: { issues: [{ path: ["idempotency-key"], message: "required" }] },
          });
        }
        const env = cacheKeyNamespace();
        const claimKey = tenantKey(env, tenant.workspaceId, "tool-scan-idem", hashIdempotencyKey(key));
        const bodyHash = requestBodyHash(JSON.stringify(body));
        const claimed = await this.cache.set(claimKey, `pending:${bodyHash}`, { ttlMs: IDEMPOTENCY_TTL_MS, onlyIfAbsent: true });
        if (!claimed) {
          const attached = await this.attach(tenant, claimKey, bodyHash);
          // A reattach is not a new scan: the daily allowance the guard consumed for this request is given back.
          await this.giveBackDailyAllowance(tenant);
          span.setAttribute("nominara.scan.resumed", true);
          incrementCounter("nominara_tools_scan_requests_total", { result: "resumed" });
          return attached;
        }
        try {
          const accepted = await this.start(tenant, body, meta);
          created = true;
          await this.cache.set(claimKey, `${bodyHash}:${accepted.runId}`, { ttlMs: IDEMPOTENCY_TTL_MS });
          incrementCounter("nominara_tools_scan_requests_total", { result: "started" });
          return accepted;
        } catch (error) {
          await this.cache.delete(claimKey).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (!created) {
          // Nothing was started or charged: the allowance the DailyCapGuard consumed for this request is given back (AC6 of STORY-071).
          await this.giveBackDailyAllowance(tenant);
          incrementCounter("nominara_tools_scan_requests_total", { result: "refused" });
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async start(tenant: TenantContext, body: VisibilityScanRequest, meta: ScanRequestMeta): Promise<ScanAccepted> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, tenant, async (tx) => {
        const engines = await this.engineSet(tx, tenant.workspaceId);
        // Refused BEFORE the debit: a scan with no engine able to answer is not charged and then refunded - it is not started.
        if (engines.length === 0) {
          throw new PreconditionUnmetError({
            message: "no engine in your plan's Tools set can capture yet, so the scan was not started and nothing was charged",
            details: { reason: "no_capturable_scope" },
          });
        }
        const engineKeys = engines.map((e) => e.engine_key);
        const started = await this.tools.startRun({
          toolKey: "visibility_scan",
          brandName: body.brand_name,
          brandUrl: body.brand_url ?? null,
          queryText: body.query_text,
          engineKeys,
          credits: VISIBILITY_SCAN_CREDITS,
        });
        const wallet = await readWallet(tx, tenant.workspaceId);
        // A streaming route has no AuditInterceptor, so it audits itself - in the transaction that wrote the run and the debit, so neither exists without the row.
        await this.audit.append(tx, {
          workspaceId: tenant.workspaceId,
          actorType: meta.actorType,
          actorId: tenant.actorId,
          actorIp: meta.ip,
          actorUa: meta.userAgent,
          action: "tool_run.scan_started",
          resourceType: "tool_run",
          resourceId: started.id,
          beforeState: null,
          afterState: { engines: engineKeys, credits: VISIBILITY_SCAN_CREDITS },
          requestId: meta.requestId,
          supportGrantId: null,
          severity: "info",
        });
        const payload = {
          toolRunId: started.id,
          brandName: body.brand_name,
          brandUrl: body.brand_url ?? null,
          queryText: body.query_text,
          competitors: body.competitors ?? [],
          engines: engineKeys,
          locale: "en-US",
          startedAt: new Date().toISOString(),
        };
        afterCommit(() => {
          this.queues
            // `priorityVariant: "interactive"`: the dedicated pool, which never shares capacity with scheduled runs.
            .enqueueTenantJob("lookup.execute", tenant.workspaceId, payload, { idempotencyKey: `lookup:${started.id}`, priorityVariant: "interactive" })
            .catch((error: unknown) => {
              // The run is charged and nothing will ever answer it: settle it NOW as failed and refunded, rather than leave a stream waiting on a dead queue.
              logger.error({ event: "tools.scan.enqueue_failed", workspace_id: tenant.workspaceId, run_id: started.id, error: error instanceof Error ? error.name : "unknown" });
              incrementCounter("nominara_tools_scan_enqueue_failed_total");
              void this.abandon(tenant, started.id, engineKeys);
            });
        });
        logger.log({ event: "tools.scan.accepted", workspace_id: tenant.workspaceId, run_id: started.id, engines: engineKeys.length });
        return { runId: started.id, engines: engineKeys, availableAfter: wallet?.available ?? 0, resumed: false, startedAtMs: Date.now() };
      });
    } finally {
      client.release();
    }
  }

  private async abandon(tenant: TenantContext, runId: string, engines: readonly string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, tenant, async () => {
        await this.tools.finishRun(runId, { enginesSucceeded: [], enginesFailed: engines, errorCode: "scan_not_queued" });
      });
    } catch (error) {
      logger.error({ event: "tools.scan.abandon_failed", workspace_id: tenant.workspaceId, run_id: runId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      client.release();
    }
  }

  private async attach(tenant: TenantContext, claimKey: string, bodyHash: string): Promise<ScanAccepted> {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      const value = await this.cache.get(claimKey);
      if (value !== undefined && !value.startsWith("pending:")) {
        const [storedHash, runId] = value.split(":");
        if (storedHash !== bodyHash || runId === undefined) {
          throw new ConflictError({ message: "this Idempotency-Key was already used with a different request", details: { current_state: "idempotency_key_reused" } });
        }
        const client = await this.pool.connect();
        try {
          const run = await withTenantContext(client, tenant, async () => await this.tools.peek(runId));
          const wallet = await withTenantContext(client, tenant, async (tx) => await readWallet(tx, tenant.workspaceId));
          return { runId, engines: run.inputs.engine_keys, availableAfter: wallet?.available ?? 0, resumed: true, startedAtMs: Date.parse(run.created_at) };
        } finally {
          client.release();
        }
      }
      if (value === undefined) throw new ConflictError({ message: "the request this Idempotency-Key belonged to did not complete: retry", details: { current_state: "idempotent_request_failed" } });
      if (value !== `pending:${bodyHash}`) throw new ConflictError({ message: "this Idempotency-Key was already used with a different request", details: { current_state: "idempotency_key_reused" } });
      if (Date.now() > deadline) throw new ConflictError({ message: "the request this Idempotency-Key belongs to is still being accepted: retry shortly", details: { current_state: "idempotent_request_in_flight" } });
      await sleep(100);
    }
  }

  private async giveBackDailyAllowance(tenant: TenantContext): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, tenant, async (tx) => compensateDailyCounter(tx, tenant.workspaceId, "lookup"));
    } catch (error) {
      logger.warn({ event: "tools.scan.daily_cap_compensation_failed", workspace_id: tenant.workspaceId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Stream: relay what lands. Always ends with a terminal event; never aborts the run.
  // ---------------------------------------------------------------------------------------------------------------------------------
  async stream(tenant: TenantContext, accepted: ScanAccepted, sink: ScanStreamSink, options: { pollMs?: number; partialAfterMs?: number } = {}): Promise<void> {
    return await tracer.startActiveSpan("tools.scan.stream", async (span) => {
      const pollMs = options.pollMs ?? SCAN_POLL_MS;
      const partialAfterMs = options.partialAfterMs ?? SCAN_STREAM_PARTIAL_MS;
      const sse = new SseStream(sink, { terminalEvent: "scan.completed" });
      let clientGone = false;
      sink.onClose(() => {
        clientGone = true;
      });
      const env = cacheKeyNamespace();
      let outcome = "completed";
      try {
        span.setAttributes({ "nominara.workspace_id": tenant.workspaceId, "nominara.run_id": accepted.runId, "nominara.scan.resumed": accepted.resumed });
        sse.open();
        const accept: ScanStreamAccepted = {
          tool_run_id: accepted.runId,
          engines: [...accepted.engines],
          credits: { reserved: VISIBILITY_SCAN_CREDITS, rate: "flat", available_after: accepted.availableAfter },
          one_sample_per_engine: true,
          sample_statement: SCAN_SAMPLE_STATEMENT,
        };
        sse.send("scan.accepted", accept);
        const sent = new Set<string>();
        const relay = async (): Promise<void> => {
          const events = await readScanEvents(this.cache, env, tenant.workspaceId, accepted.runId, accepted.engines);
          for (const event of events) {
            if (event.kind !== "engine_result" || sent.has(event.result.engine)) continue;
            sent.add(event.result.engine);
            sse.send("scan.engine_result", event.result);
          }
        };
        let lastSettleCheck = 0;
        for (;;) {
          if (clientGone || sse.isClosed) {
            // The client left. The RUN is untouched: the worker neither knows nor cares, and a reconnect replays what landed.
            outcome = "client_gone";
            return;
          }
          await relay();
          const elapsed = Date.now() - accepted.startedAtMs;
          const everyEngineReported = (await readScanEvents(this.cache, env, tenant.workspaceId, accepted.runId, accepted.engines)).length >= accepted.engines.length;
          if (everyEngineReported || Date.now() - lastSettleCheck >= SETTLE_CHECK_MS || elapsed >= partialAfterMs) {
            lastSettleCheck = Date.now();
            const run = await this.settled(tenant, accepted.runId);
            if (run !== undefined) {
              // The stored snapshot is the authority: anything the poll missed is relayed from it before the terminal event.
              const snapshot = visibilityScanResultSchema.safeParse(run.result);
              if (snapshot.success) for (const result of snapshot.data.engines) if (!sent.has(result.engine)) { sent.add(result.engine); sse.send("scan.engine_result", result); }
              sse.send("scan.completed", terminalFrom(run, false));
              return;
            }
            if (elapsed >= partialAfterMs) {
              // The worker has not settled the run in time. Return what landed rather than nothing; the charge stands until the worker (or the reaper) settles it.
              outcome = "deadline";
              await relay();
              const landed = (await readScanEvents(this.cache, env, tenant.workspaceId, accepted.runId, accepted.engines)).flatMap((e) => (e.kind === "engine_result" ? [e.result] : []));
              sse.send("scan.completed", partialTerminal(accepted, landed, VISIBILITY_SCAN_CREDITS));
              return;
            }
          }
          await sleep(pollMs);
        }
      } catch (error) {
        outcome = "error";
        span.setStatus({ code: SpanStatusCode.ERROR });
        logger.error({ event: "tools.scan.stream_failed", workspace_id: tenant.workspaceId, run_id: accepted.runId, error: error instanceof Error ? error.name : "unknown" });
        // A terminal event in EVERY case: the client must never wait on a dead stream. The run is still owned by the worker.
        sse.send("scan.completed", partialTerminal(accepted, [], VISIBILITY_SCAN_CREDITS));
      } finally {
        sse.close();
        incrementCounter("nominara_tools_scan_streams_total", { outcome });
        span.end();
      }
    });
  }

  private async settled(tenant: TenantContext, runId: string): Promise<ToolRunDetail | undefined> {
    const client = await this.pool.connect();
    try {
      const run = await withTenantContext(client, tenant, async () => await this.tools.peek(runId));
      return run.status === "running" ? undefined : run;
    } finally {
      client.release();
    }
  }
}

/** The terminal event for a settled run, built from the stored row alone. */
export function terminalFrom(run: ToolRunDetail, deadlineReached: boolean): ScanStreamCompleted {
  const snapshot = visibilityScanResultSchema.safeParse(run.result);
  const results = snapshot.success ? snapshot.data.engines : [];
  const failures = snapshot.success ? snapshot.data.engine_failures : run.engines_failed.map((engine) => ({ engine, code: "engine_error", reason: "The engine did not return an answer." }));
  const aggregate = aggregateScan(results, failures, run.inputs.engine_keys);
  const status = run.status === "completed" || run.status === "partial" || run.status === "failed" ? run.status : "failed";
  return {
    tool_run_id: run.id,
    status,
    duration_ms: run.duration_ms ?? 0,
    aggregate,
    engine_failures: failures,
    credits: { charged: run.credits_charged, refunded: Math.max(0, VISIBILITY_SCAN_CREDITS - run.credits_charged) },
    deadline_reached: deadlineReached || (snapshot.success && snapshot.data.deadline_reached),
    not_tracked: true,
    did_not_check: run.presentation.did_not_check,
    sample_statement: SCAN_SAMPLE_STATEMENT,
    convert_cta:
      status === "failed"
        ? null
        : { endpoint: `/v1/tools/runs/${run.id}/convert`, prefill: run.conversion.prefill },
  };
}

/** The terminal event when the run has not settled in time: what landed, charged as the run stands. */
function partialTerminal(accepted: ScanAccepted, landed: readonly ScanStreamEngineResult[], charged: number): ScanStreamCompleted {
  const aggregate = aggregateScan(landed, [], accepted.engines);
  return {
    tool_run_id: accepted.runId,
    status: landed.length === 0 ? "failed" : "partial",
    duration_ms: Math.max(0, Date.now() - accepted.startedAtMs),
    aggregate,
    engine_failures: aggregate.engines_failed.map((engine) => ({ engine, code: "deadline_exceeded", reason: "The engine had not answered when the stream's latency deadline was reached; the run is still being settled." })),
    credits: { charged, refunded: 0 },
    deadline_reached: true,
    not_tracked: true,
    did_not_check: DID_NOT_CHECK.visibility_scan,
    sample_statement: SCAN_SAMPLE_STATEMENT,
    convert_cta: null,
  };
}

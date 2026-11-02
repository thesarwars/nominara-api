import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import {
  SCAN_SAMPLE_STATEMENT,
  VISIBILITY_SCAN_CREDITS,
  visibilityScanResultSchema,
  type ScanEngineFailure,
  type ScanStreamAccepted,
  type ScanStreamCompleted,
  type ScanStreamEngineResult,
  type ToolRunDetail,
  type VisibilityScanEstimateResponse,
  type VisibilityScanRequest,
} from "../../../contracts/tools/index.js";
import { ConflictError, IdempotencyConflictError, PreconditionUnmetError, PriceChangedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { SseStream } from "../../api/streaming/sse-stream.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { hashIdempotencyKey, requestBodyHash, tenantKey } from "../../lib/cache/valkey-keys.js";
import { isReservedLedgerKey } from "../../lib/credits/debit.js";
import { parseConfirmedCredits, requireConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { readWallet } from "../../lib/credits/wallet.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import type { ResolvedEntitlementsResponse } from "../../lib/entitlements/resolution.js";
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
/** api-specification.md section 1: a billable POST replays for 24 hours. A shorter claim lets a late retry of the same key start (and charge) a second scan. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
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

interface Claim {
  readonly bodyHash: string;
  /** Absent while the request is still being accepted (`pending`). */
  readonly runId: string | undefined;
  /** When the claim was first made (ISO), for the conflict's `original_recorded_at`. */
  readonly at: string;
}

// A claim is a VALUE (not a key): the tenant-namespaced key is built by `tenantKey`. Its parts are joined, never interpolated, so nothing here reads as a key.
const CLAIM_PENDING = "pending";
const CLAIM_SEPARATOR = ":";
const CLAIM_AT = "@";

/** `pending : <hash> @ <iso>` while the run is being started; `<hash> : <runId> @ <iso>` once it exists. */
function claimValue(bodyHash: string, runId: string | undefined, at: string): string {
  const head = runId === undefined ? [CLAIM_PENDING, bodyHash] : [bodyHash, runId];
  return head.join(CLAIM_SEPARATOR) + CLAIM_AT + at;
}

function parseClaim(value: string): Claim {
  const atIndex = value.lastIndexOf(CLAIM_AT);
  const at = atIndex < 0 ? new Date(0).toISOString() : value.slice(atIndex + 1);
  const head = atIndex < 0 ? value : value.slice(0, atIndex);
  const separator = head.indexOf(CLAIM_SEPARATOR);
  if (separator < 0) return { bodyHash: head, runId: undefined, at };
  // Split on the FIRST separator only: the run id is everything after it, whatever shape the hash takes.
  const first = head.slice(0, separator);
  const rest = head.slice(separator + 1);
  if (first === CLAIM_PENDING) return { bodyHash: rest, runId: undefined, at };
  return { bodyHash: first, runId: rest === "" ? undefined : rest, at };
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
    // The version is read on the AMBIENT connection and `resolve` (cache-first) is used, so the request does not take a second pool connection while it holds one.
    const version = (await client.query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = app.current_workspace()")).rows[0]?.entitlement_version ?? 0;
    const engines = await this.engineSet(client, await this.entitlements.resolve(context.workspaceId, version));
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
  private async engineSet(client: ClientBase, resolved: ResolvedEntitlementsResponse): Promise<{ engine_key: string; display_name: string }[]> {
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
        // The same namespace guard every credit-spending route has (CreditGuard): a client-chosen key must not collide with a server-written ledger key.
        if (isReservedLedgerKey(key)) {
          throw new ValidationFailedError({
            message: "this Idempotency-Key is in a namespace reserved for the server",
            details: { issues: [{ path: ["idempotency-key"], message: "must not start with a reserved internal prefix" }] },
          });
        }
        const env = cacheKeyNamespace();
        const claimKey = tenantKey(env, tenant.workspaceId, "tool-scan-idem", hashIdempotencyKey(key));
        const bodyHash = requestBodyHash(JSON.stringify(body));
        const claimedAt = new Date().toISOString();
        const claimed = await this.cache.set(claimKey, claimValue(bodyHash, undefined, claimedAt), { ttlMs: IDEMPOTENCY_TTL_MS, onlyIfAbsent: true });
        if (!claimed) {
          const attached = await this.attach(tenant, claimKey, hashIdempotencyKey(key), bodyHash);
          // A reattach is not a new scan: the daily allowance the guard consumed for this request is given back.
          await this.giveBackDailyAllowance(tenant);
          span.setAttribute("nominara.scan.resumed", true);
          incrementCounter("nominara_tools_scan_requests_total", { result: "resumed" });
          return attached;
        }
        let accepted: ScanAccepted;
        try {
          accepted = await this.start(tenant, body, meta);
        } catch (error) {
          // A `start` that threw releases the claim - UNLESS the failure was the COMMIT itself (the connection dropped while Postgres committed): then the run and
          // its debit exist, and releasing the claim would let a retry charge a second scan. So the database is asked first.
          const committed = await this.committedRunSince(tenant, body, claimedAt);
          if (committed === undefined) {
            await this.cache.delete(claimKey).catch(() => undefined);
            throw error;
          }
          logger.error({ event: "tools.scan.commit_ambiguous", workspace_id: tenant.workspaceId, run_id: committed });
          incrementCounter("nominara_tools_scan_commit_ambiguous_total");
          await this.recordRunOnClaim(claimKey, bodyHash, committed, claimedAt);
          throw error;
        }
        // From here the run exists, is charged, and its job is scheduled: the claim is NEVER deleted. A retry of the same key must find a claim, so it
        // attaches (or waits as in-flight) instead of starting - and charging - a second scan.
        created = true;
        if (!(await this.recordRunOnClaim(claimKey, bodyHash, accepted.runId, claimedAt))) {
          logger.error({ event: "tools.scan.claim_unrecorded", workspace_id: tenant.workspaceId, run_id: accepted.runId });
          incrementCounter("nominara_tools_scan_claim_unrecorded_total");
        }
        incrementCounter("nominara_tools_scan_requests_total", { result: "started" });
        return accepted;
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

  /** The id of a scan this actor's identical request committed since the claim was taken, or undefined (also when the database cannot be asked). */
  private async committedRunSince(tenant: TenantContext, body: VisibilityScanRequest, claimedAt: string): Promise<string | undefined> {
    try {
      const client = await this.pool.connect();
      try {
        return await withTenantContext(client, tenant, async (tx) => {
          // A few seconds of tolerance: the claim time is this process's clock, `created_at` is the database's.
          const rows = await tx.query<{ id: string }>(
            `SELECT id FROM tool_runs
              WHERE workspace_id = app.current_workspace() AND tool_key = 'visibility_scan' AND created_by = $1
                AND brand_name = $2 AND query_text = $3 AND created_at >= $4::timestamptz - interval '5 seconds'
              ORDER BY created_at DESC LIMIT 1`,
            [tenant.actorId, body.brand_name, body.query_text, claimedAt],
          );
          return rows.rows[0]?.id;
        });
      } finally {
        client.release();
      }
    } catch {
      return undefined;
    }
  }

  /** Writes the run id onto the claim, with a short retry. Best effort by design: the scan is already charged, so a failure here must not become a failure of the request. */
  private async recordRunOnClaim(claimKey: string, bodyHash: string, runId: string, claimedAt: string): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.cache.set(claimKey, claimValue(bodyHash, runId, claimedAt), { ttlMs: IDEMPOTENCY_TTL_MS });
        return true;
      } catch {
        if (attempt < 3) await sleep(50 * attempt);
      }
    }
    return false;
  }

  private async start(tenant: TenantContext, body: VisibilityScanRequest, meta: ScanRequestMeta): Promise<ScanAccepted> {
    // RESOLVED BEFORE A CONNECTION IS TAKEN. `resolveForWorkspace` opens its own pooled connection; doing it while holding one made N concurrent scans
    // need 2N connections, and a burst as large as the pool deadlocked every request waiting on its second one.
    const resolved = await this.entitlements.resolveForWorkspace(tenant.workspaceId);
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, tenant, async (tx) => {
        const engines = await this.engineSet(tx, resolved);
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
          entitlements: resolved.entitlements,
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
          // `no_shared_cache` (plans-and-entitlements.md): the worker neither reads nor seeds the cross-tenant L1 for a flagged workspace. Signed with the job.
          sharedCacheEnabled: resolved.entitlements["no_shared_cache"]?.value !== true,
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

  private async attach(tenant: TenantContext, claimKey: string, keyHash: string, bodyHash: string): Promise<ScanAccepted> {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    const reused = (claim: Claim): Error =>
      new IdempotencyConflictError({
        message: "this Idempotency-Key was already used with a different request body",
        details: { key_hash: keyHash, original_request_hash: claim.bodyHash, original_recorded_at: claim.at },
      });
    for (;;) {
      const value = await this.cache.get(claimKey);
      if (value === undefined) throw new ConflictError({ message: "the request this Idempotency-Key belonged to did not complete: retry", details: { current_state: "idempotent_request_failed" } });
      const claim = parseClaim(value);
      if (claim.bodyHash !== bodyHash) throw reused(claim);
      if (claim.runId !== undefined) {
        const runId = claim.runId;
        const client = await this.pool.connect();
        try {
          const run = await withTenantContext(client, tenant, async () => await this.tools.peek(runId));
          const wallet = await withTenantContext(client, tenant, async (tx) => await readWallet(tx, tenant.workspaceId));
          return { runId, engines: run.inputs.engine_keys, availableAfter: wallet?.available ?? 0, resumed: true, startedAtMs: Date.parse(run.created_at) };
        } finally {
          client.release();
        }
      }
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
              const events = await readScanEvents(this.cache, env, tenant.workspaceId, accepted.runId, accepted.engines);
              const landed = events.flatMap((e) => (e.kind === "engine_result" ? [e.result] : []));
              const failed = events.flatMap((e) => (e.kind === "engine_failed" ? [e.failure] : []));
              sse.send("scan.completed", provisionalTerminal(accepted, landed, failed));
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
        sse.send("scan.completed", provisionalTerminal(accepted, [], []));
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
    settled: true,
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

/**
 * The terminal event when the STREAM ends before the worker has settled the run (its own deadline, or a fault in the stream). It claims no money figure:
 * the worker may still settle the run as failed and refund it in full, so `charged` / `refunded` are null (unknown, not 0) and `status` is `running`.
 * What landed is returned; the run resource holds the final status and figures.
 */
function provisionalTerminal(accepted: ScanAccepted, landed: readonly ScanStreamEngineResult[], failed: readonly ScanEngineFailure[]): ScanStreamCompleted {
  const aggregate = aggregateScan(landed, failed, accepted.engines);
  // An engine that already failed keeps its REAL reason; `deadline_exceeded` is only for an engine that has reported nothing at all.
  const silent = accepted.engines.filter((engine) => !landed.some((r) => r.engine === engine) && !failed.some((f) => f.engine === engine));
  return {
    tool_run_id: accepted.runId,
    status: "running",
    settled: false,
    duration_ms: Math.max(0, Date.now() - accepted.startedAtMs),
    aggregate,
    engine_failures: [
      ...failed,
      ...silent.map((engine) => ({ engine, code: "deadline_exceeded", reason: "The engine had not answered when the stream ended; the run is still being settled, and a scan that captures nothing is refunded in full." })),
    ],
    credits: { charged: null, refunded: null },
    deadline_reached: true,
    not_tracked: true,
    did_not_check: DID_NOT_CHECK.visibility_scan,
    sample_statement: SCAN_SAMPLE_STATEMENT,
    convert_cta: null,
  };
}

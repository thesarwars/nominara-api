import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import {
  lookupExecuteJobPayloadSchema,
  SCAN_SAMPLE_STATEMENT,
  visibilityScanResultSchema,
  type LookupExecuteJobPayload,
  type ScanEngineFailure,
  type ScanStreamEngineResult,
} from "../../../../contracts/tools/index.js";
import type { ProjectsService } from "../../../modules/projects/projects.service.js";
import type { ToolsService } from "../../../modules/tools/tools.service.js";
import { cacheKeyNamespace } from "../../cache/key-namespace.js";
import type { Cache } from "../../cache/cache.port.js";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import { seedSharedCache } from "../../capture/execute-cell.js";
import { probeExactHash } from "../../capture/l1-exact-hash.js";
import { EntitlementResolver } from "../../entitlements/entitlement-resolver.js";
import type { CaptureAdapter, CaptureContext, RawCapture } from "../../engines/contract.js";
import { engineKeySchema } from "../../engines/contract.js";
import { CaptureFailureError, classifyCaptureFailure } from "../../engines/failure-taxonomy.js";
import type { CaptureEngineGate } from "../../engines/capture-engine-gate.js";
import { EngineRefusalError, resolveEngine } from "../../engines/registry.js";
import { recordEngineSpend } from "../../engines/record-spend.js";
import type { SpendMeter } from "../../engines/spend-meter.js";
import { NORMALIZER_VERSION } from "../../parser/normalize.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { readScanEvents, writeScanEvent } from "../../visibility-scan/scan-events.js";
import { runVisibilityScan, ScanCaptureError, type CachedAnswer, type LiveAnswer, type ScanPorts, type ScanPublished, type ScanRunOutcome } from "../../visibility-scan/run-scan.js";
import { aggregateScan } from "../../visibility-scan/scan-result.js";
import type { QueueHandlerContext } from "../handlers.js";
import { buildCaptureEngineGate, buildSpendMeter } from "./capture-execute.handler.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

// STORY-079 - `lookup.execute`: one Visibility Scan, on the DEDICATED interactive pool (system-architecture.md section 6.2).
//
//   prepare   one short tenant transaction: is the run still `running`? which engines, and what are their cache windows?
//   run       NO transaction, NO client: the engines, in parallel, each published to the run's event keys as it lands (ADR-0003, KAD-06)
//   commit    one short tenant transaction: the snapshot, the headline, and the settlement - nothing captured is refunded in full
//
// WHAT IT WRITES: `tool_runs` through ToolsService.finishRun, and event keys in the cache. Nothing else. No capture row, no fact row, no rollup, no task:
// FR-TL-11 / FR-VS-05. The shared L1 cache IS seeded with a live answer (an engine's public answer to a public question, no tenant identifier), so a later
// scan - or a tracked run - can reuse it.
//
// THE ENGINE SPEND CEILING GATES EVERY VENDOR CALL (owner decision 26). Tools use of Gemini is paid for from the same monthly ceiling as scheduled capture;
// a ceiling that is reached - or a meter that cannot be read - means the engine is NOT called, and the failure is named. The check is made before the call,
// never after it.

const logger = new Logger("lookup.execute");
const tracer = trace.getTracer("nominara-api");

/** Hard per-engine capture timeout (system-architecture.md section 6.2). */
export const SCAN_ENGINE_TIMEOUT_MS = 30_000;
/** The latency deadline: at this point what has landed is returned (section 6.2, "all-settled or the 45 s deadline"). */
export const SCAN_DEADLINE_MS = 45_000;
/** After the deadline, how long a capture still in flight is given to report its cost before the usage_ledger rows are fixed. */
export const SCAN_LATE_COST_GRACE_MS = 2_000;

export interface LookupExecuteDeps {
  readonly cache?: Cache;
  readonly spendMeter?: SpendMeter;
  readonly engineGate?: CaptureEngineGate;
  /** Test seam: the adapter for an engine. Production resolves it through the registry. */
  readonly resolveAdapter?: (engineKey: string) => CaptureAdapter;
  readonly deadlineMs?: number;
  readonly lateCostGraceMs?: number;
  readonly now?: () => Date;
}

interface EngineWindow {
  readonly ttlSeconds: number;
  readonly adapterVersion: string;
}

interface Prepared {
  readonly payload: LookupExecuteJobPayload & { workspaceId: string };
  readonly windows: ReadonlyMap<string, EngineWindow>;
  /** False for a workspace whose plan carries `no_shared_cache`: it neither reads nor writes the cross-tenant L1. */
  readonly sharedCacheEnabled: boolean;
}

interface Fetched {
  /** The vendor cost of each LIVE capture this delivery made, per engine (USD). Zero-cost fixtures are absent. */
  readonly costs: ReadonlyMap<string, number>;
  readonly outcome: ScanRunOutcome;
  readonly resumed: readonly ScanPublished[];
  readonly durationMs: number;
}

function isFinalAttempt(job: Job): boolean {
  const attempts = job.opts?.attempts;
  return attempts !== undefined && (job.attemptsMade ?? 0) + 1 >= attempts;
}

export function createLookupExecuteHandler(context: QueueHandlerContext, deps: LookupExecuteDeps = {}): JobProcessor {
  // The adapter is lazily connected and refuses a command before it is (no offline queue), so it is connected ONCE, here, before first use.
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
  let meter: SpendMeter | undefined = deps.spendMeter;
  const spend = (): SpendMeter => (meter ??= buildSpendMeter(context.env, (message) => logger.warn(message)));
  let gate: CaptureEngineGate | undefined = deps.engineGate;
  const engineGate = (): CaptureEngineGate => (gate ??= buildCaptureEngineGate(context, (message) => logger.warn(message)));
  const now = deps.now ?? ((): Date => new Date());
  const adapterFor = deps.resolveAdapter ?? resolveEngine;
  const env = cacheKeyNamespace();

  // The lifecycle half of ToolsService needs the entitlement resolver (for the retention window) and nothing of ProjectsService: this path never converts.
  //
  // IMPORTED WHEN FIRST USED, NOT AT LOAD. `ProjectsService` imports this registry (handlers.ts) for `handlerFor`, and `ToolsService` imports
  // `ProjectsService`: a static import here closes that loop, and Nest then reads `ProjectsService` as undefined when it decorates `ToolsService`
  // ("can't resolve dependencies of ToolsService") in whichever process happens to load the registry first.
  const tools = async (): Promise<ToolsService> => {
    const { ToolsService: Service } = await import("../../../modules/tools/tools.service.js");
    return new Service(new EntitlementResolver(await liveCache(), context.pool), {
      create: () => {
        throw new Error("a scan job never converts a run");
      },
    } as unknown as ProjectsService);
  };

  const prepare = async (tx: ClientBase, job: Job): Promise<Prepared | typeof PHASES_DONE> => {
    const payload = lookupExecuteJobPayloadSchema.parse((job.data as { payload: unknown }).payload) as Prepared["payload"];
    // THE RUN ROW IS THE TRUTH, not the payload: a redelivery after the run settled does nothing (at-least-once delivery).
    const run = await tx.query<{ status: string }>("SELECT status FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1", [payload.toolRunId]);
    if (run.rows[0]?.status !== "running") return PHASES_DONE;
    const engines = await tx.query<{ key: string; cache_ttl_seconds: number; adapter_version: string }>(
      "SELECT key, cache_ttl_seconds, adapter_version FROM engines WHERE key = ANY($1::text[])",
      [payload.engines],
    );
    // THE PLAN'S L1 DECISION travels in the signed payload (`start` resolved it before any connection was taken): `no_shared_cache` bypasses the cross-tenant cache
    // both ways (system-architecture.md "Cross-tenant L1 sharing"). Absent means "do not share".
    return {
      payload,
      windows: new Map(engines.rows.map((row) => [row.key, { ttlSeconds: row.cache_ttl_seconds, adapterVersion: row.adapter_version }])),
      sharedCacheEnabled: payload.sharedCacheEnabled,
    };
  };

  const run = async (prepared: Prepared): Promise<Fetched> => {
    const { payload, windows, sharedCacheEnabled } = prepared;
    const liveCosts = new Map<string, number>();
    // A capture still in flight when the deadline passes is aborted, and given a short grace to report what it cost before the costs are fixed.
    const runAbort = new AbortController();
    const inflight = new Set<Promise<LiveAnswer>>();
    const started = now();
    // IDEMPOTENT UNDER REDELIVERY: an engine that already published an event is not captured (or paid for) again.
    const resumed = await readScanEvents(await liveCache(), env, payload.workspaceId, payload.toolRunId, payload.engines);
    const done = new Set(resumed.map((e) => (e.kind === "engine_result" ? e.result.engine : e.failure.engine)));
    const remaining = payload.engines.filter((engine) => !done.has(engine));
    const competitors = payload.competitors;
    const ports: ScanPorts = {
      now,
      cached: async (engine): Promise<CachedAnswer | undefined> => {
        const window = windows.get(engine);
        if (window === undefined) return undefined;
        const candidate = { promptId: payload.toolRunId, promptText: payload.queryText, engineKey: engine, sampleIndex: 0, ttlSeconds: window.ttlSeconds, adapterVersion: window.adapterVersion };
        const hits = await probeExactHash(await liveCache(), { env, locale: payload.locale, personaHint: null, nowMs: now().getTime(), sharedCacheEnabled }, [candidate]);
        const hit = [...hits.values()][0];
        // A hit with no capture time cannot be labelled with its true age, so it is not served as a cached answer.
        if (hit === undefined || hit.capturedAt === null) return undefined;
        const text = hit.payload["text"];
        if (typeof text !== "string") return undefined;
        const structured = hit.payload["structured_citations"];
        return { text, ...(Array.isArray(structured) ? { structuredCitations: structured as CachedAnswer["structuredCitations"] & object } : {}), capturedAt: new Date(hit.capturedAt) };
      },
      capture: (engine): Promise<LiveAnswer> => {
        const attempt = captureOne(engine);
        inflight.add(attempt);
        void attempt.then(
          () => inflight.delete(attempt),
          () => inflight.delete(attempt),
        );
        return attempt;
      },
      publish: async (event) => {
        await writeScanEvent(await liveCache(), env, payload.workspaceId, payload.toolRunId, event);
      },
    };
    const captureOne = async (engine: string): Promise<LiveAnswer> => {
        const window = windows.get(engine);
        const key = engineKeySchema.safeParse(engine);
        if (!key.success) throw new ScanCaptureError("engine_unavailable");
        // THE SPEND CEILING, BEFORE THE VENDOR IS CALLED. An unreadable meter fails closed.
        if (await spend().isCeilingReached(key.data)) {
          incrementCounter("nominara_tools_scan_spend_ceiling_blocked_total", { engine_key: key.data });
          throw new ScanCaptureError("engine_spend_ceiling_reached");
        }
        const admission = await engineGate().admit(key.data);
        if (admission.kind !== "admit") throw new ScanCaptureError(admission.kind === "skip" ? admission.errorCode : "engine_unavailable");
        let adapter: CaptureAdapter;
        try {
          adapter = adapterFor(key.data);
        } catch (error) {
          if (error instanceof EngineRefusalError) throw new ScanCaptureError("engine_unavailable");
          throw error;
        }
        const controller = new AbortController();
        runAbort.signal.addEventListener("abort", () => controller.abort(), { once: true });
        const timer = setTimeout(() => controller.abort(), SCAN_ENGINE_TIMEOUT_MS);
        const costs = { usd: 0 };
        const ctx: CaptureContext = {
          signal: controller.signal,
          span: { setAttribute: () => undefined, recordException: () => undefined, end: () => undefined },
          recordCost: (usd: number) => {
            costs.usd += usd;
          },
        };
        let raw: RawCapture;
        try {
          // `requestMode: "live"`: a person is watching, so a licensed-SERP engine takes its fast path (tracking-engine.md section 3).
          raw = await adapter.capture({ promptText: payload.queryText, locale: payload.locale, sampleIndex: 0, requireCitations: adapter.supportsCitations, requestMode: "live" }, ctx);
        } catch (error) {
          if (costs.usd > 0) {
            liveCosts.set(engine, costs.usd);
            await recordEngineSpend(spend(), logger, key.data, costs.usd, "lookup");
          }
          if (error instanceof CaptureFailureError) {
            // Our own cancellation (the scan resolved and aborted the run) is not the vendor's failure: spend is recorded above, the breaker is not told.
            const selfCancelled = runAbort.signal.aborted;
            if (!selfCancelled) await engineGate().record(key.data, { outcome: "failure", code: error.code }).catch(() => undefined);
            if (classifyCaptureFailure(error.code) === null && error.code === "content_policy_refusal") throw new ScanCaptureError("content_policy_refusal");
            throw new ScanCaptureError(error.code);
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (costs.usd > 0) {
          liveCosts.set(engine, costs.usd);
          await recordEngineSpend(spend(), logger, key.data, costs.usd, "lookup");
        }
        await engineGate().record(key.data, { outcome: "success", latencyMs: raw.latencyMs }).catch(() => undefined);
        if (raw.flags?.includes("engine_refused_to_answer") === true || raw.text.trim() === "") throw new ScanCaptureError("content_policy_refusal");
        if (window !== undefined && sharedCacheEnabled) {
          await seedSharedCache(
            await liveCache(),
            { workspaceId: payload.workspaceId, projectId: payload.toolRunId, runId: payload.toolRunId, promptId: payload.toolRunId, promptText: payload.queryText, engineKey: engine, sampleIndex: 0, adapterVersion: window.adapterVersion, ttlSeconds: window.ttlSeconds, locale: payload.locale, personaHint: null, normalizerVersion: NORMALIZER_VERSION },
            raw,
            now(),
          ).catch(() => undefined);
        }
        const citations = raw.structuredCitations?.map((c) => ({ url: c.url, slot: c.slot, ...(c.title !== undefined ? { title: c.title } : {}) }));
        return { text: raw.text, ...(citations !== undefined ? { structuredCitations: citations } : {}), latencyMs: raw.latencyMs };
    };
    const outcome = await tracer.startActiveSpan("tools.scan.run", async (span) => {
      try {
        span.setAttributes({ "nominara.workspace_id": payload.workspaceId, "nominara.run_id": payload.toolRunId, "nominara.engines": remaining.length });
        return await runVisibilityScan({ engines: remaining, brandName: payload.brandName, brandUrl: payload.brandUrl, competitors, deadlineMs: deps.deadlineMs ?? SCAN_DEADLINE_MS }, ports);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
    runAbort.abort();
    await Promise.race([Promise.allSettled([...inflight]), new Promise<void>((resolve) => setTimeout(resolve, deps.lateCostGraceMs ?? SCAN_LATE_COST_GRACE_MS).unref())]);
    return { outcome, resumed, costs: new Map(liveCosts), durationMs: Math.max(0, now().getTime() - started.getTime()) };
  };

  const commit = async (tx: ClientBase, prepared: Prepared, fetched: Fetched): Promise<void> => {
    const { payload } = prepared;
    const results: ScanStreamEngineResult[] = [...fetched.resumed.flatMap((e) => (e.kind === "engine_result" ? [e.result] : [])), ...fetched.outcome.results];
    const failures: ScanEngineFailure[] = [...fetched.resumed.flatMap((e) => (e.kind === "engine_failed" ? [e.failure] : [])), ...fetched.outcome.failures];
    // The run's own engine order, so the stored snapshot does not depend on which engine happened to land first.
    const order = (engine: string): number => payload.engines.indexOf(engine);
    results.sort((a, b) => order(a.engine) - order(b.engine));
    failures.sort((a, b) => order(a.engine) - order(b.engine));
    const aggregate = aggregateScan(results, failures, payload.engines);
    // Every competitor ANY engine named: this delivery's engines, and the engines a previous delivery had already reported (their events carry the names).
    const named = new Set<string>([...fetched.outcome.competitors, ...fetched.resumed.flatMap((e) => (e.kind === "engine_result" ? (e.mentioned ?? []) : []))]);
    const detected = payload.competitors.filter((name) => named.has(name));
    const snapshot = visibilityScanResultSchema.parse({
      schema_version: 1,
      sample_statement: SCAN_SAMPLE_STATEMENT,
      one_sample_per_engine: true,
      engines: results,
      engine_failures: failures,
      competitors: detected,
      deadline_reached: fetched.outcome.deadlineReached,
    });
    // WHAT THE SCAN COST US, per workspace (usage_ledger, source 'lookup'): one row per live capture with a real cost, written once per (run, engine) so a
    // redelivered commit adds nothing. A cached answer cost nothing and has no row. The customer's own charge is the run's credit_ledger entry.
    for (const [engine, usd] of fetched.costs) {
      await tx.query(
        `INSERT INTO usage_ledger (workspace_id, metric, quantity, unit_cost_usd, engine_key, source, credits_charged, reference_type, reference_id, cache_layer)
         SELECT app.current_workspace(), 'capture', 1, $1::numeric, $2, 'lookup', 0, 'tool_run', $3::uuid, 'live'
          WHERE NOT EXISTS (SELECT 1 FROM usage_ledger WHERE workspace_id = app.current_workspace() AND reference_type = 'tool_run' AND reference_id = $3::uuid AND engine_key = $2)`,
        [usd.toFixed(6), engine, payload.toolRunId],
      );
    }
    await (await tools()).finishRun(payload.toolRunId, {
      enginesSucceeded: aggregate.engines_succeeded,
      enginesFailed: aggregate.engines_failed,
      result: snapshot,
      headline:
        results.length === 0
          ? {}
          : { sov_estimate: aggregate.sov_estimate, citation_count: aggregate.citation_count, sentiment_label: aggregate.sentiment_label, brand_present: aggregate.brand_present },
      durationMs: fetched.durationMs,
      cacheLayer: results.length > 0 && results.every((r) => r.cache_layer === "l1") ? "l1" : "live",
    });
    for (const result of results) incrementCounter("nominara_tools_scan_engine_results_total", { outcome: "answered", cache_layer: result.cache_layer });
    for (const failure of failures) incrementCounter("nominara_tools_scan_engine_results_total", { outcome: "failed", code: failure.code });
    logger.log({ event: "tools.scan.finished", workspace_id: payload.workspaceId, run_id: payload.toolRunId, engines_succeeded: aggregate.engines_succeeded.length, engines_failed: aggregate.engines_failed.length, deadline_reached: fetched.outcome.deadlineReached });
  };

  /** The last attempt settles the run as failed and refunds it, rather than dead-lettering a charge that was never earned. */
  const recover = async (_tx: ClientBase, job: Job): Promise<boolean> => {
    if (!isFinalAttempt(job)) return false;
    const payload = lookupExecuteJobPayloadSchema.parse((job.data as { payload: unknown }).payload);
    await (await tools()).finishRun(payload.toolRunId, { enginesSucceeded: [], enginesFailed: payload.engines, errorCode: "scan_job_failed" });
    logger.warn({ event: "tools.scan.job_failed", workspace_id: (job.data as { payload: { workspaceId?: string } }).payload.workspaceId, run_id: payload.toolRunId });
    return true;
  };

  return phasedProcessor<Prepared, Fetched>({ prepare, run, commit, recover });
}

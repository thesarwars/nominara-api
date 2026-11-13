import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import {
  COMPETITOR_FINDER_SCOPE_STATEMENT,
  competitorFinderJobPayloadSchema,
  competitorFinderResultSchema,
  type CompetitorFinderJobPayload,
  type CompetitorFinderResult,
} from "../../../../contracts/tools/index.js";
import type { ProjectsService } from "../../../modules/projects/projects.service.js";
import type { ToolsService } from "../../../modules/tools/tools.service.js";
import { CRAWL_AGENT, isAllowed, parseRobots, type ParsedRobots } from "../../net/robots.js";
import { buildEntityRows } from "../../competitor-finder/build-rows.js";
import { deriveCategoryQuery, ownBrandNames } from "../../competitor-finder/category-query.js";
import { detectEntitySpans } from "../../competitor-finder/detect-entities.js";
import { commitEntryIdFor } from "../../credits/internal-cost.js";
import { EntitlementResolver } from "../../entitlements/entitlement-resolver.js";
import type { CaptureAdapter, CaptureContext, RawCapture } from "../../engines/contract.js";
import { engineKeySchema } from "../../engines/contract.js";
import type { CaptureEngineGate } from "../../engines/capture-engine-gate.js";
import { CaptureFailureError } from "../../engines/failure-taxonomy.js";
import { EngineRefusalError, resolveEngine } from "../../engines/registry.js";
import { recordEngineSpend } from "../../engines/record-spend.js";
import type { SpendMeter } from "../../engines/spend-meter.js";
import { CrawlRefusal, crawlGatedFetch } from "../../net/crawl-gate.js";
import { GuardedFetchRefusal, type GuardedFetchInit, type GuardedResponse } from "../../net/guarded-fetch.js";
import { toRegistrableDomain } from "../../net/registrable-domain.js";
import { NOMINARA_USER_AGENT } from "../../net/user-agent.js";
import { normalize } from "../../parser/normalize.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { ValkeyCacheAdapter } from "../../cache/valkey-cache.adapter.js";
import type { Cache } from "../../cache/cache.port.js";
import { PHASES_DONE, type JobPhases } from "../worker-factory.js";
import type { QueueHandlerContext } from "../handlers.js";
import { buildCaptureEngineGate, buildSpendMeter } from "./capture-execute.handler.js";

// STORY-081 - the Competitor Finder's worker half. It runs as a `lookup.execute` job whose payload says `tool: "competitor_finder"` (the dispatcher is in
// lookup-execute.handler.ts), on the dedicated interactive pool.
//
//   prepare   one short tenant transaction: is the run still `running`?
//   run       NO transaction: the page through the EXISTING guarded fetcher (src/lib/net - the SSRF guard) and our robots rules (src/lib/aux), the category
//             query, then ONE capture on ONE engine. Entities are detected in the answer and rows are built from the detected spans only.
//   commit    one short tenant transaction: the result, the headline, and the settlement. Nothing captured, or nothing named, is refunded in full.
//
// THERE IS NO SECOND FETCH PATH. This file imports `crawlGatedFetch` (the SSRF-guarded fetch behind the robots gate) and no raw socket module, no global fetch and no HTTP client of its own; competitor-finder.spec.ts asserts it.
// WHAT IT WRITES: `tool_runs` (through ToolsService.finishRun) and `usage_ledger` cost rows. No capture row, no fact row, no competitor row (FR-TL-11).

const logger = new Logger("lookup.execute.competitor-finder");
const tracer = trace.getTracer("nominara-api");

/** Hard per-engine capture timeout (system-architecture.md section 6.2). */
export const FINDER_ENGINE_TIMEOUT_MS = 30_000;

export interface CompetitorFindDeps {
  readonly cache?: Cache;
  readonly spendMeter?: SpendMeter;
  readonly engineGate?: CaptureEngineGate;
  readonly resolveAdapter?: (engineKey: string) => CaptureAdapter;
  /** Test seam for the network. Production is the crawl gate (SSRF-guarded fetch behind robots.txt and the per-host budget, owner decisions 70(d) and 106(g)). */
  readonly fetchPage?: (url: string, init: GuardedFetchInit) => Promise<GuardedResponse>;
  readonly now?: () => Date;
}

interface Prepared {
  readonly payload: CompetitorFinderJobPayload & { workspaceId: string };
}

interface Fetched {
  /** Set when the capture produced an answer; `null` when the run failed before or during it. */
  readonly result: CompetitorFinderResult | null;
  readonly failureCode: string | null;
  readonly costUsd: number;
  readonly durationMs: number;
}

const HTML_TYPES = /^(?:text\/html|application\/xhtml\+xml)\b/iu;

class FinderFailure extends Error {
  constructor(readonly code: string) {
    super(`competitor finder failed: ${code}`);
  }
}

function isFinalAttempt(job: Job): boolean {
  const attempts = job.opts?.attempts;
  return attempts !== undefined && (job.attemptsMade ?? 0) + 1 >= attempts;
}

export function createCompetitorFindPhases(context: QueueHandlerContext, deps: CompetitorFindDeps = {}): JobPhases<Prepared, Fetched> {
  let meter: SpendMeter | undefined = deps.spendMeter;
  const spend = (): SpendMeter => (meter ??= buildSpendMeter(context.env, (message) => logger.warn(message)));
  let gate: CaptureEngineGate | undefined = deps.engineGate;
  const engineGate = (): CaptureEngineGate => (gate ??= buildCaptureEngineGate(context, (message) => logger.warn(message)));
  const now = deps.now ?? ((): Date => new Date());
  const adapterFor = deps.resolveAdapter ?? resolveEngine;
  const fetchPage = deps.fetchPage ?? crawlGatedFetch;
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
  // Imported when first used, not at load: the same cycle lookup-execute.handler.ts documents (ProjectsService <-> the handler registry).
  const tools = async (): Promise<ToolsService> => {
    const { ToolsService: Service } = await import("../../../modules/tools/tools.service.js");
    return new Service(new EntitlementResolver(await liveCache(), context.pool), {
      create: () => {
        throw new Error("a competitor-finder job never converts a run");
      },
    } as unknown as ProjectsService);
  };

  /** RFC 9309: a robots.txt that errored (5xx / unreachable) means "assume disallow"; a 4xx means "no rules". Our own agent token is the one obeyed. */
  const robotsFor = async (origin: string, init: GuardedFetchInit): Promise<ParsedRobots | "unavailable" | "unreachable" | null> => {
    try {
      const response = await fetchPage(new URL("/robots.txt", origin).href, init);
      if (response.status >= 500) return "unavailable";
      if (response.status >= 400) return null;
      return parseRobots(response.body.toString("utf8"));
    } catch (error) {
      if (error instanceof GuardedFetchRefusal) throw new FinderFailure("unsafe_target");
      // A transport error (DNS, refused connection, timeout) is the site being unreachable - not a robots refusal.
      return "unreachable";
    }
  };

  const readPage = async (targetUrl: string): Promise<string> => {
    const init: GuardedFetchInit = {
      headers: { "user-agent": NOMINARA_USER_AGENT, accept: "text/html,application/xhtml+xml" },
      truncateAtCap: true,
      // A page that redirects off its own site is not followed: the tool asks about THIS site's category.
      followRedirect: (next) => {
        try {
          return toRegistrableDomain(next) === toRegistrableDomain(targetUrl);
        } catch {
          return false;
        }
      },
    };
    const origin = new URL(targetUrl).origin;
    const robots = await robotsFor(origin, init);
    const target = new URL(targetUrl);
    if (robots === "unreachable") throw new FinderFailure("page_unreachable");
    if (robots === "unavailable" || (robots !== null && !isAllowed(robots, CRAWL_AGENT, `${target.pathname}${target.search}`))) throw new FinderFailure("robots_disallowed");
    let response: GuardedResponse;
    try {
      response = await fetchPage(targetUrl, init);
    } catch (error) {
      // The gate declined (robots.txt disallows the page, or could not be read): the same refusal the handler's own robots check reports.
      if (error instanceof CrawlRefusal) throw new FinderFailure("robots_disallowed");
      throw new FinderFailure(error instanceof GuardedFetchRefusal ? "unsafe_target" : "page_unreachable");
    }
    if (response.status < 200 || response.status >= 300) throw new FinderFailure("page_unreachable");
    const type = response.headers["content-type"];
    if (typeof type === "string" && !HTML_TYPES.test(type)) throw new FinderFailure("page_not_html");
    return response.body.toString("utf8");
  };

  const captureOnce = async (engine: string, queryText: string, locale: string): Promise<{ raw: RawCapture; costUsd: number }> => {
    const key = engineKeySchema.safeParse(engine);
    if (!key.success) throw new FinderFailure("engine_unavailable");
    // THE SPEND CEILING, BEFORE THE VENDOR IS CALLED. An unreadable meter fails closed.
    if (await spend().isCeilingReached(key.data)) {
      incrementCounter("nominara_tools_competitor_finder_spend_ceiling_blocked_total", { engine_key: key.data });
      throw new FinderFailure("engine_spend_ceiling_reached");
    }
    const admission = await engineGate().admit(key.data);
    if (admission.kind !== "admit") throw new FinderFailure(admission.kind === "skip" ? admission.errorCode : "engine_unavailable");
    let adapter: CaptureAdapter;
    try {
      adapter = adapterFor(key.data);
    } catch (error) {
      if (error instanceof EngineRefusalError) throw new FinderFailure("engine_unavailable");
      throw error;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FINDER_ENGINE_TIMEOUT_MS);
    const costs = { usd: 0 };
    const ctx: CaptureContext = {
      signal: controller.signal,
      span: { setAttribute: () => undefined, recordException: () => undefined, end: () => undefined },
      recordCost: (usd: number) => {
        costs.usd += usd;
      },
    };
    try {
      const raw = await adapter.capture({ promptText: queryText, locale, sampleIndex: 0, requireCitations: adapter.supportsCitations, requestMode: "live" }, ctx);
      await engineGate().record(key.data, { outcome: "success", latencyMs: raw.latencyMs }).catch(() => undefined);
      return { raw, costUsd: costs.usd };
    } catch (error) {
      if (error instanceof CaptureFailureError) {
        await engineGate().record(key.data, { outcome: "failure", code: error.code }).catch(() => undefined);
        throw Object.assign(new FinderFailure(error.code), { costUsd: costs.usd });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (costs.usd > 0) await recordEngineSpend(spend(), logger, key.data, costs.usd, "lookup");
    }
  };

  const prepare = async (tx: ClientBase, job: Job): Promise<Prepared | typeof PHASES_DONE> => {
    const payload = competitorFinderJobPayloadSchema.parse((job.data as { payload: unknown }).payload) as Prepared["payload"];
    // THE RUN ROW IS THE TRUTH, not the payload: a redelivery after the run settled does nothing (at-least-once delivery).
    const run = await tx.query<{ status: string }>("SELECT status FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1", [payload.toolRunId]);
    return run.rows[0]?.status === "running" ? { payload } : PHASES_DONE;
  };

  const run = async (prepared: Prepared): Promise<Fetched> => {
    const { payload } = prepared;
    const started = now();
    return await tracer.startActiveSpan("tools.competitor_finder.run", async (span) => {
      let costUsd = 0;
      try {
        span.setAttributes({ "nominara.workspace_id": payload.workspaceId, "nominara.run_id": payload.toolRunId, "nominara.engine": payload.engine });
        const html = await readPage(payload.targetUrl);
        const host = new URL(payload.targetUrl).hostname.replace(/^www\./u, "");
        const query = deriveCategoryQuery(html, host);
        if (query === null) throw new FinderFailure("no_category_found");
        const captured = await captureOnce(payload.engine, query, payload.locale);
        costUsd = captured.costUsd;
        const raw = captured.raw;
        if (raw.flags?.includes("engine_refused_to_answer") === true || raw.text.trim() === "") throw new FinderFailure("content_policy_refusal");
        // Offsets index the NORMALISED answer (tracking-engine.md Stage 1); the stored excerpts and spans are against that string.
        const text = normalize(raw.text);
        const spans = detectEntitySpans(text, { excludeNames: ownBrandNames(html, host) });
        const entities = buildEntityRows({ text, spans, citations: raw.structuredCitations ?? [] });
        const result = competitorFinderResultSchema.parse({
          schema_version: 1,
          scope: { engine: payload.engine, query, captured_at: now().toISOString(), statement: COMPETITOR_FINDER_SCOPE_STATEMENT },
          entities,
          competitors: entities.map((e) => e.name),
        });
        return { result, failureCode: null, costUsd, durationMs: Math.max(0, now().getTime() - started.getTime()) };
      } catch (error) {
        if (!(error instanceof FinderFailure)) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.code });
        const spent = (error as { costUsd?: number }).costUsd ?? costUsd;
        return { result: null, failureCode: error.code, costUsd: spent, durationMs: Math.max(0, now().getTime() - started.getTime()) };
      } finally {
        span.end();
      }
    });
  };

  const commit = async (tx: ClientBase, prepared: Prepared, fetched: Fetched): Promise<void> => {
    const { payload } = prepared;
    if (fetched.costUsd > 0) {
      // Serialise concurrent commits of one run (a stalled-job redelivery) on the run row, so the NOT EXISTS below cannot pass twice.
      await tx.query("SELECT 1 FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1 FOR UPDATE", [payload.toolRunId]);
      const commitEntryId = await commitEntryIdFor(tx, payload.workspaceId, "tool_run", payload.toolRunId);
      await tx.query(
        `INSERT INTO usage_ledger (workspace_id, metric, quantity, unit_cost_usd, engine_key, source, credits_charged, credit_ledger_id, reference_type, reference_id, cache_layer)
         SELECT app.current_workspace(), 'capture', 1, $1::numeric, $2, 'lookup', 0, $4::uuid, 'tool_run', $3::uuid, 'live'
          WHERE NOT EXISTS (SELECT 1 FROM usage_ledger WHERE workspace_id = app.current_workspace() AND reference_type = 'tool_run' AND reference_id = $3::uuid AND engine_key = $2)`,
        [fetched.costUsd.toFixed(6), payload.engine, payload.toolRunId, commitEntryId],
      );
    }
    const named = fetched.result?.entities.length ?? 0;
    // Nothing captured, or the capture named nothing: the one engine "did not deliver", so the run settles `failed` and the charge is returned in full (AC8).
    // The empty result is still stored, so re-opening the run says what was asked and that nothing was named.
    const delivered = fetched.result !== null && named > 0;
    await (await tools()).finishRun(payload.toolRunId, {
      enginesSucceeded: delivered ? [payload.engine] : [],
      enginesFailed: delivered ? [] : [payload.engine],
      result: fetched.result,
      headline: fetched.result === null ? {} : { entities_found: named },
      durationMs: fetched.durationMs,
      cacheLayer: "live",
      ...(delivered ? {} : { errorCode: fetched.failureCode ?? "no_entities_named" }),
    });
    incrementCounter("nominara_tools_competitor_finder_runs_total", { outcome: delivered ? "named" : (fetched.failureCode ?? "no_entities_named") });
    logger.log({ event: "tools.competitor_finder.finished", workspace_id: payload.workspaceId, run_id: payload.toolRunId, entities: named, failure: fetched.failureCode });
  };

  /** The last attempt settles the run as failed and refunds it, rather than dead-lettering a charge that was never earned. */
  const recover = async (_tx: ClientBase, job: Job): Promise<boolean> => {
    if (!isFinalAttempt(job)) return false;
    const payload = competitorFinderJobPayloadSchema.parse((job.data as { payload: unknown }).payload);
    await (await tools()).finishRun(payload.toolRunId, { enginesSucceeded: [], enginesFailed: [payload.engine], errorCode: "finder_job_failed" });
    logger.warn({ event: "tools.competitor_finder.job_failed", run_id: payload.toolRunId });
    return true;
  };

  return { prepare, run, commit, recover };
}

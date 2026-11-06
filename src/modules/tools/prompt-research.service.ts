import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import {
  PROMPT_RESEARCH_CREDITS_PER_ANSWER,
  PROMPT_RESEARCH_DISCOVER_COUNT,
  PROMPT_RESEARCH_MAX_KEPT_PER_SAVE,
  PROMPT_RESEARCH_MAX_PROMPTS,
  type DiscoverPromptsRequest,
  type DiscoverPromptsResponse,
  type KeepPromptsRequest,
  type KeepPromptsResponse,
  type PromptResearchEstimateQuery,
  type PromptResearchEstimateResponse,
  type PromptResearchRunAccepted,
  type PromptResearchRunRequest,
} from "../../../contracts/tools/index.js";
import { PreconditionUnmetError, PriceChangedError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { parseConfirmedCredits, requireConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { readWallet } from "../../lib/credits/wallet.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import type { ResolvedEntitlementsResponse } from "../../lib/entitlements/resolution.js";
import { DEFAULT_GENERATION_TEMPERATURE, DEFAULT_PRIORITY_SUBSET_SIZE, generatePass } from "../../lib/promptgen/generate.js";
import { generatedPromptPrice } from "../../lib/promptgen/activation-charge.js";
import type { SlotContext } from "../../lib/promptgen/slots.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { compensateDailyCounter } from "../../lib/usage/daily-cap.js";
import { DID_NOT_CHECK, NOT_TRACKED_NOTE } from "../../lib/tools/presentation.js";
import { toolsEngineSet } from "../../lib/tools/tools-engine-set.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { afterCommit, currentTenantStore, withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";
import { ToolsService } from "./tools.service.js";

// STORY-080 - Prompt Research (FR-TL-01): Discover, Keep and Run, over machinery that already exists.
//
//   DISCOVER  the PROJECT generator (`generatePass`), called directly: there is no second generation path. Template-only (no naturaliser), so it makes no call of its
//             own - it is deterministic, free, and writes nothing. Discarding what it returned is therefore free by construction: there is nothing to undo.
//   KEEP      the charge. 1 credit per prompt kept, read from `prompts.credits_per_generated` through the SAME helper the in-project activation charge uses
//             (rate parity is not a coincidence; the tool must not undercut the product). One tool run records the kept count (`items_kept`) as the charge basis and its
//             ledger entry names it (`unit_detail.prompts`).
//   RUN       5 credits per ANSWER (a prompt asked of an engine), debited when the run is accepted through the shared run core, then the engines are asked in the worker
//             (`lookup.execute`, kind `prompt_research`): this request never touches an engine (KAD-06). Nothing captured is refunded in full; a partial is charged in full.
//
// NEITHER MODE WRITES A FACT: a capture, a mention or a citation. The only rows are the tool run and its ledger entries (src/lib/tools/tool-core.spec.ts scans for it).

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("tools.prompt-research");

const ENGINE_LOCALE = "en-US";

@Injectable()
export class PromptResearchService {
  constructor(
    private readonly tools: ToolsService,
    private readonly entitlements: EntitlementResolver,
    private readonly queues: QueueProducer,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  private store(): { client: import("pg").ClientBase; context: TenantContext } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptResearchService requires an active tenant context");
    return { client: store.client, context: store.context };
  }

  /** The workspace's entitlements, read on the AMBIENT connection (cache-first), so the request does not take a second pooled connection while it holds one. */
  private async resolved(): Promise<ResolvedEntitlementsResponse> {
    const { client, context } = this.store();
    const version = (await client.query<{ entitlement_version: number }>("SELECT entitlement_version FROM workspaces WHERE id = app.current_workspace()")).rows[0]?.entitlement_version ?? 0;
    return await this.entitlements.resolve(context.workspaceId, version);
  }

  private async available(): Promise<number> {
    const { client, context } = this.store();
    return (await readWallet(client, context.workspaceId))?.available ?? 0;
  }

  private keepPriceOrNull(entitlements: ResolvedEntitlementsResponse["entitlements"]): number | null {
    try {
      return generatedPromptPrice(entitlements);
    } catch (error) {
      if (error instanceof PreconditionUnmetError) return null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Discover: free. Writes nothing.
  // ---------------------------------------------------------------------------------------------------------------------------------
  async discover(body: DiscoverPromptsRequest): Promise<DiscoverPromptsResponse> {
    return await tracer.startActiveSpan("tools.prompt_research.discover", async (span) => {
      try {
        const { context } = this.store();
        span.setAttribute("nominara.workspace_id", context.workspaceId);
        if (body.brand_name === undefined && body.topic === undefined) {
          throw new ValidationFailedError({ message: "name a brand_name or a topic to discover prompts for", details: { issues: [{ path: ["brand_name"], message: "required unless a topic is given" }] } });
        }
        // DISCOVER IS FREE AND NEVER DEPENDS ON THE KEEP PRICE: a plan that publishes none (Free) gets the candidates and a null price with the reason.
        const keepPrice = this.keepPriceOrNull((await this.resolved()).entitlements);
        const supplied = body.context ?? {};
        const slots: SlotContext = {
          ...(body.brand_name === undefined ? {} : { brandName: body.brand_name }),
          // A topic IS the category when the caller named no other: the generator's `category` slot is what its templates ask about.
          ...(supplied.category_slug !== undefined ? { categorySlug: supplied.category_slug } : body.topic !== undefined ? { categorySlug: body.topic } : {}),
          ...(supplied.verticals === undefined ? {} : { verticals: supplied.verticals }),
          ...(supplied.competitors === undefined ? {} : { competitors: supplied.competitors.map((c) => c.name) }),
          ...(supplied.personas === undefined ? {} : { personas: supplied.personas }),
          ...(supplied.size_bands === undefined ? {} : { sizeBands: supplied.size_bands }),
          ...(supplied.integrations === undefined ? {} : { integrations: supplied.integrations }),
          ...(supplied.compliance_terms === undefined ? {} : { complianceTerms: supplied.compliance_terms }),
          ...(supplied.capabilities === undefined ? {} : { capabilities: supplied.capabilities }),
        };
        // THE PROJECT GENERATOR, unchanged. No project exists, so the ids are placeholders for rows this method never persists; nothing is read from or written to the database.
        const pass = await generatePass({
          generationBatchId: uuidV7(),
          workspaceId: context.workspaceId,
          projectId: uuidV7(),
          context: slots,
          existingHashes: new Set<string>(),
          batchSize: 1,
          prioritySubsetSize: DEFAULT_PRIORITY_SUBSET_SIZE,
          naturaliser: null,
          temperature: DEFAULT_GENERATION_TEMPERATURE,
          ...(body.topic === undefined ? {} : { topicHint: body.topic }),
        });
        span.setAttribute("nominara.tool_run.prompts_generated", pass.candidates.length);
        incrementCounter("nominara_tools_prompt_research_discover_total", { complete: String(pass.candidates.length >= PROMPT_RESEARCH_DISCOVER_COUNT) });
        logger.log({ event: "tools.prompt_research.discovered", workspace_id: context.workspaceId, generated: pass.candidates.length });
        return {
          candidates: pass.candidates.map((candidate, index) => ({ text: pass.rows[index]!.text, archetype: candidate.archetype, priority: candidate.isPriority })),
          requested: PROMPT_RESEARCH_DISCOVER_COUNT,
          generated: pass.candidates.length,
          credits_charged: 0 as const,
          keep: { credits_per_prompt: keepPrice, unavailable_reason: keepPrice === null ? ("price_not_agreed" as const) : null, max_per_save: PROMPT_RESEARCH_MAX_KEPT_PER_SAVE },
          not_tracked: true as const,
          did_not_check: DID_NOT_CHECK.prompt_research,
        };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // The free paired estimate (NFR-API-11): recomputed for whatever is selected. Writes nothing.
  // ---------------------------------------------------------------------------------------------------------------------------------
  async estimate(query: PromptResearchEstimateQuery): Promise<PromptResearchEstimateResponse> {
    const { client } = this.store();
    const resolved = await this.resolved();
    const engines = query.mode === "run" ? await toolsEngineSet(client, resolved) : [];
    const perUnit = query.mode === "run" ? PROMPT_RESEARCH_CREDITS_PER_ANSWER : generatedPromptPrice(resolved.entitlements);
    const units = query.mode === "run" ? query.prompt_count * engines.length : query.prompt_count;
    const total = units * perUnit;
    // A keep saves up to the 15 Discover generates; a run asks at most 10 (decision 67f).
    const cap = query.mode === "run" ? PROMPT_RESEARCH_MAX_PROMPTS : PROMPT_RESEARCH_MAX_KEPT_PER_SAVE;
    const available = await this.available();
    incrementCounter("nominara_tools_prompt_research_estimates_total", { mode: query.mode });
    return {
      mode: query.mode,
      prompt_count: query.prompt_count,
      max_prompts: cap,
      within_cap: query.prompt_count <= cap,
      engines,
      unit: query.mode === "run" ? "answer" : "prompt_kept",
      credits_per_unit: perUnit,
      units,
      total_credits: total,
      wallet: { available, available_after: available - total, shortfall: Math.max(0, total - available) },
      not_tracked: true as const,
      not_tracked_note: NOT_TRACKED_NOTE,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Keep: the charge, per prompt kept.
  // ---------------------------------------------------------------------------------------------------------------------------------
  async keep(body: KeepPromptsRequest, confirmedHeader: string | readonly string[] | undefined): Promise<KeepPromptsResponse> {
    return await tracer.startActiveSpan("tools.prompt_research.keep", async (span) => {
      try {
        const { context } = this.store();
        span.setAttribute("nominara.workspace_id", context.workspaceId);
        this.requireSelection(body.prompts, "keep");
        const resolved = await this.resolved();
        const price = generatedPromptPrice(resolved.entitlements);
        const total = price * body.prompts.length;
        // The two-step guard: the figure the customer was shown is the figure recomputed now, or nothing is written. A free keep (a plan that prices it at 0) needs no figure.
        if (total > 0) {
          const confirmed = requireConfirmedCredits(parseConfirmedCredits(confirmedHeader));
          if (confirmed !== total) {
            throw new PriceChangedError({
              message: "the confirmed price does not match this keep's price",
              details: { shown: confirmed, recomputed: total, reason: `prompts.credits_per_generated is ${String(price)} for each of the ${String(body.prompts.length)} prompts kept` },
            });
          }
        }
        const started = await this.tools.startRun({
          toolKey: "prompt_research",
          brandName: body.brand_name ?? null,
          queryText: body.topic ?? null,
          promptTexts: body.prompts,
          engineKeys: [],
          credits: total,
          entitlements: resolved.entitlements,
          // THE LEDGER ENTRY NAMES THE KEPT COUNT (the run's `items_kept` is the charge basis).
          unitDetail: { prompts: body.prompts.length, engines: 0, cells_charged: 0, cells_cached: 0 },
        });
        await this.tools.finishRun(started.id, {
          result: { schema_version: 1, mode: "keep", prompts: body.prompts, kept_count: body.prompts.length, credits_per_prompt: price },
          headline: { items_kept: body.prompts.length },
        });
        span.setAttribute("nominara.tool_run.items_kept", body.prompts.length);
        incrementCounter("nominara_tools_prompt_research_prompts_kept_total", {});
        logger.log({ event: "tools.prompt_research.kept", workspace_id: context.workspaceId, run_id: started.id, items_kept: body.prompts.length, credits: total });
        return {
          tool_run_id: started.id,
          kept_count: body.prompts.length,
          credits_per_prompt: price,
          credits_charged: total,
          prompts: [...body.prompts],
          convert_endpoint: `/v1/tools/runs/${started.id}/convert`,
          not_tracked: true as const,
          did_not_check: DID_NOT_CHECK.prompt_research,
        };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private requireSelection(prompts: readonly string[], what: "keep" | "run"): void {
    if (prompts.length === 0) {
      throw new ValidationFailedError({ message: `select at least one prompt to ${what}`, details: { issues: [{ path: ["prompts"], message: "at least one prompt" }] } });
    }
    const cap = what === "run" ? PROMPT_RESEARCH_MAX_PROMPTS : PROMPT_RESEARCH_MAX_KEPT_PER_SAVE;
    if (prompts.length > cap) {
      throw new ValidationFailedError({
        message: `${what === "run" ? "a run is" : "a save is"} capped at ${String(cap)} prompts`,
        details: { issues: [{ path: ["prompts"], message: `at most ${String(cap)} prompts` }] },
      });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Run: validate, charge per answer through the shared core, enqueue. The engines are asked by the worker.
  // ---------------------------------------------------------------------------------------------------------------------------------
  async run(body: PromptResearchRunRequest, confirmedHeader: string | readonly string[] | undefined): Promise<PromptResearchRunAccepted> {
    const { context } = this.store();
    let started = false;
    return await tracer.startActiveSpan("tools.prompt_research.run", async (span) => {
      try {
        span.setAttribute("nominara.workspace_id", context.workspaceId);
        this.requireSelection(body.prompt_texts, "run");
        const { client } = this.store();
        const resolved = await this.resolved();
        const engines = (await toolsEngineSet(client, resolved)).map((e) => e.engine_key);
        // Refused BEFORE the debit: a run with no engine able to answer is not charged and then refunded - it is not started.
        if (engines.length === 0) {
          throw new PreconditionUnmetError({ message: "no engine in your plan's Tools set can capture yet, so the run was not started and nothing was charged", details: { reason: "no_capturable_scope" } });
        }
        const answers = body.prompt_texts.length * engines.length;
        const total = answers * PROMPT_RESEARCH_CREDITS_PER_ANSWER;
        const confirmed = requireConfirmedCredits(parseConfirmedCredits(confirmedHeader));
        if (confirmed !== total) {
          throw new PriceChangedError({
            message: "the confirmed price does not match this run's price",
            details: { shown: confirmed, recomputed: total, reason: `${String(body.prompt_texts.length)} prompts x ${String(engines.length)} engines x ${String(PROMPT_RESEARCH_CREDITS_PER_ANSWER)} credits per answer` },
          });
        }
        const run = await this.tools.startRun({ toolKey: "prompt_research", promptTexts: body.prompt_texts, engineKeys: engines, credits: total, entitlements: resolved.entitlements });
        started = true;
        const payload = {
          kind: "prompt_research" as const,
          toolRunId: run.id,
          prompts: [...body.prompt_texts],
          engines,
          // `no_shared_cache` (plans-and-entitlements.md): the worker neither reads nor seeds the cross-tenant L1 for a flagged workspace. Signed with the job.
          sharedCacheEnabled: resolved.entitlements["no_shared_cache"]?.value !== true,
          locale: ENGINE_LOCALE,
          startedAt: new Date().toISOString(),
        };
        afterCommit(() => {
          this.queues
            // `priorityVariant: "interactive"`: the dedicated pool, which never shares capacity with scheduled runs.
            .enqueueTenantJob("lookup.execute", context.workspaceId, payload, { idempotencyKey: `lookup:${run.id}`, priorityVariant: "interactive" })
            .catch((error: unknown) => {
              // The run is charged and nothing will ever answer it: settle it NOW as failed and refunded, rather than leave it `running` for ever.
              logger.error({ event: "tools.prompt_research.enqueue_failed", workspace_id: context.workspaceId, run_id: run.id, error: error instanceof Error ? error.name : "unknown" });
              incrementCounter("nominara_tools_prompt_research_enqueue_failed_total");
              void this.abandon(context, run.id, engines);
            });
        });
        const available = await this.available();
        span.setAttributes({ "nominara.run_id": run.id, "nominara.tool_run.answers": answers });
        incrementCounter("nominara_tools_prompt_research_runs_total", { result: "started" });
        logger.log({ event: "tools.prompt_research.accepted", workspace_id: context.workspaceId, run_id: run.id, prompts: body.prompt_texts.length, engines: engines.length, credits: total });
        return {
          tool_run_id: run.id,
          status: "running" as const,
          prompts: body.prompt_texts.length,
          engines,
          answers,
          credits: { charged: total, per_answer: PROMPT_RESEARCH_CREDITS_PER_ANSWER, available_after: available },
          poll: { run: `/v1/tools/runs/${run.id}` },
          not_tracked: true as const,
          did_not_check: DID_NOT_CHECK.prompt_research,
        };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (!started) {
          // Nothing was started or charged: the allowance the DailyCapGuard consumed for this request is given back (STORY-071 AC6).
          await this.giveBackDailyAllowance(context);
          incrementCounter("nominara_tools_prompt_research_runs_total", { result: "refused" });
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async abandon(tenant: TenantContext, runId: string, engines: readonly string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, tenant, async () => {
        await this.tools.finishRun(runId, { enginesSucceeded: [], enginesFailed: engines, errorCode: "research_not_queued" });
      });
    } catch (error) {
      logger.error({ event: "tools.prompt_research.abandon_failed", workspace_id: tenant.workspaceId, run_id: runId, error: error instanceof Error ? error.name : "unknown" });
    } finally {
      client.release();
    }
  }

  private async giveBackDailyAllowance(tenant: TenantContext): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        await withTenantContext(client, tenant, async (tx) => compensateDailyCounter(tx, tenant.workspaceId, "lookup"));
      } finally {
        client.release();
      }
    } catch (error) {
      logger.warn({ event: "tools.prompt_research.daily_cap_compensation_failed", workspace_id: tenant.workspaceId, error: error instanceof Error ? error.name : "unknown" });
    }
  }
}

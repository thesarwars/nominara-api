import { SpanStatusCode, trace } from "@opentelemetry/api";
import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import {
  FREE_TOOL_KEYS,
  type ConvertToolRunRequest,
  type ConvertToolRunResponse,
  type ToolKey,
  type ToolRun,
  type ToolRunConversionPreview,
  type ToolRunDetail,
  type ToolRunHeadline,
  type ToolRunListQuery,
  type ToolRunResult,
  type ToolRunStatus,
} from "../../../contracts/tools/index.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { ConflictError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import { decodeTimestampIdCursor, MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import { debitInTransaction, includedGrantOf } from "../../lib/credits/debit.js";
import { settleFinishedRunCredits } from "../../lib/credits/run-settlement.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { countStructural } from "../../lib/entitlements/structural-usage.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { toolConversionPlan } from "../../lib/tools/conversion.js";
import { toolInputHash } from "../../lib/tools/input-hash.js";
import { toolPresentation } from "../../lib/tools/presentation.js";
import { toolSnapshotExpiresAt } from "../../lib/tools/retention-window.js";
import { deriveToolRunOutcome } from "../../lib/tools/run-outcome.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { ProjectsService } from "../projects/projects.service.js";

// STORY-078 - the machinery all six tools share: one table, one lifecycle, one timeline, one conversion contract.
//
// THIS SERVICE OWNS `tool_runs` (one table, one owning service). The tools differ in their payload, never in their lifecycle, so a tool's
// own story calls `startRun` / `finishRun` and fills `result_json`; it adds no table, no counter and no second timeline.
//
// RESULTS LIVE ONLY HERE (FR-TL-11). Nothing in this module touches a fact table or a capture run, and it imports no module that does;
// src/lib/tools/tool-core.spec.ts scans the source for exactly that (the three fact tables, the capture tables and their owners). Re-opening a run reads
// `result_json` and nothing else: there is no code path from the timeline to a capture, a charge or a queue.
//
// EVERY QUERY RUNS IN THE AMBIENT TENANT TRANSACTION. RLS (`ws_isolation_tool_runs`) is the guarantee that a run in another workspace
// is a 404; no predicate below filters by workspace for correctness.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("tools");

const LIST_NAME = "tools.runs";

/** `tool_runs.credits_charged` is a smallint; a price beyond it is a defect in the caller, refused before anything is written. */
const MAX_RUN_CREDITS = 32_767;

export interface StartToolRunInput {
  readonly toolKey: ToolKey;
  readonly brandName?: string | null;
  readonly brandUrl?: string | null;
  readonly targetUrl?: string | null;
  readonly queryText?: string | null;
  readonly promptTexts?: readonly string[] | null;
  /** The plan-determined engine set (FR-TL-07: no picker). Empty for the tools that capture nothing. */
  readonly engineKeys?: readonly string[];
  readonly locale?: string;
  readonly diffBaseRunId?: string | null;
  readonly diffCompareRunId?: string | null;
  /** Schema Builder stores its result at the start: the shape constraint requires it. */
  readonly resultJson?: ToolRunResult | null;
  /** The flat price, debited from the wallet now and returned in full by `finishRun` if the run captured nothing. 0 for a free tool. */
  readonly credits: number;
}

export interface StartedToolRun {
  readonly id: string;
  readonly expiresAt: Date;
  readonly creditsCharged: number;
}

export interface FinishToolRun {
  readonly enginesSucceeded?: readonly string[];
  readonly enginesFailed?: readonly string[];
  /** Only read for a tool with no engine set, which has no per-engine evidence of its own. */
  readonly failed?: boolean;
  /** Replaces the stored result when given. */
  readonly result?: ToolRunResult | null;
  readonly headline?: Partial<ToolRunHeadline>;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly cacheLayer?: "live" | "l1";
  readonly cellsCharged?: number;
  readonly cellsCached?: number;
}

interface RunRow {
  id: string;
  created_by: string | null;
  tool_key: ToolKey;
  brand_name: string | null;
  brand_url: string | null;
  target_url: string | null;
  query_text: string | null;
  prompt_texts: string[] | null;
  engine_keys: string[];
  locale: string;
  result_json: ToolRunResult | null;
  sov_estimate: number | null;
  citation_count: number | null;
  sentiment_label: ToolRunHeadline["sentiment_label"];
  brand_present: boolean | null;
  aux_score: number | null;
  entities_found: number | null;
  pages_scanned: number | null;
  items_kept: number | null;
  engines_succeeded: string[];
  engines_failed: string[];
  cache_layer: "live" | "l1";
  credits_charged: number;
  duration_ms: number | null;
  status: ToolRunStatus;
  error_code: string | null;
  diff_base_run_id: string | null;
  diff_compare_run_id: string | null;
  converted_project_id: string | null;
  converted_at: Date | null;
  pinned: boolean;
  expires_at: Date;
  created_at: Date;
  created_at_key: string;
}

const COLUMNS = `id, created_by, tool_key, brand_name, brand_url, target_url, query_text, prompt_texts, engine_keys, locale, result_json,
  sov_estimate, citation_count, sentiment_label, brand_present, aux_score, entities_found, pages_scanned, items_kept,
  engines_succeeded, engines_failed, cache_layer, credits_charged, duration_ms, status, error_code,
  diff_base_run_id, diff_compare_run_id, converted_project_id, converted_at, pinned, expires_at, created_at,
  to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_at_key`;

const iso = (value: Date): string => value.toISOString();

function headlineOf(row: RunRow): ToolRunHeadline {
  return {
    sov_estimate: row.sov_estimate,
    citation_count: row.citation_count,
    sentiment_label: row.sentiment_label,
    brand_present: row.brand_present,
    aux_score: row.aux_score,
    entities_found: row.entities_found,
    pages_scanned: row.pages_scanned,
    items_kept: row.items_kept,
  };
}

/** AC14 - an expired run is a metrics-only row that says what was removed and when. `removed_at` is the end of its retention window. */
function expiredNotice(row: RunRow): ToolRun["expired"] {
  if (row.status !== "expired") return null;
  const day = iso(row.expires_at).slice(0, 10);
  return {
    removed: "result",
    removed_at: iso(row.expires_at),
    summary: `The stored result was removed on ${day} when its retention window ended. The headline figures and the inputs are kept.`,
  };
}

function toRun(row: RunRow): ToolRun {
  const headline = headlineOf(row);
  return {
    id: row.id,
    tool_key: row.tool_key,
    status: row.status,
    created_by: row.created_by,
    created_at: iso(row.created_at),
    expires_at: iso(row.expires_at),
    pinned: row.pinned,
    inputs: {
      brand_name: row.brand_name,
      brand_url: row.brand_url,
      target_url: row.target_url,
      query_text: row.query_text,
      prompt_texts: row.prompt_texts,
      engine_keys: row.engine_keys,
      locale: row.locale,
    },
    headline,
    engines_succeeded: row.engines_succeeded,
    engines_failed: row.engines_failed,
    credits_charged: row.credits_charged,
    duration_ms: row.duration_ms,
    cache_layer: row.cache_layer,
    error_code: row.error_code,
    diff_base_run_id: row.diff_base_run_id,
    diff_compare_run_id: row.diff_compare_run_id,
    converted_project_id: row.converted_project_id,
    converted_at: row.converted_at === null ? null : iso(row.converted_at),
    presentation: toolPresentation(row.tool_key, headline),
    expired: expiredNotice(row),
  };
}

function toDetail(row: RunRow): ToolRunDetail {
  const plan = toolConversionPlan(row);
  return { ...toRun(row), result: row.result_json, conversion: { state: plan.state, reason: plan.reason, credits: plan.credits, prefill: plan.prefill } };
}

/** `%`, `_` and `\` in a search term are text, not wildcards. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

function limitOf(value: unknown): number | null {
  const limit = structuralLimitFrom(value as EntitlementValue);
  if (limit === undefined) return 0;
  return limit.kind === "unlimited" ? null : limit.limit;
}

@Injectable()
export class ToolsService {
  constructor(
    private readonly entitlements: EntitlementResolver,
    private readonly projects: ProjectsService,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Lifecycle - called in-process by each tool's own story, inside its request's (or job's) tenant transaction.
  // ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * AC5, AC6, AC8 - creates a run `running`, with `expires_at` fixed NOW from the plan's retention, and debits its flat price from the
   * wallet (a ledger entry, never a usage counter). A wallet that cannot cover it is a 402 and the run is not created: both writes share
   * the caller's transaction.
   */
  async startRun(input: StartToolRunInput): Promise<StartedToolRun> {
    return await tracer.startActiveSpan("tools.run.start", async (span) => {
      try {
        const { client, workspaceId, actorId } = this.store();
        span.setAttributes({ "nominara.workspace_id": workspaceId, "nominara.tool_key": input.toolKey });
        if (!Number.isInteger(input.credits) || input.credits < 0 || input.credits > MAX_RUN_CREDITS) throw new Error(`a tool run's price is a whole number of credits, got ${String(input.credits)}`);
        if (input.credits > 0 && (FREE_TOOL_KEYS as readonly string[]).includes(input.toolKey)) {
          throw new Error(`${input.toolKey} is a free tool and can never be charged`);
        }
        const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
        const id = uuidV7();
        const expiresAt = toolSnapshotExpiresAt(resolved.entitlements, new Date());
        const engineKeys = [...(input.engineKeys ?? [])];
        const hash = toolInputHash(input.toolKey, {
          brandName: input.brandName,
          brandUrl: input.brandUrl,
          targetUrl: input.targetUrl,
          queryText: input.queryText,
          promptTexts: input.promptTexts,
          engineKeys,
          locale: input.locale,
          diffBaseRunId: input.diffBaseRunId,
          diffCompareRunId: input.diffCompareRunId,
        });
        await client.query(
          `INSERT INTO tool_runs
             (id, workspace_id, created_by, tool_key, brand_name, brand_url, target_url, query_text, prompt_texts, input_hash, engine_keys,
              locale, result_json, diff_base_run_id, diff_compare_run_id, credits_charged, status, expires_at)
           VALUES ($1, app.current_workspace(), $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'en-US'), $12::jsonb, $13, $14, $15, 'running', $16)`,
          [
            id, actorId, input.toolKey, input.brandName ?? null, input.brandUrl ?? null, input.targetUrl ?? null, input.queryText ?? null,
            input.promptTexts === undefined || input.promptTexts === null ? null : [...input.promptTexts], hash, engineKeys, input.locale ?? null,
            input.resultJson === undefined || input.resultJson === null ? null : JSON.stringify(input.resultJson),
            input.diffBaseRunId ?? null, input.diffCompareRunId ?? null, input.credits, expiresAt,
          ],
        );
        if (input.credits > 0) {
          await debitInTransaction(client, {
            workspaceId,
            actorId,
            actorType: actorId === SYSTEM_ACTOR_ID ? "system" : "user",
            actionCode: "lookup",
            credits: input.credits,
            // Built with join: a three-segment colon template reads as an un-namespaced cache key to the ISO-13 scanner, and this is a ledger key.
            idempotencyKey: ["tool_run", id].join(":"),
            referenceType: "tool_run",
            referenceId: id,
            includedGrant: includedGrantOf(resolved.entitlements),
          });
        }
        incrementCounter("nominara_tools_runs_started_total", { tool_key: input.toolKey });
        logger.log({ event: "tools.run.started", workspace_id: workspaceId, run_id: id, tool_key: input.toolKey, credits: input.credits });
        return { id, expiresAt, creditsCharged: input.credits };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * AC5, AC7 - moves a `running` run to exactly one terminal state, once. Nothing captured: `failed` and the debit is returned in full.
   * Some engines failed: `partial`, charged in full, and the succeeded / failed arrays say so. A repeat (at-least-once delivery) returns the
   * stored outcome and writes nothing: the database trigger would refuse a rewrite anyway.
   */
  async finishRun(runId: string, finish: FinishToolRun): Promise<ToolRun> {
    return await tracer.startActiveSpan("tools.run.finish", async (span) => {
      try {
        const { client, workspaceId } = this.store();
        span.setAttributes({ "nominara.workspace_id": workspaceId, "nominara.run_id": runId });
        const found = await client.query<RunRow>(`SELECT ${COLUMNS} FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1 FOR UPDATE`, [runId]);
        const row = found.rows[0];
        if (row === undefined) throw new NotFoundError({ message: "no such tool run" });
        if (row.status !== "running") return toRun(row);

        const succeeded = [...(finish.enginesSucceeded ?? [])];
        const outcome = deriveToolRunOutcome({ engineKeys: row.engine_keys, enginesSucceeded: succeeded, enginesFailed: [...(finish.enginesFailed ?? [])], ...(finish.failed === undefined ? {} : { failed: finish.failed }) });
        const failed = [...outcome.enginesFailed];
        let creditsCharged = row.credits_charged;
        if (outcome.refund && creditsCharged > 0) {
          const { refunded } = await settleFinishedRunCredits(client, { workspaceId, runId, deliveredCells: 0, referenceType: "tool_run" });
          creditsCharged -= refunded;
        }
        const h = finish.headline ?? {};
        const pick = <K extends keyof ToolRunHeadline>(key: K): ToolRunHeadline[K] => (h[key] !== undefined ? (h[key] as ToolRunHeadline[K]) : (row[key] as ToolRunHeadline[K]));
        const result = finish.result === undefined ? row.result_json : finish.result;
        const updated = await client.query<RunRow>(
          `UPDATE tool_runs SET
             status = $2, engines_succeeded = $3, engines_failed = $4, result_json = $5::jsonb,
             sov_estimate = $6, citation_count = $7, sentiment_label = $8, brand_present = $9, aux_score = $10,
             entities_found = $11, pages_scanned = $12, items_kept = $13,
             duration_ms = COALESCE($14, duration_ms), error_code = COALESCE($15, error_code), cache_layer = COALESCE($16, cache_layer),
             cells_charged = COALESCE($17, cells_charged), cells_cached = COALESCE($18, cells_cached), credits_charged = $19
           WHERE workspace_id = app.current_workspace() AND id = $1 AND status = 'running'
           RETURNING ${COLUMNS}`,
          [
            runId, outcome.status, succeeded, failed, result === null ? null : JSON.stringify(result),
            pick("sov_estimate"), pick("citation_count"), pick("sentiment_label"), pick("brand_present"), pick("aux_score"),
            pick("entities_found"), pick("pages_scanned"), pick("items_kept"),
            finish.durationMs ?? null, finish.errorCode ?? null, finish.cacheLayer ?? null, finish.cellsCharged ?? null, finish.cellsCached ?? null, creditsCharged,
          ],
        );
        const done = updated.rows[0];
        if (done === undefined) throw new ConflictError({ message: "the run left running while it was being finished", details: { current_state: "not_running" } });
        span.setAttribute("nominara.tool_run.status", done.status);
        incrementCounter("nominara_tools_runs_finished_total", { tool_key: done.tool_key, status: done.status });
        logger.log({ event: "tools.run.finished", workspace_id: workspaceId, run_id: runId, tool_key: done.tool_key, status: done.status, credits_charged: creditsCharged });
        return toRun(done);
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Timeline and reads - FREE FOREVER on every tier. One SELECT, no write, no wallet, no queue.
  // ---------------------------------------------------------------------------------------------------------------------------------

  /** AC9 - `GET /v1/tools/runs`. One timeline for all six tools, newest first, cursor-paged. */
  async list(query: ToolRunListQuery): Promise<Page<ToolRun>> {
    const { client } = this.store();
    const after = query.cursor === undefined ? undefined : decodeTimestampIdCursor(query.cursor, LIST_NAME);
    const rows = await client.query<RunRow>(
      `SELECT ${COLUMNS} FROM tool_runs
        WHERE workspace_id = app.current_workspace()
          AND ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
          AND ($3::text IS NULL OR tool_key = $3)
          AND ($4::text IS NULL OR brand_name ILIKE $5 ESCAPE '\\' OR brand_name % $4)
          AND ($6::uuid IS NULL OR created_by = $6)
          AND ($7::timestamptz IS NULL OR created_at >= $7)
          AND ($8::timestamptz IS NULL OR created_at <= $8)
          AND ($9::boolean IS NULL OR pinned = $9)
        ORDER BY created_at DESC, id DESC
        LIMIT $10`,
      [
        after?.[0] ?? null, after?.[1] ?? null, query.tool_key ?? null, query.brand ?? null, query.brand === undefined ? null : likePattern(query.brand),
        query.created_by ?? null, query.from ?? null, query.to ?? null, query.pinned === undefined ? null : query.pinned === "true", query.limit + 1,
      ],
    );
    incrementCounter("nominara_tools_timeline_reads_total");
    return pageFrom(rows.rows, query.limit, LIST_NAME, toRun, (row) => [row.created_at_key, row.id]);
  }

  /** AC11 - re-opening a stored run. Reads `result_json` and nothing else. */
  async get(id: string): Promise<ToolRunDetail> {
    const { client } = this.store();
    const found = await client.query<RunRow>(`SELECT ${COLUMNS} FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1`, [id]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such tool run" });
    incrementCounter("nominara_tools_run_reopens_total", { tool_key: row.tool_key });
    return toDetail(row);
  }

  /** A read of one run for a caller that is not a person re-opening it (the scan's stream): the same row as `get`, without counting a re-open. */
  async peek(id: string): Promise<ToolRunDetail> {
    const { client } = this.store();
    const found = await client.query<RunRow>(`SELECT ${COLUMNS} FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1`, [id]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such tool run" });
    return toDetail(row);
  }

  /** AC10 - pinning is a flag that the `?pinned=` filter selects on (the timeline is not re-sorted by it). Owner decision 32 (2026-10-30). It touches no retention column: `expires_at` is not in this statement. */
  async setPinned(id: string, pinned: boolean): Promise<ToolRun> {
    const { client } = this.store();
    const updated = await client.query<RunRow>(`UPDATE tool_runs SET pinned = $2 WHERE workspace_id = app.current_workspace() AND id = $1 RETURNING ${COLUMNS}`, [id, pinned]);
    const row = updated.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such tool run" });
    incrementCounter("nominara_tools_run_pin_changes_total", { pinned: String(pinned) });
    return toRun(row);
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  // Conversion - one contract for all six entry points.
  // ---------------------------------------------------------------------------------------------------------------------------------

  /** AC17 - the slot cost, stated BEFORE the click: which project slot, how many prompt slots. */
  async conversionPreview(id: string): Promise<ToolRunConversionPreview> {
    const { client, workspaceId } = this.store();
    const found = await client.query<RunRow>(`SELECT ${COLUMNS} FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1`, [id]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such tool run" });
    const plan = toolConversionPlan(row);
    return { ...plan, ...(await this.slotCost(client, workspaceId, plan.prefill.prompts.length, plan.prefill.competitors.length)) };
  }

  /**
   * AC16..AC20 - copies whichever inputs the source tool produced into a new project and enqueues discovery (ProjectsService.create does
   * both, after the commit). IDEMPOTENT BY RUN: the run row is locked first, so two clicks serialise and the second returns the first
   * project. Conversion DEBITS NOTHING: a prompt already paid for is not charged again, and tracking thereafter costs 0 credits.
   */
  async convert(id: string, body: ConvertToolRunRequest): Promise<ConvertToolRunResponse> {
    return await tracer.startActiveSpan("tools.run.convert", async (span) => {
      try {
        const { client, workspaceId, actorId } = this.store();
        span.setAttributes({ "nominara.workspace_id": workspaceId, "nominara.run_id": id });
        const found = await client.query<RunRow>(`SELECT ${COLUMNS} FROM tool_runs WHERE workspace_id = app.current_workspace() AND id = $1 FOR UPDATE`, [id]);
        const row = found.rows[0];
        if (row === undefined) throw new NotFoundError({ message: "no such tool run" });
        const plan = toolConversionPlan(row);
        const slot = await this.slotCost(client, workspaceId, plan.prefill.prompts.length, plan.prefill.competitors.length);
        span.setAttribute("nominara.tool_key", row.tool_key);

        if (row.converted_project_id !== null && row.converted_at !== null) {
          return {
            run_id: row.id,
            project_id: row.converted_project_id,
            converted_at: iso(row.converted_at),
            already_converted: true,
            slot_cost: { project_slot: slot.project_slot, prompt_slots: slot.prompt_slots, competitor_slots: slot.competitor_slots, credits: 0 as const },
            poll: { discovery: `/v1/projects/${row.converted_project_id}/discovery` },
          };
        }
        if (plan.reason === "run_not_finished" || plan.reason === "run_failed") {
          throw new ConflictError({ message: `this run cannot seed a project (${plan.reason})`, details: { current_state: plan.reason } });
        }
        const rootUrl = body.root_url ?? plan.prefill.root_url;
        if (rootUrl === null) {
          throw new ValidationFailedError({
            message: "this run has no URL to seed a project from; supply root_url",
            details: { issues: [{ path: ["root_url"], message: "required: the source run carries no URL" }] },
          });
        }
        const name = body.name ?? plan.prefill.project_name ?? undefined;
        const created = await this.projects.create(
          workspaceId,
          actorId,
          { root_url: rootUrl, ...(name === undefined ? {} : { name }), ...(row.locale === "en-US" ? {} : { locale: row.locale }), ...(plan.prefill.prompts.length === 0 ? {} : { prompts: plan.prefill.prompts.map((text) => ({ text })) }),
            // Only as many as the plan allows (the preview states the same figure): a run that found more than the cap still converts.
            ...(slot.competitor_slots.carried === 0 ? {} : { competitors: plan.prefill.competitors.slice(0, slot.competitor_slots.carried).map((name) => ({ name })) }) },
          undefined,
        );
        const stamped = await client.query<{ converted_at: Date }>(
          "UPDATE tool_runs SET converted_project_id = $2, converted_at = now() WHERE workspace_id = app.current_workspace() AND id = $1 AND converted_project_id IS NULL RETURNING converted_at",
          [id, created.project_id],
        );
        const convertedAt = stamped.rows[0]?.converted_at;
        if (convertedAt === undefined) throw new ConflictError({ message: "the run was converted while this request was creating its project", details: { current_state: "converted" } });
        // AC19 - Owner decision 33 (2026-10-30): the nominara_tools_conversions_total counter (tool as a label) plus the log line below IS the funnel event.
        // Counted once, after the stamp, in the transaction that created the project.
        incrementCounter("nominara_tools_conversions_total", { tool_key: row.tool_key });
        logger.log({ event: "tools.run.converted", workspace_id: workspaceId, run_id: id, tool_key: row.tool_key, project_id: created.project_id });
        return {
          run_id: id,
          project_id: created.project_id,
          converted_at: iso(convertedAt),
          already_converted: false,
          slot_cost: { project_slot: { used: slot.project_slot.used + 1, max: slot.project_slot.max, free: slot.project_slot.max === null || slot.project_slot.used + 1 < slot.project_slot.max }, prompt_slots: slot.prompt_slots, competitor_slots: slot.competitor_slots, credits: 0 as const },
          poll: { discovery: created.poll.discovery },
        };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async slotCost(
    client: ClientBase,
    workspaceId: string,
    promptsCarried: number,
    competitorsFound: number,
  ): Promise<Pick<ToolRunConversionPreview, "project_slot" | "prompt_slots" | "competitor_slots" | "credits">> {
    const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
    const used = await countStructural(client, "projects.max", workspaceId);
    const max = limitOf(resolved.entitlements["projects.max"]?.value);
    const competitorCap = limitOf(resolved.entitlements["competitors.max_per_project"]?.value);
    return {
      project_slot: { used, max, free: max === null || used < max },
      prompt_slots: { carried: promptsCarried, cap: limitOf(resolved.entitlements["prompts.max_per_project"]?.value) },
      competitor_slots: { carried: competitorCap === null ? competitorsFound : Math.min(competitorsFound, competitorCap), cap: competitorCap },
      credits: 0 as const,
    };
  }

  private store(): { client: ClientBase; workspaceId: string; actorId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ToolsService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }
}

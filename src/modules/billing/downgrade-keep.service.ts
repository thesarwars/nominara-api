import { Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type { DowngradeKeepRecord, DowngradeKeepRequest, DowngradeKeepResponse } from "../../../contracts/billing/downgrade-keep.schema.js";
import type { PendingPlanChange } from "../../../contracts/billing/plan-change.schema.js";
import { entitlementOverridesSchema } from "../../../contracts/entitlements/resolved-entitlements.schema.js";
import { MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import { ConflictError, PreconditionUnmetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import type { Entitlement, EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { splitAddons } from "../../lib/billing/downgrade-excess.js";
import { keptAfter, readKeepRecord, validateKeepChoice } from "../../lib/billing/downgrade-keep.js";
import { keepOrder, pauseLimitsFrom, planDowngradePause, readActivityKeys, type PauseLimits, type PauseProject, type PausePrompt } from "../../lib/billing/downgrade-pause.js";
import { readPendingPlanChange } from "../../lib/billing/plan-change-intent.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import { PROMPT_OCCUPIES_SLOT } from "../../lib/entitlements/structural-usage.js";
import { mergeEntitlements } from "../../lib/entitlements/resolution.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-077 D2 — GET/PUT /v1/billing/subscription/change/keep (owner approved 2026-10-20). The contract
// (contracts/billing/downgrade-keep.schema.ts) says what "keep" means; the cut-over applies it (stripe-subscription.handler.ts
// -> downgrade-pause.ts). This service only shows what can be kept, the target's limits and the default, and records a
// choice that fits them.
//
// ⚠ THE CHOICE IS BOUND TO ITS INTENT. It is written only while `pending_plan_change` is a DOWNGRADE, carries that intent's
// id, and the write is conditional on the same id: a cancel or a cut-over that committed while this request waited leaves
// nothing to write to (409 plan_change_not_pending), and every path that spends the intent clears the choice with it.
//
// ⚠ ONE LOCK ORDER. The PUT takes the workspace row lock (bounded, as every billing writer of that row does) before it
// reads anything, so it serialises with the cancel and the cut-over, which both hold it.

const tracer = trace.getTracer("nominara-api");

interface Context {
  readonly intent: PendingPlanChange;
  readonly record: DowngradeKeepRecord | null;
  readonly limits: PauseLimits;
  readonly projects: ReadonlyArray<PauseProject & { readonly name: string }>;
  readonly prompts: ReadonlyArray<PausePrompt & { readonly text: string }>;
}

@Injectable()
export class DowngradeKeepService {
  private readonly logger = new Logger(DowngradeKeepService.name);

  /** `GET /v1/billing/subscription/change/keep`. */
  async view(): Promise<DowngradeKeepResponse> {
    return await this.traced("billing.downgrade_keep.view", async () => {
      const { client, workspaceId } = this.tenant();
      return this.render(await this.context(client, workspaceId));
    });
  }

  /** `PUT /v1/billing/subscription/change/keep`. */
  async choose(request: DowngradeKeepRequest): Promise<DowngradeKeepResponse> {
    return await this.traced("billing.downgrade_keep.choose", async () => {
      const { client, workspaceId } = this.tenant();
      await lockWorkspaceBounded(client, workspaceId, () => {
        this.outcome("lock_wait_exceeded");
        return new ConflictError({ message: "another billing change for this workspace is in progress: retry shortly" });
      });
      const ctx = await this.context(client, workspaceId);
      const issues = validateKeepChoice(request, keepableOf(ctx), ctx.limits);
      if (issues.length > 0) {
        this.outcome("invalid");
        throw new ValidationFailedError({ message: "the choice does not fit the plan you are moving to", details: { issues } });
      }
      const record: DowngradeKeepRecord = { intent_id: ctx.intent.id, project_ids: request.project_ids, prompt_ids: request.prompt_ids, chosen_at: new Date().toISOString() };
      const written = await client.query(
        `UPDATE subscriptions SET downgrade_keep = $3::jsonb, updated_at = now()
          WHERE workspace_id = $1 AND status IN ('trialing','active','past_due') AND pending_plan_change ->> 'id' = $2`,
        [workspaceId, ctx.intent.id, JSON.stringify(record)],
      );
      if (written.rowCount !== 1) throw this.notPending();
      this.outcome("chosen");
      this.logger.log({ message: "downgrade keep choice recorded", workspace_id: workspaceId, projects: record.project_ids.length, prompts: record.prompt_ids.length });
      return this.render({ ...ctx, record });
    });
  }

  private async context(client: ClientBase, workspaceId: string): Promise<Context> {
    const sub = await client.query<{ pending_plan_change: unknown; downgrade_keep: unknown }>(
      "SELECT pending_plan_change, downgrade_keep FROM subscriptions WHERE workspace_id = $1 AND status IN ('trialing','active','past_due')",
      [workspaceId],
    );
    const read = readPendingPlanChange(sub.rows[0]?.pending_plan_change);
    if (read.kind === "malformed") {
      this.outcome("intent_malformed");
      this.logger.error({ message: "pending_plan_change does not parse; keep choice refused", workspace_id: workspaceId });
      throw new ConflictError({ message: "a plan change is in an unknown state: contact support", details: { reason: "plan_change_pending" } });
    }
    if (read.kind === "none" || read.intent.direction !== "downgrade") throw this.notPending();
    const intent = read.intent;
    const record = readKeepRecord(sub.rows[0]?.downgrade_keep);

    const projectRows = await client.query<{ id: string; name: string; created_key: string; status: PauseProject["status"]; marked: boolean }>(
      `SELECT id, name, to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_key, status, paused_by_downgrade_at IS NOT NULL AS marked
         FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL`,
      [workspaceId],
    );
    const promptRows = await client.query<{ id: string; project_id: string; text: string; created_key: string; status: "active" | "paused"; marked: boolean }>(
      `SELECT id, project_id, text, to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_key, status, paused_by_downgrade_at IS NOT NULL AS marked
         FROM tracked_prompts WHERE workspace_id = $1 AND ${PROMPT_OCCUPIES_SLOT}`,
      [workspaceId],
    );
    const activity = await readActivityKeys(client, workspaceId);
    return {
      intent,
      record: record !== null && record.intent_id === intent.id ? record : null,
      limits: await this.targetLimits(client, workspaceId, intent.to_plan_key),
      projects: projectRows.rows.map((r) => ({ id: r.id, name: r.name, createdKey: r.created_key, status: r.status, pausedByDowngrade: r.marked, activityKey: activity.projects.get(r.id) ?? null })),
      prompts: promptRows.rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        text: r.text,
        createdKey: r.created_key,
        status: r.status,
        pausedByDowngrade: r.marked,
        activityKey: activity.prompts.get(r.id) ?? null,
      })),
    };
  }

  /** The target plan's limits as the cut-over will resolve them: the plan, the add-ons it still allows, the overrides. */
  private async targetLimits(client: ClientBase, workspaceId: string, targetPlanKey: string): Promise<PauseLimits> {
    const plan = await client.query<{ entitlements: Record<string, Entitlement> }>("SELECT entitlements FROM plans WHERE key = $1", [targetPlanKey]);
    const workspace = await client.query<{ entitlement_overrides: unknown }>("SELECT entitlement_overrides FROM workspaces WHERE id = $1", [workspaceId]);
    if (plan.rows[0] === undefined || workspace.rows[0] === undefined) throw new PreconditionUnmetError({ message: "the plan being moved to is not in the catalog" });
    const addons = await client.query<{ kind: "extra_project" | "extra_seat"; quantity: number }>(
      "SELECT kind, quantity FROM subscription_addons WHERE workspace_id = $1 AND active_until IS NULL AND active_from <= now()",
      [workspaceId],
    );
    const held: Partial<Record<"extra_project" | "extra_seat", number>> = {};
    for (const row of addons.rows) held[row.kind] = row.quantity;
    const targetPlan = plan.rows[0].entitlements;
    const overrides = entitlementOverridesSchema.parse(workspace.rows[0].entitlement_overrides) as Record<string, EntitlementValue>;
    return pauseLimitsFrom(mergeEntitlements(targetPlan, splitAddons(targetPlan, held).surviving, overrides));
  }

  private render(ctx: Context): DowngradeKeepResponse {
    const keepable = keepableOf(ctx);
    const projects = keepOrder(ctx.projects.filter((p) => keepable.has(p.id)));
    const promptsOf = (projectId: string) => keepOrder(ctx.prompts.filter((p) => p.projectId === projectId && keepable.get(projectId)!.has(p.id)));
    const defaults = keptAfter(planDowngradePause(ctx.limits, ctx.projects, ctx.prompts), ctx.projects, ctx.prompts);
    const keepableProjectIds = new Set(keepable.keys());
    const keepablePromptIds = new Set([...keepable.values()].flatMap((s) => [...s]));
    return {
      target_plan_key: ctx.intent.to_plan_key,
      effective_at: ctx.intent.effective_at,
      limits: { projects: ctx.limits.projects, prompts_total: ctx.limits.promptsTotal, prompts_per_project: ctx.limits.promptsPerProject },
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status as "initializing" | "active" | "paused",
        paused_by_downgrade: p.pausedByDowngrade,
        last_active_at: isoOf(p.activityKey),
        prompts: promptsOf(p.id).map((q) => ({ id: q.id, text: q.text, status: q.status, paused_by_downgrade: q.pausedByDowngrade, last_active_at: isoOf(q.activityKey) })),
      })),
      default: { project_ids: defaults.projectIds, prompt_ids: defaults.promptIds },
      choice:
        ctx.record === null
          ? null
          : {
              project_ids: ctx.record.project_ids.filter((id) => keepableProjectIds.has(id)),
              prompt_ids: ctx.record.prompt_ids.filter((id) => keepablePromptIds.has(id)),
              chosen_at: ctx.record.chosen_at,
            },
    };
  }

  private notPending(): Error {
    this.outcome("not_pending");
    return new ConflictError({ message: "no downgrade is pending: there is nothing to choose for", details: { reason: "plan_change_not_pending" } });
  }

  private outcome(outcome: string): void {
    incrementCounter("nominara_billing_downgrade_keep_total", { outcome });
  }

  private tenant() {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("DowngradeKeepService requires an active tenant context");
    return { client: store.client as ClientBase, workspaceId: store.context.workspaceId };
  }

  private async traced<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return await tracer.startActiveSpan(name, async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

/**
 * What can be kept: a project tracking now (active or initializing) or paused by an earlier downgrade, each with its
 * prompts that are active or paused by an earlier downgrade. A person's pause and an archived row are never keepable:
 * they are theirs, and the cut-over never touches them.
 */
function keepableOf(ctx: Pick<Context, "projects" | "prompts">): Map<string, Set<string>> {
  const keepable = new Map<string, Set<string>>();
  for (const p of ctx.projects) if (p.pausedByDowngrade || p.status === "active" || p.status === "initializing") keepable.set(p.id, new Set());
  for (const q of ctx.prompts) if (q.status === "active" || q.pausedByDowngrade) keepable.get(q.projectId)?.add(q.id);
  return keepable;
}

/** A planner microsecond key as an ISO instant (milliseconds), or null. */
function isoOf(key: string | null | undefined): string | null {
  return key === null || key === undefined ? null : new Date(key).toISOString();
}

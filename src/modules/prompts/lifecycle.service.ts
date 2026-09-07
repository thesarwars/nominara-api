import { Injectable } from "@nestjs/common";
import type { IntentArchetype, PromptResponse, UpdatePromptRequest } from "../../../contracts/prompts/index.js";
import type { FunnelStage } from "../../../contracts/prompts/index.js";
import { ConflictError, EntitlementExceededError, NotFoundError } from "../../api/errors/domain-errors.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { insertPromptStatement } from "../../lib/promptgen/persist.js";
import { promptTextHash } from "../../lib/promptgen/text-hash.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-046 — `PATCH /v1/prompts/{id}`. api-specification.md §3:
// "pause/resume, priority flag, edit text (re-hashes and starts a new
// series)".
//
// *** THIS ROUTE IS A SECOND DOOR INTO ACTIVATION, AND IT HAS TO BE LOCKED
//     THE SAME WAY. ***
//
// `PROMPT_OCCUPIES_SLOT` is `status <> 'archived'`, so ANY transition out of
// `archived` consumes a plan slot. Without the cap check below, a customer at
// their limit could PATCH archived prompts to active one at a time and never
// meet the check `POST .../activate` enforces. The subtle half is that
// `archived -> paused` takes a slot too — a check written only for
// `status === 'active'` would leave the hole half-open.
//
// THE EDIT PATH IS NOT AN UPDATE. `FR-FAN-01f`: "Editing a prompt's text
// creates a new `text_hash` and starts a NEW HISTORY SERIES, with the
// previous series preserved and visibly marked `superseded`. Metric
// continuity is never faked across a wording change." The story calls it a
// measurement-integrity requirement, and gives the reason: "Carrying history
// across a wording change would silently compare answers to two different
// questions, and the resulting trend would be meaningless while looking
// perfectly normal."

/** `PROMPT_OCCUPIES_SLOT`, verbatim from src/lib/entitlements/structural-usage.ts. */
const OCCUPIES_SLOT = "status <> 'archived' AND deleted_at IS NULL";

const PROMPTS_CAP_COLUMN_MAX = 32_767;

interface PromptRow {
  id: string;
  project_id: string;
  workspace_id: string;
  status: "active" | "paused" | "archived";
  is_priority: boolean;
  text: string;
  intent_archetype: string;
  funnel_stage: string;
  generation_source: string;
  generation_batch_id: string | null;
  generator_meta: Record<string, unknown>;
}

type TenantClient = { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> };

@Injectable()
export class PromptLifecycleService {
  constructor(private readonly entitlements: EntitlementResolver) {}

  async update(promptId: string, request: UpdatePromptRequest): Promise<PromptResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptLifecycleService.update requires an active tenant context");
    const client = store.client as TenantClient;

    const prompt = await this.load(client, promptId);

    if (request.status !== undefined) await this.assertStatusChangeAllowed(client, store.context.workspaceId, prompt, request.status);
    if (request.is_priority !== undefined) await this.assertPriorityAllowed(client, store.context.workspaceId, prompt, request.is_priority);

    // An EDIT replaces the row, so it subsumes any status or flag change in
    // the same request — the new row is written with them already applied
    // rather than inserted and then updated.
    const edited = this.editedText(prompt, request);
    if (edited !== null) return this.supersede(client, prompt, edited, request);

    return this.applyInPlace(client, prompt, request);
  }

  /**
   * The new wording, or null when there is nothing to supersede.
   *
   * IDENTICAL TEXT IS A NO-OP. Editing to the same wording would otherwise
   * archive the row, insert a byte-identical one, break the metric series for
   * no change at all — and the insert would collide with the row it just
   * archived, so the customer would get a 500 for pressing save without
   * editing. Compared on the NORMALISED hash rather than the raw string, so a
   * change that is only whitespace is also a no-op, matching what
   * `text_hash` treats as the same prompt.
   */
  private editedText(prompt: PromptRow, request: UpdatePromptRequest): string | null {
    if (request.text === undefined) return null;
    if (promptTextHash(request.text).wire === promptTextHash(prompt.text).wire) return null;
    return request.text;
  }

  /**
   * `FR-FAN-01f` — a new row, a new series, the old one linked and archived.
   *
   * The old row is ARCHIVED rather than left active: it must stop capturing,
   * and archiving releases its slot to the new row, so the net occupancy of
   * an edit is zero and an edit at the cap still works.
   */
  private async supersede(client: TenantClient, prompt: PromptRow, text: string, request: UpdatePromptRequest): Promise<PromptResponse> {
    const status = request.status ?? (prompt.status === "archived" ? "archived" : prompt.status);
    const row = {
      id: uuidV7(),
      workspaceId: prompt.workspace_id,
      projectId: prompt.project_id,
      generationBatchId: prompt.generation_batch_id,
      // KEPT, not relabelled `manual`. `generation_source` records how the
      // prompt came to EXIST — it was generated and then reworded, whereas
      // `manual` means the customer typed it from nothing. Relabelling would
      // also silently shrink FR-CRD-08's coverage denominator.
      generationSource: prompt.generation_source as "generated" | "manual",
      text,
      textHash: promptTextHash(text).bytes,
      // CARRIED OVER. The new row is the same question reworded, so its
      // classification is unchanged — and re-deriving it would need the
      // generator and the original slot context, neither of which a PATCH
      // has.
      intentArchetype: prompt.intent_archetype as IntentArchetype,
      funnelStage: prompt.funnel_stage as FunnelStage,
      generatorMeta: { ...prompt.generator_meta, edited_from: prompt.id, edited_at: new Date().toISOString() },
      isPriority: request.is_priority ?? prompt.is_priority,
      status,
    } as const;

    const { sql, params } = insertPromptStatement(row);
    try {
      await client.query(sql, [...params]);
    } catch (error: unknown) {
      // `ux_prompts_project_hash` is unique on (project_id, text_hash).
      // Editing a prompt into the exact wording of another one is something
      // the customer can act on, not an unhandled database error — the same
      // treatment the project slug collision gets.
      if (isUniqueViolation(error)) {
        throw new ConflictError({ message: "another prompt in this project already has that wording" });
      }
      throw error;
    }

    // The old row's TEXT is never rewritten — that is exactly what would fake
    // continuity across two different questions.
    await client.query(
      `UPDATE tracked_prompts SET status = 'archived', superseded_by = $2, updated_at = now() WHERE id = $1`,
      [prompt.id, row.id],
    );

    const counts = await this.refreshCounts(client, prompt.project_id);
    return {
      prompt_id: row.id,
      project_id: prompt.project_id,
      text,
      text_hash: promptTextHash(text).wire,
      status,
      is_priority: row.isPriority,
      supersedes_prompt_id: prompt.id,
      prompts_active: counts.active,
      prompts_cap: counts.cap,
      credits_charged: 0,
    };
  }

  private async applyInPlace(client: TenantClient, prompt: PromptRow, request: UpdatePromptRequest): Promise<PromptResponse> {
    const status = request.status ?? prompt.status;
    const isPriority = request.is_priority ?? prompt.is_priority;

    await client.query(
      `UPDATE tracked_prompts SET status = $2, is_priority = $3, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
      [prompt.id, status, isPriority],
    );

    const counts = await this.refreshCounts(client, prompt.project_id);
    return {
      prompt_id: prompt.id,
      project_id: prompt.project_id,
      text: prompt.text,
      text_hash: promptTextHash(prompt.text).wire,
      status,
      is_priority: isPriority,
      supersedes_prompt_id: null,
      prompts_active: counts.active,
      prompts_cap: counts.cap,
      credits_charged: 0,
    };
  }

  /**
   * Refuses a transition that would take a slot the plan does not have.
   *
   * `wouldTakeASlot` is the whole check: only a move OUT of `archived`
   * changes occupancy, because `PROMPT_OCCUPIES_SLOT` treats `active` and
   * `paused` identically. So `active -> paused` is free, `paused -> active`
   * is free, and `archived -> anything else` is an activation.
   */
  private async assertStatusChangeAllowed(
    client: TenantClient,
    workspaceId: string,
    prompt: PromptRow,
    next: "active" | "paused" | "archived",
  ): Promise<void> {
    const wouldTakeASlot = prompt.status === "archived" && next !== "archived";
    if (!wouldTakeASlot) return;

    const cap = await this.resolveLimit(workspaceId, "prompts.max_per_project");
    const occupying = await this.countOccupying(client, prompt.project_id);
    if (occupying + 1 > cap) {
      throw new EntitlementExceededError({
        message: `this plan allows ${String(cap)} active prompts per project`,
        details: { key: "prompts.max_per_project", limit: cap, current: occupying },
        remediation: { kind: "increase_limit", url: "/settings/billing" },
      });
    }
  }

  /**
   * AC11 — "The priority flag is settable and bounded by the plan's subset size."
   *
   * CLEARING IS ALWAYS ALLOWED, even past the limit. A project that ended up
   * over it after a downgrade could otherwise not be brought back under,
   * which is the one action that fixes it. Setting a flag that is already set
   * is likewise a no-op and must not be refused at the limit — the same
   * idempotency argument as a replayed activation.
   */
  private async assertPriorityAllowed(
    client: TenantClient,
    workspaceId: string,
    prompt: PromptRow,
    next: boolean,
  ): Promise<void> {
    if (!next || prompt.is_priority) return;

    const limit = await this.resolveLimit(workspaceId, "scan.priority_subset_size");
    const result = await client.query<{ n: number }>(
      `SELECT count(*) FILTER (WHERE is_priority)::int AS n
         FROM tracked_prompts WHERE project_id = $1 AND ${OCCUPIES_SLOT}`,
      [prompt.project_id],
    );
    const flagged = result.rows[0]?.n ?? 0;
    if (flagged + 1 > limit) {
      throw new EntitlementExceededError({
        message: `this plan allows ${String(limit)} priority prompts`,
        details: { key: "scan.priority_subset_size", limit, current: flagged },
        remediation: { kind: "increase_limit", url: "/settings/billing" },
      });
    }
  }

  private async load(client: TenantClient, promptId: string): Promise<PromptRow> {
    // The project's workspace comes from the JOIN rather than the request:
    // RLS scopes the tenant, and the row's own project is the authority on
    // which project this prompt belongs to.
    const result = await client.query<PromptRow>(
      `SELECT p.id, p.project_id, p.workspace_id, p.status, p.is_priority, p.text,
              p.intent_archetype, p.funnel_stage, p.generation_source,
              p.generation_batch_id, p.generator_meta
         FROM tracked_prompts p
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [promptId],
    );
    const prompt = result.rows[0];
    if (prompt === undefined) throw new NotFoundError({ message: "no such prompt" });
    return prompt;
  }

  private async countOccupying(client: TenantClient, projectId: string): Promise<number> {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tracked_prompts WHERE project_id = $1 AND ${OCCUPIES_SLOT}`,
      [projectId],
    );
    return result.rows[0]?.n ?? 0;
  }

  /** Recomputed and written in the same statement sequence (AC10), never incremented. */
  private async refreshCounts(client: TenantClient, projectId: string): Promise<{ active: number; cap: number }> {
    const result = await client.query<{ prompts_active: number; prompts_cap: number }>(
      `UPDATE projects
          SET prompts_active = (SELECT count(*) FROM tracked_prompts
                                 WHERE project_id = $1 AND ${OCCUPIES_SLOT}),
              updated_at = now()
        WHERE id = $1
        RETURNING prompts_active, prompts_cap`,
      [projectId],
    );
    const row = result.rows[0];
    return { active: row?.prompts_active ?? 0, cap: row?.prompts_cap ?? 0 };
  }

  private async resolveLimit(workspaceId: string, key: string): Promise<number> {
    const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
    const value = resolved.entitlements[key]?.value;
    if (value === undefined) return 0;
    const limit = structuralLimitFrom(value as EntitlementValue);
    if (limit === undefined) return 0;
    return limit.kind === "unlimited" ? PROMPTS_CAP_COLUMN_MAX : limit.limit;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

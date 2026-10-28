import { Injectable, Logger, Optional } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { IntentArchetype, PromptResponse, UpdatePromptRequest } from "../../../contracts/prompts/index.js";
import type { FunnelStage } from "../../../contracts/prompts/index.js";
import { ConflictError, EntitlementExceededError, NotFoundError } from "../../api/errors/domain-errors.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { autoTopupEnqueuerFor } from "../../lib/credits/auto-topup-request.js";
import { parseConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { embedBatchEnqueuerFor, requestPromptEmbeddings } from "../../lib/embedding/prompt-embedding-request.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { chargeForActivation, inheritFirstActivation } from "../../lib/promptgen/activation-charge.js";
import { insertPromptStatement } from "../../lib/promptgen/persist.js";
import { promptTextHash } from "../../lib/promptgen/text-hash.js";
import { assertActiveWithinLimits, lockWorkspaceForActivation } from "./active-limit.js";
import { assertProjectInScope } from "../../tenancy/project-scope.js";
import { currentTenantStore, type TenantContext } from "../../tenancy/tenant-context.js";

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
  first_activated_at: Date | null;
  activation_credits: number;
  superseded_by: string | null;
  paused_by_downgrade_at: Date | null;
}

const embedLogger = new Logger("prompts.lifecycle");

type TenantClient = { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> };

@Injectable()
export class PromptLifecycleService {
  constructor(
    private readonly entitlements: EntitlementResolver,
    // Optional, as in CreditInterceptor: a process with no queue producer still charges; it just cannot ask for a top-up.
    @Optional() private readonly producer?: QueueProducer,
  ) {}

  /** `confirmed` is the raw `X-Nominara-Confirmed-Credits` header: required, and compared, only when this change is a charged activation. */
  async update(promptId: string, request: UpdatePromptRequest, confirmed?: string | readonly string[]): Promise<PromptResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptLifecycleService.update requires an active tenant context");
    const client = store.client as TenantClient;

    // THE PROJECT ROW IS LOCKED, and the prompt is read AGAIN under the lock.
    // Whether this change is a first activation, and how much of the project's
    // free allowance is left, are decided from rows that lock protects; the
    // first read only finds the project to lock. Without it a POST .../activate
    // and this PATCH could both take the last free slot.
    const found = await this.load(client, promptId);
    // The id names a prompt, not a project: a scoped member is checked against the row's own project, BEFORE the
    // lock, so a caller outside that project's scope cannot hold its row lock. A prompt never changes project.
    await assertProjectInScope(store.client, found.project_id);
    // STORY-077 review rounds 2 and 3 — ONE LOCK ORDER ON EVERY PATH: workspace, then project, then wallet (the cut-over
    // locks workspace -> wallet -> every project). A move INTO `active` is checked against the workspace-wide active
    // count (active-limit.ts), and leaving `archived` can debit the wallet: a PATCH that took the project lock first and
    // then the wallet closed a cycle with the cut-over (40P01). So EVERY status change or edit takes the workspace lock
    // first, decided from the REQUEST alone - never from the status read before any lock, which the cut-over can change
    // (a prompt read as `active` may be paused by the time the project lock is held). A priority-only change touches
    // neither the active count nor the wallet and keeps to the project lock.
    if (request.status !== undefined || request.text !== undefined) await lockWorkspaceForActivation(store.client as ClientBase, store.context.workspaceId);
    await client.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [found.project_id]);
    const prompt = await this.load(client, promptId);

    // A SUPERSEDED row is history: the live prompt is the one that replaced it. Changing it would let one question
    // grow a second head (an edit inherits the fact and overwrites `superseded_by`), or let a row the free-allowance
    // count never sees be activated. Refused whole - status, flag and text alike.
    if (typeof prompt.superseded_by === "string") {
      throw new ConflictError({
        message: `this prompt was reworded and replaced by ${prompt.superseded_by}; change the replacement`,
        details: { reason: "prompt_superseded" },
      });
    }
    if (request.status !== undefined) await this.assertStatusChangeAllowed(client, store.context.workspaceId, prompt, request.status);
    if (request.is_priority !== undefined) await this.assertPriorityAllowed(client, store.context.workspaceId, prompt, request.is_priority);

    // An EDIT replaces the row, so it subsumes any status or flag change in
    // the same request — the new row is written with them already applied
    // rather than inserted and then updated.
    const edited = this.editedText(prompt, request);
    // AC3 - the SECOND DOOR into activation follows the first door's charge
    // rule. The condition is LEAVING `archived` (the same one the cap check
    // uses), not becoming `active`: archived -> paused takes a slot, and a
    // charge keyed on `active` would be dodged by pausing first.
    const leavingArchived = prompt.status === "archived" && (request.status ?? "archived") !== "archived";
    // Read only when this change IS an activation: a pause, an archive or a flag change has no price to confirm, and a
    // header sent with one is not this route's business.
    const confirmedCredits = leavingArchived ? parseConfirmedCredits(confirmed) : null;
    if (edited !== null) return this.supersede(client, store.context, prompt, edited, request, leavingArchived, confirmedCredits);

    return this.applyInPlace(client, store.context, prompt, request, leavingArchived, confirmedCredits);
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
  private async supersede(
    client: TenantClient,
    context: TenantContext,
    prompt: PromptRow,
    text: string,
    request: UpdatePromptRequest,
    leavingArchived: boolean,
    confirmedCredits: number | null,
  ): Promise<PromptResponse> {
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
      // STORY-077: an archived row never carries the downgrade-pause marker (ck_tracked_prompts_paused_by_downgrade).
      `UPDATE tracked_prompts SET status = 'archived', superseded_by = $2, paused_by_downgrade_at = NULL, updated_at = now() WHERE id = $1`,
      [prompt.id, row.id],
    );

    // STORY-077 review round 3 — a rewording changes the words, not who paused the prompt. A downgrade-paused prompt
    // reworded while it stays paused (no status in the request, or the same one) keeps the marker on its replacement, so
    // a later upgrade still resumes it. A status CHANGE in the same request is a person's decision, as in applyInPlace.
    const keepsMarker = prompt.paused_by_downgrade_at != null && status === "paused" && (request.status === undefined || request.status === prompt.status);
    if (keepsMarker) {
      await client.query("UPDATE tracked_prompts SET paused_by_downgrade_at = $2 WHERE id = $1 AND status = 'paused'", [row.id, prompt.paused_by_downgrade_at]);
    }

    // The reworded row is the SAME QUESTION, so it inherits whether - and at
    // what price - the question was first activated: re-activating it later is
    // free, and the free allowance counts the question once, not once per
    // wording. If this very change is the first activation, the new row is the
    // one that is charged and recorded.
    await inheritFirstActivation(client as unknown as ClientBase, row.id, {
      firstActivatedAt: prompt.first_activated_at,
      activationCredits: prompt.activation_credits,
    });
    const credits = leavingArchived
      ? await this.chargeFirstActivation(client, context, prompt, row.id, row.generationSource, confirmedCredits)
      : 0;

    const counts = await this.refreshCounts(client, prompt.project_id);
    await this.requestEmbedding(client, context, status, row.id);
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
      credits_charged: credits,
    };
  }

  private async applyInPlace(
    client: TenantClient,
    context: TenantContext,
    prompt: PromptRow,
    request: UpdatePromptRequest,
    leavingArchived: boolean,
    confirmedCredits: number | null,
  ): Promise<PromptResponse> {
    const status = request.status ?? prompt.status;
    const isPriority = request.is_priority ?? prompt.is_priority;

    // Before the UPDATE: a 402 rolls the request back with the prompt still archived.
    const credits = leavingArchived
      ? await this.chargeFirstActivation(client, context, prompt, prompt.id, prompt.generation_source, confirmedCredits)
      : 0;

    // STORY-077 AC5 — a person who CHANGES the status of a prompt a downgrade paused makes it THEIRS: the marker is
    // cleared, so a later upgrade never resumes (or re-pauses) what a person decided. A priority-only change, or a
    // status that does not change (paused -> paused), keeps it: a no-op must not take the prompt out of auto-resume.
    await client.query(
      `UPDATE tracked_prompts
          SET status = $2, is_priority = $3, updated_at = now(),
              paused_by_downgrade_at = CASE WHEN $4::boolean THEN NULL ELSE paused_by_downgrade_at END
        WHERE id = $1 AND deleted_at IS NULL`,
      [prompt.id, status, isPriority, request.status !== undefined && request.status !== prompt.status],
    );

    const counts = await this.refreshCounts(client, prompt.project_id);
    await this.requestEmbedding(client, context, status, prompt.id);
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
      credits_charged: credits,
    };
  }

  /**
   * Refuses a transition that would take a slot the plan does not have.
   *
   * Two checks. `wouldTakeASlot`: only a move OUT of `archived` changes
   * occupancy, because `PROMPT_OCCUPIES_SLOT` treats `active` and `paused`
   * identically, so `archived -> anything else` is an activation. And a move
   * INTO `active` must fit the ACTIVE count (STORY-077, active-limit.ts): a
   * downgrade leaves more paused prompts than the cap, and `paused -> active`
   * being free would undo the cut-over one PATCH at a time. `active -> paused`
   * is always free.
   */
  private async assertStatusChangeAllowed(
    client: TenantClient,
    workspaceId: string,
    prompt: PromptRow,
    next: "active" | "paused" | "archived",
  ): Promise<void> {
    const wouldTakeASlot = prompt.status === "archived" && next !== "archived";
    if (wouldTakeASlot) {
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

    if (next === "active" && prompt.status !== "active") {
      const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
      await assertActiveWithinLimits(client, { workspaceId, projectId: prompt.project_id, becomingActive: 1, entitlements: resolved.entitlements });
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

  /**
   * AC3 - charge for (and record) the first activation of the row `recordOn`.
   * `prompt` supplies the FACTS (was it activated before, is it generated);
   * `recordOn` is the row that carries the result, which is the new row after
   * an edit. Returns the credits charged.
   */
  private async chargeFirstActivation(
    client: TenantClient,
    context: TenantContext,
    prompt: PromptRow,
    recordOn: string,
    generationSource: string,
    confirmedCredits: number | null,
  ): Promise<number> {
    const resolved = await this.entitlements.resolveForWorkspace(context.workspaceId);
    const autoTopup = autoTopupEnqueuerFor(this.producer);
    return chargeForActivation(client as unknown as ClientBase, {
      workspaceId: context.workspaceId,
      actorId: context.actorId,
      projectId: prompt.project_id,
      candidates: [{ id: recordOn, generationSource, firstActivatedAt: prompt.first_activated_at }],
      entitlements: resolved.entitlements,
      confirmedCredits,
      ...(autoTopup === undefined ? {} : { autoTopup }),
    });
  }

  private async load(client: TenantClient, promptId: string): Promise<PromptRow> {
    // The project's workspace comes from the JOIN rather than the request:
    // RLS scopes the tenant, and the row's own project is the authority on
    // which project this prompt belongs to.
    const result = await client.query<PromptRow>(
      `SELECT p.id, p.project_id, p.workspace_id, p.status, p.is_priority, p.text,
              p.intent_archetype, p.funnel_stage, p.generation_source,
              p.generation_batch_id, p.generator_meta, p.first_activated_at, p.activation_credits, p.superseded_by,
              p.paused_by_downgrade_at
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

  /**
   * STORY-133 DECISION 3 - a prompt that is ACTIVE after this change and has no vector yet is queued for embedding in this
   * transaction (enqueued after COMMIT). A no-op for a paused or archived result, and for a prompt already embedded.
   */
  private async requestEmbedding(client: TenantClient, context: TenantContext, status: string, promptId: string): Promise<void> {
    if (status !== "active") return;
    const enqueue = embedBatchEnqueuerFor(this.producer);
    if (enqueue === undefined) return;
    await requestPromptEmbeddings(client, context.workspaceId, [promptId], enqueue, embedLogger);
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

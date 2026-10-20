import { Injectable, Logger, Optional } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import type {
  ActivatePromptsPreviewResponse,
  ActivatePromptsRequest,
  ActivatePromptsResponse,
} from "../../../contracts/prompts/index.js";
import { ConflictError, EntitlementExceededError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { autoTopupEnqueuerFor } from "../../lib/credits/auto-topup-request.js";
import { parseConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { chargeForActivation, quoteActivation, type ActivationCandidate } from "../../lib/promptgen/activation-charge.js";
import { nextRunAfter } from "../../lib/capture/scheduler.js";
import type { ProjectCadence } from "../../lib/capture/dispatch-cells.js";
import { canonicalUuid } from "../../api/canonical-uuid.js";
import { assertActiveWithinLimits } from "./active-limit.js";

// STORY-046 — `POST /v1/projects/{id}/prompts/activate`.
// plans-and-entitlements.md §10, api-specification.md §3.
//
// THE CAP BINDS HERE, and that is the story. §10: "Prompt generation always
// produces 15 archetype-aligned candidates per pass — a correctness property
// of the measurement design, not a packaging lever. **Caps bind at
// activation, not at generation.**"
//
// Why that ordering matters, in the story's words: truncating generation
// would drop archetypes, and "a prompt set missing the comparison and
// objection archetypes measures a different thing than one that has them".
// Generating everything and activating a breadth-maximising subset keeps a
// capped project's Visibility Score comparable to anyone else's.
//
// ALL OR NOTHING. §3 gives this route one behaviour — "403
// entitlement_exceeded names the remaining slots" — so a request that does
// not fit is refused whole. A partial activation would pick which of the
// customer's chosen prompts to drop, and now that activation charges it would
// be a partial debit for an outcome nobody asked for. The refusal therefore
// happens before any UPDATE.
//
// THE CHARGE (AC3; owner decision 2026-10-14). plans-and-entitlements.md
// section 4 prices activation at "1 per prompt activated" beyond the free 10.
// It is charged ONCE per generated prompt, at its first activation (see
// src/lib/promptgen/activation-charge.ts for the whole rule), and the debit
// goes through the credit ledger in THIS transaction: a refusal - the cap, or
// 402 insufficient_credits - throws before any UPDATE and rolls back whatever
// was written, so a refused activation charges nothing and activates nothing.
//
// THE PROJECT ROW IS LOCKED FIRST (`assertProjectExists` ... FOR UPDATE). Which
// prompts are new, and how much of the project's free allowance is left, are
// decided from rows that lock protects: two concurrent activations of the same
// prompts serialise, and the second finds them already active and charges 0.

/** `PROMPT_OCCUPIES_SLOT`, verbatim from src/lib/entitlements/structural-usage.ts. */
const OCCUPIES_SLOT = "status <> 'archived' AND deleted_at IS NULL";

/** `projects.prompts_cap` is `smallint`; an unlimited entitlement is clamped to its ceiling. */
const PROMPTS_CAP_COLUMN_MAX = 32_767;

interface PromptRow {
  id: string;
  status: string;
  project_id: string;
  generation_source: string;
  first_activated_at: Date | null;
  superseded_by: string | null;
}

const logger = new Logger("prompts.activation");
const tracer = trace.getTracer("nominara-api");

type TenantClient = { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> };

@Injectable()
export class PromptActivationService {
  constructor(
    private readonly entitlements: EntitlementResolver,
    // Optional, as in CreditInterceptor: a process with no queue producer still charges; it just cannot ask for a top-up.
    @Optional() private readonly producer?: QueueProducer,
  ) {}

  /**
   * `POST /projects/{id}/prompts/activate/preview` - what activating exactly these prompts would cost now.
   *
   * READ-ONLY: no project lock, no wallet read, no reservation, no ledger row, no write of any kind. It prices by
   * `quoteActivation`, the code the activation charges by, so the figure is the one the activation will compute -
   * unless the project changes in between, which is exactly what the activation's own comparison catches (409
   * `price_changed`).
   */
  async preview(projectId: string, request: ActivatePromptsRequest): Promise<ActivatePromptsPreviewResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptActivationService.preview requires an active tenant context");
    const client = store.client as TenantClient;
    const promptIds = this.canonicalIds(request);

    return tracer.startActiveSpan("prompts.activation.preview", async (span) => {
      try {
        await this.assertProjectExists(client, projectId, false);
        const resolved = await this.entitlements.resolveForWorkspace(store.context.workspaceId);
        const prompts = await this.loadPrompts(client, projectId, promptIds);
        const alreadyActive = prompts.filter((prompt) => prompt.status === "active");
        const quote = await quoteActivation(store.client as ClientBase, {
          projectId,
          candidates: this.firstActivationCandidates(prompts),
          entitlements: resolved.entitlements,
        });
        span.setAttributes({
          "nominara.prompts.requested": promptIds.length,
          "nominara.prompts.quoted_free": quote.free.length,
          "nominara.prompts.quoted_charged": quote.charged.length,
          "nominara.credits.quoted": quote.total,
        });
        incrementCounter("nominara_prompts_activation_previews_total", { outcome: quote.total > 0 ? "charged" : "free" });
        logger.log({
          event: "prompts.activation.previewed",
          workspace_id: store.context.workspaceId,
          project_id: projectId,
          prompts_requested: promptIds.length,
          credits: quote.total,
        });
        return {
          credits: quote.total,
          prompts: {
            requested: promptIds.length,
            already_active: alreadyActive.length,
            free: quote.free.length,
            charged: quote.charged.length,
          },
          credits_charged: 0 as const,
        };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        incrementCounter("nominara_prompts_activation_previews_total", { outcome: "refused" });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /** `confirmed` is the raw `X-Nominara-Confirmed-Credits` header: required, and compared, only when the charge is above 0. */
  async activate(
    projectId: string,
    request: ActivatePromptsRequest,
    confirmed?: string | readonly string[],
  ): Promise<ActivatePromptsResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptActivationService.activate requires an active tenant context");
    const client = store.client as TenantClient;

    const promptIds = this.canonicalIds(request);
    // Parsed up front so a malformed header is a 400 before any row is read; whether one is REQUIRED is decided later,
    // from the recomputed charge.
    const confirmedCredits = parseConfirmedCredits(confirmed);

    await this.assertProjectExists(client, projectId);

    const resolved = await this.entitlements.resolveForWorkspace(store.context.workspaceId);
    const cap = this.capFrom(resolved.entitlements);
    const activeBefore = await this.countOccupyingSlots(client, projectId);
    const prompts = await this.loadPrompts(client, projectId, promptIds);

    // Already-active prompts are counted against NEITHER the cap nor the
    // charge. This is what makes a replay at the cap succeed: counting them
    // as newly activated would make the retry of a successful call fail with
    // a 403, the worst possible behaviour for an endpoint AC12 requires to be
    // idempotent.
    let credits = 0;
    const alreadyActive = prompts.filter((prompt) => prompt.status === "active");
    const toActivate = prompts.filter((prompt) => prompt.status !== "active");

    // Only rows leaving `archived` take a NEW slot: a paused row already
    // occupies one (`PROMPT_OCCUPIES_SLOT`), so counting it again refused a
    // resume PATCH allows (STORY-077: the two doors apply one rule).
    // `activeBefore` can already exceed `cap` after a plan downgrade — the
    // error-details schema's own comment says so. `>` rather than arithmetic
    // on a possibly-negative remainder, so that case refuses cleanly instead
    // of letting a request through on a negative.
    const takingSlots = toActivate.filter((prompt) => prompt.status === "archived").length;
    if (takingSlots > 0 && activeBefore + takingSlots > cap) {
      throw new EntitlementExceededError({
        message: `this plan allows ${String(cap)} active prompts per project`,
        details: { key: "prompts.max_per_project", limit: cap, current: activeBefore },
        // §2 commits to exactly ONE remediation, so this is it rather than an
        // invented array. §10's dialog also offers "Free up slots", which
        // needs no server hint — it is archiving something the customer can
        // already see.
        remediation: { kind: "increase_limit", url: "/settings/billing" },
      });
    }

    // STORY-077 — and every row becoming `active` must fit the ACTIVE count, per project and workspace-wide
    // (active-limit.ts): a downgrade leaves paused prompts above the cap, and a resume must not undo the cut-over.
    await assertActiveWithinLimits(client, {
      workspaceId: store.context.workspaceId,
      projectId,
      becomingActive: toActivate.length,
      entitlements: resolved.entitlements,
    });

    if (toActivate.length > 0) {
      const autoTopup = autoTopupEnqueuerFor(this.producer);
      // AFTER the cap check and BEFORE any write: a 402 here rolls the whole
      // request back, so nothing is activated that was not paid for.
      credits = await chargeForActivation(store.client as ClientBase, {
        workspaceId: store.context.workspaceId,
        actorId: store.context.actorId,
        projectId,
        // ONLY rows leaving `archived`. `status <> 'active'` also admits a paused row, and PATCH treats a change on
        // a non-archived row as no activation at all; the two doors must price the same prompt the same way.
        candidates: this.firstActivationCandidates(toActivate),
        entitlements: resolved.entitlements,
        confirmedCredits,
        ...(autoTopup === undefined ? {} : { autoTopup }),
      });

      // ONE statement, not one per id. Fifteen round trips inside a
      // transaction to set fifteen rows to the same value, on the request
      // path, for no benefit.
      await client.query(
        `UPDATE tracked_prompts
            SET status = 'active', paused_by_downgrade_at = NULL, updated_at = now()
          WHERE id = ANY($1::uuid[]) AND project_id = $2 AND deleted_at IS NULL`,
        [toActivate.map((prompt) => prompt.id), projectId],
      );

      // AC10 — the count is written in the SAME transaction as the
      // activation, never by a later job. The ambient tenant transaction
      // (tenant-context.interceptor.ts) is that transaction; recomputing
      // from the rows rather than incrementing means the column cannot drift
      // even if a concurrent archive lands between the two statements.
      await client.query(
        `UPDATE projects
            SET prompts_active = (SELECT count(*) FROM tracked_prompts
                                   WHERE project_id = $1 AND ${OCCUPIES_SLOT}),
                prompts_cap = $2,
                updated_at = now()
          WHERE id = $1`,
        [projectId, Math.min(cap, PROMPTS_CAP_COLUMN_MAX)],
      );
    }

    // Slots occupied after this call (`prompts_active` counts `PROMPT_OCCUPIES_SLOT`): a resumed paused row held its slot already.
    const activeAfter = activeBefore + takingSlots;

    // Owner decision 2026-10-09 pm #1: confirming the prompt set is the
    // activation event. Only an `initializing` project moves (a paused or
    // already-active one is left alone), and next_run_at is ALWAYS re-seeded
    // from now — a stale seed from creation time must never become an
    // immediate burst of overdue runs. `manual` stores NULL.
    if (activeAfter > 0) await this.activateProject(client, projectId);
    const coverage = await this.coverageFor(client, projectId);

    return {
      activated_prompt_ids: toActivate.map((prompt) => prompt.id),
      summary: {
        requested: promptIds.length,
        activated: toActivate.length,
        already_active: alreadyActive.length,
        slots_remaining: Math.max(0, cap - activeAfter),
      },
      coverage,
      prompts_active: activeAfter,
      prompts_cap: cap,
      credits_charged: credits,
    };
  }

  private async activateProject(client: TenantClient, projectId: string): Promise<void> {
    const found = await client.query<{ cadence: ProjectCadence }>(
      "SELECT cadence FROM projects WHERE id = $1 AND status = 'initializing' AND deleted_at IS NULL",
      [projectId],
    );
    const cadence = found.rows[0]?.cadence;
    if (cadence === undefined) return;
    // The status guard is repeated in the UPDATE so a concurrent pause or a
    // concurrent confirmation cannot be overwritten.
    await client.query(
      `UPDATE projects SET status = 'active', next_run_at = $2, updated_at = now()
        WHERE id = $1 AND status = 'initializing' AND deleted_at IS NULL`,
      [projectId, nextRunAfter(cadence, new Date())],
    );
  }

  /** The prompts that are LEAVING `archived`: the only ones an activation prices, here and on the PATCH door. */
  private firstActivationCandidates(prompts: readonly PromptRow[]): ActivationCandidate[] {
    return prompts
      .filter((prompt) => prompt.status === "archived")
      .map((prompt) => ({
        id: prompt.id,
        generationSource: prompt.generation_source,
        firstActivatedAt: prompt.first_activated_at,
      }));
  }

  /**
   * ⚠ CANONICALISED BEFORE ANYTHING COMPARES THEM. STORY-150's review found
   * this one live: `prompt_ids` is a BODY field, so `CanonicalParamsGuard`
   * never sees it, and `z.string().uuid()` accepts an uppercase uuid (zod's
   * check is case-insensitive — verified, not assumed). Postgres then
   * matched the row anyway, because `$1::uuid[]` casts — so `loadPrompts`
   * got the row back, `found.get(UPPERCASE)` missed the lowercase key it was
   * stored under, and the caller was told "no such prompt in this project"
   * about a prompt in their own project.
   *
   * It also made the duplicate check below miss `[lower, UPPER]` of one
   * prompt, which is the same id twice. That failed closed at `loadPrompts`
   * instead, so the refusal was right for the wrong reason.
   *
   * ⚠ BODY AND QUERY UUIDS ARE NOT SYSTEMATICALLY HANDLED, and this fixes
   * one instance rather than the class. There are 67 uuid fields across
   * `contracts/`; the boundary for them is a shared schema with a lowercase
   * transform, which changes the generated OpenAPI and belongs in its own
   * story. This one is fixed here because it is live and it is the defect
   * STORY-150 is named for.
   *
   * A DUPLICATE ID IS A REFUSAL, not something to quietly collapse. With
   * one slot left, `[P1, P1]` either passes the cap check as two and
   * activates one, or passes as one and is reported as two — both of which
   * lie in the summary. Refusing names the mistake instead.
   */
  private canonicalIds(request: ActivatePromptsRequest): string[] {
    const promptIds = request.prompt_ids.map((id) => canonicalUuid(id));
    const unique = new Set(promptIds);
    if (unique.size !== promptIds.length) {
      throw new ValidationFailedError({
        message: "prompt_ids contains a duplicate",
        details: { issues: [{ path: ["prompt_ids"], message: "each prompt may appear at most once" }] },
      });
    }
    return promptIds;
  }

  private async assertProjectExists(client: TenantClient, projectId: string, lock = true): Promise<void> {
    // No `workspace_id` predicate: RLS scopes the tenant (`NFR-SEC-01`), and
    // adding one would imply the boundary lives in application code.
    // FOR UPDATE: the lock every decision below depends on. See the header.
    const result = await client.query<{ prompts_cap: number }>(
      `SELECT prompts_cap FROM projects WHERE id = $1 AND deleted_at IS NULL${lock ? " FOR UPDATE" : ""}`,
      [projectId],
    );
    if (result.rows.length === 0) throw new NotFoundError({ message: "no such project" });
  }

  /**
   * The cap, from the ENTITLEMENT rather than from `projects.prompts_cap`.
   *
   * The column is a creation-time snapshot; the entitlement is the authority
   * and moves with the plan. Reading the column would mean an upgrade did not
   * raise the cap until the project was recreated.
   *
   * The column is refreshed alongside the activation above, so the two cannot
   * be seen to disagree — the project list renders `prompts_cap`, and a
   * customer told 40 there and 100 here would be right to distrust both.
   *
   * Resolved per WORKSPACE. `prompts.max_per_project` is a per-project limit
   * held as a workspace entitlement — `structural-usage.ts` scopes its
   * COUNTER to the project while the limit itself is the same for every
   * project in the workspace.
   */
  private capFrom(entitlements: Readonly<Record<string, { readonly value: unknown } | undefined>>): number {
    const value = entitlements["prompts.max_per_project"]?.value;
    if (value === undefined) return 0;
    const limit = structuralLimitFrom(value as EntitlementValue);
    if (limit === undefined) return 0;
    return limit.kind === "unlimited" ? PROMPTS_CAP_COLUMN_MAX : limit.limit;
  }

  /** Counted with `PROMPT_OCCUPIES_SLOT` verbatim, so pause frees nothing and archive frees a slot. */
  private async countOccupyingSlots(client: TenantClient, projectId: string): Promise<number> {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tracked_prompts WHERE project_id = $1 AND ${OCCUPIES_SLOT}`,
      [projectId],
    );
    return result.rows[0]?.n ?? 0;
  }

  /**
   * Loads the named prompts, refusing any that is not this project's.
   *
   * RLS scopes the TENANT, not the project, and this route's path names a
   * project — so a sibling project's prompt id in the same workspace would
   * otherwise be activated against the wrong project's cap. The ids that
   * failed are named, because "one of your eight ids is wrong" is not
   * actionable.
   */
  private async loadPrompts(client: TenantClient, projectId: string, promptIds: readonly string[]): Promise<PromptRow[]> {
    const result = await client.query<PromptRow>(
      `SELECT id, status, project_id, generation_source, first_activated_at, superseded_by FROM tracked_prompts WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [[...promptIds]],
    );

    const found = new Map(result.rows.map((row) => [row.id, row]));
    const unusable = promptIds.filter((id) => {
      const row = found.get(id);
      return row === undefined || row.project_id !== projectId;
    });

    if (unusable.length > 0) {
      throw new ValidationFailedError({
        message: "one or more prompt_ids does not name a prompt in this project",
        details: { issues: unusable.map((id) => ({ path: ["prompt_ids"], message: `no such prompt in this project: ${id}` })) },
      });
    }

    // A SUPERSEDED row is history, not a live prompt. The free-allowance count reads chain heads only, so activating
    // a row that is no longer a head would spend a free slot that is never counted - the allowance would be
    // recyclable by rewording and then activating the old row. Refused as a whole, before anything is charged.
    const superseded = promptIds.map((id) => found.get(id)!).filter((row) => typeof row.superseded_by === "string");
    if (superseded.length > 0) {
      throw new ConflictError({
        message: `prompt ${superseded[0]!.id} was reworded and replaced by ${superseded[0]!.superseded_by!}; activate the replacement`,
        details: { reason: "prompt_superseded" },
      });
    }

    return promptIds.map((id) => found.get(id)!);
  }

  /**
   * `FR-CRD-08` — "The coverage chip shows activated / generated, so a capped
   * project never appears to have full coverage."
   *
   * OVER GENERATED PROMPTS ONLY. A manually typed prompt was never
   * "generated", so counting it would let a customer raise their apparent
   * coverage by typing prompts — which is the opposite of what the
   * requirement is for. Project-wide rather than per-batch, because the chip
   * describes the project's prompt set.
   */
  private async coverageFor(client: TenantClient, projectId: string): Promise<{ activated: number; generated: number }> {
    const result = await client.query<{ generated: number; activated: number }>(
      `SELECT count(*)::int AS generated,
              count(*) FILTER (WHERE status = 'active')::int AS activated
         FROM tracked_prompts
        WHERE project_id = $1 AND generation_source = 'generated' AND deleted_at IS NULL`,
      [projectId],
    );
    return { generated: result.rows[0]?.generated ?? 0, activated: result.rows[0]?.activated ?? 0 };
  }
}

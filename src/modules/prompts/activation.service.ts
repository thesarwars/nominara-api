import { Injectable } from "@nestjs/common";
import type { ActivatePromptsRequest, ActivatePromptsResponse } from "../../../contracts/prompts/index.js";
import { EntitlementExceededError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

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
// customer's chosen prompts to drop, and once activation charges (blocked;
// see the story) it would be a partial debit for an outcome nobody asked
// for. The refusal therefore happens before any UPDATE.
//
// NOTHING IS CHARGED. `credits_charged` is the literal 0 in the contract and
// there is no wallet, ledger or reserve statement anywhere in this file —
// which is what makes that true by construction rather than by a test that
// happens to pass. §4 prices activation at "1 per prompt activated" beyond
// the free 10 and nothing can charge yet: `CreditGuard` is a pass-through
// no-op whose own comment puts reserve/commit in EPIC-10, wallets are
// unprovisioned, and §4 contradicts §10's `FR-CRD-06` about whether
// activating an archived candidate later costs anything at all.

/** `PROMPT_OCCUPIES_SLOT`, verbatim from src/lib/entitlements/structural-usage.ts. */
const OCCUPIES_SLOT = "status <> 'archived' AND deleted_at IS NULL";

/** `projects.prompts_cap` is `smallint`; an unlimited entitlement is clamped to its ceiling. */
const PROMPTS_CAP_COLUMN_MAX = 32_767;

interface PromptRow {
  id: string;
  status: string;
  project_id: string;
}

type TenantClient = { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> };

@Injectable()
export class PromptActivationService {
  constructor(private readonly entitlements: EntitlementResolver) {}

  async activate(projectId: string, request: ActivatePromptsRequest): Promise<ActivatePromptsResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptActivationService.activate requires an active tenant context");
    const client = store.client as TenantClient;

    // A DUPLICATE ID IS A REFUSAL, not something to quietly collapse. With
    // one slot left, `[P1, P1]` either passes the cap check as two and
    // activates one, or passes as one and is reported as two — both of which
    // lie in the summary. Refusing names the mistake instead.
    const unique = new Set(request.prompt_ids);
    if (unique.size !== request.prompt_ids.length) {
      throw new ValidationFailedError({
        message: "prompt_ids contains a duplicate",
        details: { issues: [{ path: ["prompt_ids"], message: "each prompt may appear at most once" }] },
      });
    }

    await this.assertProjectExists(client, projectId);

    const cap = await this.resolveCap(store.context.workspaceId);
    const activeBefore = await this.countOccupyingSlots(client, projectId);
    const prompts = await this.loadPrompts(client, projectId, request.prompt_ids);

    // Already-active prompts are counted against NEITHER the cap nor the
    // charge. This is what makes a replay at the cap succeed: counting them
    // as newly activated would make the retry of a successful call fail with
    // a 403, the worst possible behaviour for an endpoint AC12 requires to be
    // idempotent.
    const alreadyActive = prompts.filter((prompt) => prompt.status === "active");
    const toActivate = prompts.filter((prompt) => prompt.status !== "active");

    // `activeBefore` can already exceed `cap` after a plan downgrade — the
    // error-details schema's own comment says so. `>` rather than arithmetic
    // on a possibly-negative remainder, so that case refuses cleanly instead
    // of letting a request through on a negative.
    if (activeBefore + toActivate.length > cap) {
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

    if (toActivate.length > 0) {
      // ONE statement, not one per id. Fifteen round trips inside a
      // transaction to set fifteen rows to the same value, on the request
      // path, for no benefit.
      await client.query(
        `UPDATE tracked_prompts
            SET status = 'active', updated_at = now()
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

    const activeAfter = activeBefore + toActivate.length;
    const coverage = await this.coverageFor(client, projectId);

    return {
      activated_prompt_ids: toActivate.map((prompt) => prompt.id),
      summary: {
        requested: request.prompt_ids.length,
        activated: toActivate.length,
        already_active: alreadyActive.length,
        slots_remaining: Math.max(0, cap - activeAfter),
      },
      coverage,
      prompts_active: activeAfter,
      prompts_cap: cap,
      credits_charged: 0,
    };
  }

  private async assertProjectExists(client: TenantClient, projectId: string): Promise<void> {
    // No `workspace_id` predicate: RLS scopes the tenant (`NFR-SEC-01`), and
    // adding one would imply the boundary lives in application code.
    const result = await client.query<{ prompts_cap: number }>(
      "SELECT prompts_cap FROM projects WHERE id = $1 AND deleted_at IS NULL",
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
  private async resolveCap(workspaceId: string): Promise<number> {
    const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
    const value = resolved.entitlements["prompts.max_per_project"]?.value;
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
      `SELECT id, status, project_id FROM tracked_prompts WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
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

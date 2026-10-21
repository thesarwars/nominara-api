import type { ClientBase } from "pg";
import { DegradedError, EntitlementExceededError } from "../../api/errors/domain-errors.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";

// STORY-077 (review round 1, blocker) — THE ONE RULE BOTH DOORS INTO `active` APPLY.
//
// `PROMPT_OCCUPIES_SLOT` counts `paused` like `active`, so in a workspace within its limits a paused prompt resuming
// takes nothing it does not already hold, and the old checks treated paused -> active as free. A downgrade breaks that
// premise: the cut-over leaves a workspace holding MORE prompts than its cap, the excess paused (§14; planner open
// question 1, option a: paused rows keep occupying). Treating the resume as free let one PATCH per prompt undo the
// cut-over. So a move INTO `active` must also fit the ACTIVE count under the resolved limits:
//   * `prompts.max_per_project` — active prompts in that project;
//   * `prompts.max_total` — active prompts in the workspace.
// In a workspace within its limits this never refuses anything the slot check allowed (active <= occupying <= cap), so
// the rule only binds where the occupancy premise is already broken. It applies to EVERY paused prompt, not only a
// downgrade-paused one: a person's own pause in an over-limit workspace is the same hole.

// ⚠ THE COUNT IS WORKSPACE-WIDE, SO THE LOCK MUST BE TOO (review round 2). Both doors lock only the PROJECT row, so
// two resumes in DIFFERENT projects each read the same workspace count, both pass `prompts.max_total`, and the
// workspace ends above its cap - the cut-over undone. `lockWorkspaceForActivation` takes the workspace row lock, the
// same bounded one every billing writer takes, BEFORE the project lock: the order the Stripe webhook and plan:set use
// (workspace, then projects, then prompts), so it adds no inversion. It also serialises a resume against the cut-over
// itself. Every caller of `assertActiveWithinLimits` must hold it.

/**
 * Takes the workspace row lock (bounded: `WORKSPACE_LOCK_WAIT_MS`) before a move INTO `active`. Call it before the
 * project row lock. A wait past the bound - a billing holder inside a Stripe call - is a retryable 503, never a queue.
 */
export async function lockWorkspaceForActivation(client: ClientBase, workspaceId: string): Promise<void> {
  await lockWorkspaceBounded(client, workspaceId, () => {
    incrementCounter("nominara_workspace_lock_wait_exceeded_total", { path: "prompt_activation" });
    return new DegradedError({ message: "the workspace is being changed: retry shortly" });
  });
}

/** A prompt that is tracked right now. */
export const PROMPT_IS_ACTIVE = "status = 'active' AND deleted_at IS NULL";

type Client = { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> };
type Entitlements = Readonly<Record<string, { readonly value: unknown } | undefined>>;

/** null = unlimited. Read exactly as the guards read a structural limit. */
function limitOf(entitlements: Entitlements, key: string): number | null {
  const value = entitlements[key]?.value;
  if (value === undefined) return 0;
  const limit = structuralLimitFrom(value as EntitlementValue);
  if (limit === undefined) return 0;
  return limit.kind === "unlimited" ? null : limit.limit;
}

/**
 * Refuses (403 `entitlement_exceeded`, naming the key) when `becomingActive` more prompts in `projectId` would take
 * the project's or the workspace's ACTIVE count above its resolved limit. A no-op for 0. The caller holds the workspace
 * lock (`lockWorkspaceForActivation`), or two concurrent calls can both pass.
 */
export async function assertActiveWithinLimits(
  client: Client,
  input: { readonly workspaceId: string; readonly projectId: string; readonly becomingActive: number; readonly entitlements: Entitlements },
): Promise<void> {
  if (input.becomingActive <= 0) return;
  const counts = await client.query<{ project: number; workspace: number }>(
    `SELECT count(*) FILTER (WHERE project_id = $2)::int AS project, count(*)::int AS workspace
       FROM tracked_prompts WHERE workspace_id = $1 AND ${PROMPT_IS_ACTIVE}`,
    [input.workspaceId, input.projectId],
  );
  const current = counts.rows[0] ?? { project: 0, workspace: 0 };

  const perProject = limitOf(input.entitlements, "prompts.max_per_project");
  if (perProject !== null && current.project + input.becomingActive > perProject) {
    throw new EntitlementExceededError({
      message: `this plan allows ${String(perProject)} active prompts per project`,
      details: { key: "prompts.max_per_project", limit: perProject, current: current.project },
      remediation: { kind: "increase_limit", url: "/settings/billing" },
    });
  }
  const total = limitOf(input.entitlements, "prompts.max_total");
  if (total !== null && current.workspace + input.becomingActive > total) {
    throw new EntitlementExceededError({
      message: `this plan allows ${String(total)} active prompts in the workspace`,
      details: { key: "prompts.max_total", limit: total, current: current.workspace },
      remediation: { kind: "increase_limit", url: "/settings/billing" },
    });
  }
}

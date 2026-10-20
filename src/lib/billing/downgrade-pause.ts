import type { ClientBase } from "pg";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { structuralLimitFrom } from "../entitlements/classification.js";
import { resolveEntitlements } from "../entitlements/resolution.js";
import { PROMPT_OCCUPIES_SLOT } from "../entitlements/structural-usage.js";

// STORY-077 slice A — plans-and-entitlements.md §14 at the cut-over.
//
//   "If the choice is not made by the cut-over, the system pauses — never deletes — the most recently created excess
//    projects and prompts, retains all their data under the new retention tier, and emails the list."
//   STORY-077 AC5: "Paused-by-downgrade items are distinguishable from user-paused ones, and resume automatically on a
//    later upgrade."
//
// ⚠ ONE RULE FOR BOTH DIRECTIONS. Given the workspace's RESOLVED limits (plan + surviving add-ons + overrides, the
// guards' own `resolveEntitlements`), the EXCESS is the newest N rows by (created_at, id) — exactly what the preview
// names (downgrade-excess.ts orders projects the same way). Then:
//   * an `active`/`initializing` row in the excess is paused and MARKED (`paused_by_downgrade_at`);
//   * a MARKED row no longer in the excess is resumed and unmarked.
// So a downgrade pauses the newest, a partial upgrade resumes the oldest-paused first up to the new limit (the inverse
// of the pause order), a full upgrade resumes everything, and a second delivery of the same state is a fixed point.
//
// ⚠ A PERSON'S PAUSE IS NEVER OURS. A row a person paused carries no marker: it is never marked (not taken over), and
// never resumed by billing. It still OCCUPIES its slot (PROMPT_OCCUPIES_SLOT counts paused prompts; every live project
// counts), so it is in the counts and the excess like any other row — the cap is not bypassed by pausing.
//
// ⚠ COUNTS ARE NOT CHANGED BY A DOWNGRADE PAUSE (planner open question 1, option a): a paused row still occupies its
// slot, so the workspace stays over its ceiling and the guards refuse the NEXT creation until the customer deletes or
// upgrades. The pause stops tracking (the scheduler only claims `status = 'active'` projects) and keeps every row.

export interface PauseLimits {
  /** `projects.max`; null = unlimited. */
  readonly projects: number | null;
  /** `prompts.max_total`; null = unlimited. */
  readonly promptsTotal: number | null;
  /** `prompts.max_per_project`; null = unlimited. */
  readonly promptsPerProject: number | null;
}

export interface PauseProject {
  readonly id: string;
  readonly createdAt: Date;
  readonly status: "initializing" | "active" | "paused" | "archived";
  readonly pausedByDowngrade: boolean;
}

/** A prompt that OCCUPIES a slot (PROMPT_OCCUPIES_SLOT): never an archived one. */
export interface PausePrompt {
  readonly id: string;
  readonly projectId: string;
  readonly createdAt: Date;
  readonly status: "active" | "paused";
  readonly pausedByDowngrade: boolean;
}

export interface DowngradePausePlan {
  /** Newest first. */
  readonly pauseProjects: string[];
  /** Oldest first. */
  readonly resumeProjects: string[];
  /** Newest first. */
  readonly pausePrompts: string[];
  /** Oldest first. */
  readonly resumePrompts: string[];
}

/** The same reading the guards and the preview use: a number is a ceiling, `null`/`false` is 0, "uncapped"/"custom"/… unlimited. */
function limitOf(value: EntitlementValue | undefined): number | null {
  const limit = structuralLimitFrom(value ?? null);
  return limit === undefined || limit.kind === "unlimited" ? null : limit.limit;
}

export function pauseLimitsFrom(entitlements: Readonly<Record<string, { readonly value: EntitlementValue }>>): PauseLimits {
  return {
    projects: limitOf(entitlements["projects.max"]?.value),
    promptsTotal: limitOf(entitlements["prompts.max_total"]?.value),
    promptsPerProject: limitOf(entitlements["prompts.max_per_project"]?.value),
  };
}

/** Newest first: created_at descending, then id descending — the order the preview names the excess in. */
function newestFirst<T extends { readonly id: string; readonly createdAt: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** The newest `count - limit` of `rows` (all of them for a limit of 0; none when unlimited or within it). */
function excessOf<T extends { readonly id: string; readonly createdAt: Date }>(rows: readonly T[], limit: number | null): T[] {
  if (limit === null || rows.length <= limit) return [];
  return newestFirst(rows).slice(0, rows.length - limit);
}

/** Pure: what the cut-over (or a later upgrade) must pause and resume. */
export function planDowngradePause(limits: PauseLimits, projects: readonly PauseProject[], prompts: readonly PausePrompt[]): DowngradePausePlan {
  const live = projects.filter((p) => p.status !== "archived");
  const excessProjects = new Set(excessOf(live, limits.projects).map((p) => p.id));

  const excessPrompts = new Set<string>();
  for (const prompt of excessOf(prompts, limits.promptsTotal)) excessPrompts.add(prompt.id);
  const byProject = new Map<string, PausePrompt[]>();
  for (const prompt of prompts) {
    const list = byProject.get(prompt.projectId);
    if (list === undefined) byProject.set(prompt.projectId, [prompt]);
    else list.push(prompt);
  }
  for (const list of byProject.values()) for (const prompt of excessOf(list, limits.promptsPerProject)) excessPrompts.add(prompt.id);

  const ordered = newestFirst(live);
  const orderedPrompts = newestFirst(prompts);
  return {
    pauseProjects: ordered.filter((p) => excessProjects.has(p.id) && (p.status === "active" || p.status === "initializing")).map((p) => p.id),
    resumeProjects: ordered.filter((p) => p.pausedByDowngrade && !excessProjects.has(p.id)).map((p) => p.id).reverse(),
    pausePrompts: orderedPrompts.filter((p) => excessPrompts.has(p.id) && p.status === "active").map((p) => p.id),
    resumePrompts: orderedPrompts.filter((p) => p.pausedByDowngrade && !excessPrompts.has(p.id)).map((p) => p.id).reverse(),
  };
}

export interface DowngradePauseOutcome {
  readonly paused: { readonly projects: ReadonlyArray<{ id: string; name: string }>; readonly prompts: ReadonlyArray<{ id: string; projectName: string; text: string }> };
  readonly resumed: { readonly projects: ReadonlyArray<{ id: string; name: string }>; readonly prompts: number };
}

/**
 * Applies `planDowngradePause` to the workspace inside the CALLER's tenant-context transaction (the webhook's, after
 * the plan and add-ons were adopted). Every write is conditional on the state it was planned from, so a concurrent
 * change by a person is never overwritten. Nothing is deleted.
 */
export async function reconcileDowngradePause(tx: ClientBase, workspaceId: string): Promise<DowngradePauseOutcome> {
  const resolved = await resolveEntitlements(tx, workspaceId);
  const limits = pauseLimitsFrom(resolved.entitlements);

  const projectRows = await tx.query<{ id: string; name: string; created_at: Date; status: PauseProject["status"]; paused_by_downgrade_at: Date | null }>(
    "SELECT id, name, created_at, status, paused_by_downgrade_at FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL FOR UPDATE",
    [workspaceId],
  );
  const promptRows = await tx.query<{ id: string; project_id: string; text: string; created_at: Date; status: "active" | "paused"; paused_by_downgrade_at: Date | null }>(
    `SELECT id, project_id, text, created_at, status, paused_by_downgrade_at FROM tracked_prompts
      WHERE workspace_id = $1 AND ${PROMPT_OCCUPIES_SLOT} FOR UPDATE`,
    [workspaceId],
  );

  const plan = planDowngradePause(
    limits,
    projectRows.rows.map((r) => ({ id: r.id, createdAt: r.created_at, status: r.status, pausedByDowngrade: r.paused_by_downgrade_at !== null })),
    promptRows.rows.map((r) => ({ id: r.id, projectId: r.project_id, createdAt: r.created_at, status: r.status, pausedByDowngrade: r.paused_by_downgrade_at !== null })),
  );

  const nameOf = new Map(projectRows.rows.map((r) => [r.id, r.name]));
  const promptById = new Map(promptRows.rows.map((r) => [r.id, r]));

  if (plan.pauseProjects.length > 0) {
    await tx.query(
      `UPDATE projects SET paused_by_downgrade_from = status, status = 'paused', paused_by_downgrade_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status IN ('active', 'initializing') AND paused_by_downgrade_at IS NULL AND deleted_at IS NULL`,
      [plan.pauseProjects],
    );
  }
  if (plan.resumeProjects.length > 0) {
    await tx.query(
      `UPDATE projects SET status = paused_by_downgrade_from, paused_by_downgrade_at = NULL, paused_by_downgrade_from = NULL, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'paused' AND paused_by_downgrade_at IS NOT NULL AND deleted_at IS NULL`,
      [plan.resumeProjects],
    );
  }
  if (plan.pausePrompts.length > 0) {
    await tx.query(
      `UPDATE tracked_prompts SET status = 'paused', paused_by_downgrade_at = now(), updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL`,
      [plan.pausePrompts],
    );
  }
  if (plan.resumePrompts.length > 0) {
    await tx.query(
      `UPDATE tracked_prompts SET status = 'active', paused_by_downgrade_at = NULL, updated_at = now()
        WHERE id = ANY($1::uuid[]) AND status = 'paused' AND paused_by_downgrade_at IS NOT NULL AND deleted_at IS NULL`,
      [plan.resumePrompts],
    );
  }
  // `projects.prompts_active` counts slot-occupying prompts (activation.service: OCCUPIES_SLOT), and a pause does not
  // release a slot, so it does not move.

  return {
    paused: {
      projects: plan.pauseProjects.map((id) => ({ id, name: nameOf.get(id) ?? "" })),
      prompts: plan.pausePrompts.map((id) => {
        const row = promptById.get(id)!;
        return { id, projectName: nameOf.get(row.project_id) ?? "", text: row.text };
      }),
    },
    resumed: { projects: plan.resumeProjects.map((id) => ({ id, name: nameOf.get(id) ?? "" })), prompts: plan.resumePrompts.length },
  };
}

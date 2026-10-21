import type { ClientBase } from "pg";
import { MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
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
// guards' own `resolveEntitlements`), `planDowngradePause` works out the state the limits allow, and pauses or resumes
// only what differs: a downgrade pauses the newest, a partial upgrade resumes the oldest-paused first up to the new
// limit, a full upgrade resumes everything, and a second delivery of the same state is a fixed point.
//
// ⚠ PROJECTS are counted as the guard and the preview count them (every non-deleted project, archived included), so
// the paused projects are the ones the confirmation named.
//
// ⚠ PROMPTS are reconciled on the ACTIVE count (review round 2), the count the resume guard (active-limit.ts) holds a
// person to. The customer is left tracking exactly what the plan allows, never fewer: a paused project takes its
// prompts with it, the per-project excess counts toward the workspace excess, and a prompt a person paused or resumed
// is theirs. A reconcile that lowers no limit pauses nothing.
//
// ⚠ A PERSON'S PAUSE IS NEVER OURS. A row a person paused carries no marker: it is never marked (not taken over) and
// never resumed by billing.
//
// ⚠ SLOT COUNTS ARE NOT CHANGED BY A DOWNGRADE PAUSE (planner open question 1, option a): a paused row still occupies
// its slot, so the creation guards refuse the NEXT creation until the customer deletes or upgrades. The pause stops
// tracking (the scheduler only claims `status = 'active'` projects) and keeps every row.

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
  /** `created_at` as a microsecond UTC key (`MICROS_FORMAT`): sorts lexicographically in creation order, as the SQL does. */
  readonly createdKey: string;
  readonly status: "initializing" | "active" | "paused" | "archived";
  readonly pausedByDowngrade: boolean;
}

/** A prompt that OCCUPIES a slot (PROMPT_OCCUPIES_SLOT): never an archived one. */
export interface PausePrompt {
  readonly id: string;
  readonly projectId: string;
  /** As `PauseProject.createdKey`. */
  readonly createdKey: string;
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

/**
 * Newest first: created_at descending, then id descending — the order the preview names the excess in (SQL `ORDER BY
 * created_at DESC, id DESC`). Compared on the MICROSECOND key, never a JS Date: a Date keeps milliseconds, so two rows in
 * the same millisecond would fall back to id here while the preview's SQL still tells them apart.
 */
function newestFirst<T extends { readonly id: string; readonly createdKey: string }>(rows: readonly T[]): T[] {
  const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  return [...rows].sort((a, b) => desc(a.createdKey, b.createdKey) || desc(a.id, b.id));
}

/** The newest `count - limit` of `rows` (all of them for a limit of 0; none when unlimited or within it). */
function excessOf<T extends { readonly id: string; readonly createdKey: string }>(rows: readonly T[], limit: number | null): T[] {
  if (limit === null || rows.length <= limit) return [];
  return newestFirst(rows).slice(0, rows.length - limit);
}

/** Oldest first: the inverse of `newestFirst`. */
function oldestFirst<T extends { readonly id: string; readonly createdKey: string }>(rows: readonly T[]): T[] {
  return newestFirst(rows).reverse();
}

/**
 * Pure: what the cut-over (or a later upgrade) must pause and resume.
 *
 * PROJECTS: the excess is the newest N of every non-deleted project (the guard's and the preview's count). An
 * active/initializing project in it is paused and marked; a marked project out of it is resumed.
 *
 * PROMPTS (review round 2): the target is the ACTIVE count, never the slot count, so the customer is left tracking
 * exactly what the new limits allow - never fewer:
 *   1. a project the downgrade pauses (or keeps paused) takes its active prompts with it: nothing tracks them, so they
 *      must not hold the workspace's active room;
 *   2. per project: pause the newest (active - per-project limit) active prompts; with room, resume the oldest marked;
 *   3. workspace-wide, over what step 2 left active: pause (active - total) more, taken first from projects nothing
 *      tracks (person-paused, archived), newest first; with room, resume marked prompts oldest first, tracked projects
 *      first.
 * A person's pause is never marked and never resumed, and it does not count (it is not active). A reconcile that lowers
 * no limit finds the active count already within it and pauses nothing - so a prompt a person resumed stays resumed.
 */
export function planDowngradePause(limits: PauseLimits, projects: readonly PauseProject[], prompts: readonly PausePrompt[]): DowngradePausePlan {
  const excessProjects = new Set(excessOf(projects, limits.projects).map((p) => p.id));
  const ordered = newestFirst(projects);
  const pauseProjects = ordered.filter((p) => excessProjects.has(p.id) && !p.pausedByDowngrade && (p.status === "active" || p.status === "initializing")).map((p) => p.id);
  const resumeProjects = ordered.filter((p) => p.pausedByDowngrade && !excessProjects.has(p.id)).map((p) => p.id).reverse();

  // Each project's state once the plan above is applied.
  const stateOf = new Map<string, "downgrade_paused" | "tracking" | "untracked">();
  for (const p of projects) {
    if (p.pausedByDowngrade) stateOf.set(p.id, excessProjects.has(p.id) ? "downgrade_paused" : "tracking");
    else if (p.status === "active" || p.status === "initializing") stateOf.set(p.id, excessProjects.has(p.id) ? "downgrade_paused" : "tracking");
    else stateOf.set(p.id, "untracked");
  }

  const pause = new Set<string>();
  const resume = new Set<string>();
  const byProject = new Map<string, PausePrompt[]>();
  for (const prompt of prompts) {
    if (stateOf.get(prompt.projectId) === "downgrade_paused") {
      // 1. Paused with its project; a marked or person-paused prompt there stays as it is.
      if (prompt.status === "active") pause.add(prompt.id);
      continue;
    }
    const list = byProject.get(prompt.projectId);
    if (list === undefined) byProject.set(prompt.projectId, [prompt]);
    else list.push(prompt);
  }

  // 2. Per project, on the active count.
  const stillActive: PausePrompt[] = [];
  const resumable: PausePrompt[] = [];
  for (const list of byProject.values()) {
    const active = list.filter((p) => p.status === "active");
    const marked = list.filter((p) => p.status === "paused" && p.pausedByDowngrade);
    const over = excessOf(active, limits.promptsPerProject);
    for (const p of over) pause.add(p.id);
    stillActive.push(...active.filter((p) => !pause.has(p.id)));
    if (over.length === 0) {
      const room = limits.promptsPerProject === null ? marked.length : limits.promptsPerProject - active.length;
      resumable.push(...oldestFirst(marked).slice(0, Math.max(0, room)));
    }
  }

  // 3. Workspace-wide, over what step 2 left active.
  const total = limits.promptsTotal;
  if (total !== null && stillActive.length > total) {
    const untracked = newestFirst(stillActive.filter((p) => stateOf.get(p.projectId) === "untracked"));
    const tracked = newestFirst(stillActive.filter((p) => stateOf.get(p.projectId) !== "untracked"));
    for (const p of [...untracked, ...tracked].slice(0, stillActive.length - total)) pause.add(p.id);
  } else {
    const room = total === null ? resumable.length : total - stillActive.length;
    const tracked = oldestFirst(resumable.filter((p) => stateOf.get(p.projectId) !== "untracked"));
    const untracked = oldestFirst(resumable.filter((p) => stateOf.get(p.projectId) === "untracked"));
    for (const p of [...tracked, ...untracked].slice(0, room)) resume.add(p.id);
  }

  const orderedPrompts = newestFirst(prompts);
  return {
    pauseProjects,
    resumeProjects,
    pausePrompts: orderedPrompts.filter((p) => pause.has(p.id)).map((p) => p.id),
    resumePrompts: orderedPrompts.filter((p) => resume.has(p.id)).map((p) => p.id).reverse(),
  };
}

export interface DowngradePauseOutcome {
  readonly paused: {
    readonly projects: ReadonlyArray<{ id: string; name: string }>;
    /** `withProject`: paused because its project was paused in the same step (the email names the project, not each prompt). */
    readonly prompts: ReadonlyArray<{ id: string; projectName: string; text: string; withProject: boolean }>;
  };
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

  const projectRows = await tx.query<{ id: string; name: string; created_key: string; status: PauseProject["status"]; paused_by_downgrade_at: Date | null }>(
    `SELECT id, name, to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_key, status, paused_by_downgrade_at
       FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [workspaceId],
  );
  const promptRows = await tx.query<{ id: string; project_id: string; text: string; created_key: string; status: "active" | "paused"; paused_by_downgrade_at: Date | null }>(
    `SELECT id, project_id, text, to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_key, status, paused_by_downgrade_at FROM tracked_prompts
      WHERE workspace_id = $1 AND ${PROMPT_OCCUPIES_SLOT} FOR UPDATE`,
    [workspaceId],
  );

  const plan = planDowngradePause(
    limits,
    projectRows.rows.map((r) => ({ id: r.id, createdKey: r.created_key, status: r.status, pausedByDowngrade: r.paused_by_downgrade_at !== null })),
    promptRows.rows.map((r) => ({ id: r.id, projectId: r.project_id, createdKey: r.created_key, status: r.status, pausedByDowngrade: r.paused_by_downgrade_at !== null })),
  );

  const nameOf = new Map(projectRows.rows.map((r) => [r.id, r.name]));
  const pausedProjects = new Set(plan.pauseProjects);
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
        return { id, projectName: nameOf.get(row.project_id) ?? "", text: row.text, withProject: pausedProjects.has(row.project_id) };
      }),
    },
    resumed: { projects: plan.resumeProjects.map((id) => ({ id, name: nameOf.get(id) ?? "" })), prompts: plan.resumePrompts.length },
  };
}

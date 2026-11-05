import type { ClientBase } from "pg";
import { cancelTaskVerifications } from "../impact/verification-schedule.js";
import { MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { structuralLimitFrom } from "../entitlements/classification.js";
import { resolveEntitlements } from "../entitlements/resolution.js";
import { PROMPT_OCCUPIES_SLOT } from "../entitlements/structural-usage.js";
import { answeredStatusSql } from "../rollup/aggregate-day.js";

// STORY-077 slice A — plans-and-entitlements.md §14 at the cut-over.
//
//   "If the choice is not made by the cut-over, the system pauses — never deletes — the most recently created excess
//    projects and prompts, retains all their data under the new retention tier, and emails the list."
//   STORY-077 AC5: "Paused-by-downgrade items are distinguishable from user-paused ones, and resume automatically on a
//    later upgrade."
//
// ⚠ ONE RULE FOR BOTH DIRECTIONS. Given the workspace's RESOLVED limits (plan + surviving add-ons + overrides, the
// guards' own `resolveEntitlements`), `planDowngradePause` works out the state the limits allow, and pauses or resumes
// only what differs: a downgrade pauses the end of `keepOrder`, a partial upgrade resumes from its start up to the new
// limit, a full upgrade resumes everything, and a second delivery of the same state is a fixed point.
//
// ⚠ WHICH ROWS (STORY-077 D2, owner decision 2026-10-20): the default KEEPS THE MOST RECENTLY ACTIVE, replacing slice A's
// "pause the most recently created". One ordering, `keepOrder`, decides every direction: a pause takes the END of it, a
// resume the START. It ranks: a row the customer chose to keep (`KeepChoice`, PUT /billing/subscription/change/keep),
// then rows not paused by a downgrade, then downgrade-paused rows; within each, the latest activity first (a project's
// latest finished capture run, a prompt's latest answer capture; none ranks last), then the OLDER row first (slice A's
// rule, so with no activity anywhere nothing changes), then id. Downgrade-paused rows rank after the rest so a later
// reconcile never swaps a tracked row for a paused one: their activity stopped when they were paused.
//
// ⚠ PROJECTS (owner decision 2026-10-23, replacing review round 1's "holds its slot"): an ARCHIVED project, or one a
// PERSON paused, USES NO PLAN SLOT (`usesNoSlot`). The planner ranks only the projects billing may pause or resume - the
// tracking ones (active, initializing) and the ones a downgrade paused - so after any plan the TRACKING count is within
// `projects.max`, exactly what the creation guard counts (structural-usage.ts `PROJECT_USES_SLOT`) and the preview
// names. The other half of the rule is project-reactivation.ts: leaving archived or paused needs room, so archiving is
// not a way around the limit.
//
// ⚠ PROMPTS are reconciled on the ACTIVE count (review round 2), the count the resume guard (active-limit.ts) holds a
// person to. The customer is left tracking exactly what the plan allows, never fewer: a paused project takes its
// prompts with it, the per-project excess counts toward the workspace excess, and a prompt a person paused or resumed
// is theirs. A reconcile that lowers no limit pauses nothing.
//
// ⚠ A PERSON'S PAUSE IS NEVER OURS. A row a person paused carries no marker: it is never marked (not taken over) and
// never resumed by billing.
//
// ⚠ A DOWNGRADE PAUSE (planner open question 1, option a) keeps every row. A paused PROMPT still occupies its slot
// (PROMPT_OCCUPIES_SLOT). A paused PROJECT no longer counts (owner 2026-10-23), but the cut-over leaves exactly
// `projects.max` tracking, so the creation guard still refuses the NEXT project until the customer archives, deletes or
// upgrades. The pause stops tracking (the scheduler only claims `status = 'active'` projects).

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
  /** Latest finished capture run (`completed`/`partial`) as the same microsecond key; null or absent: never. */
  readonly activityKey?: string | null;
}

/** A prompt that OCCUPIES a slot (PROMPT_OCCUPIES_SLOT): never an archived one. */
export interface PausePrompt {
  readonly id: string;
  readonly projectId: string;
  /** As `PauseProject.createdKey`. */
  readonly createdKey: string;
  readonly status: "active" | "paused";
  readonly pausedByDowngrade: boolean;
  /** Latest answer capture (`answeredStatusSql`) as the same microsecond key; null or absent: never. */
  readonly activityKey?: string | null;
}

/** The customer's keep choice for the downgrade being adopted (downgrade-keep.ts); kept first, before any default. */
export interface KeepChoice {
  readonly projectIds: ReadonlySet<string>;
  readonly promptIds: ReadonlySet<string>;
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

interface Rankable {
  readonly id: string;
  readonly createdKey: string;
  readonly pausedByDowngrade: boolean;
  readonly activityKey?: string | null;
}

/**
 * The ONE order (see the header): kept first, then not downgrade-paused, then the latest activity (none last), then the
 * older row, then id. Keys are compared as MICROSECOND strings, never a JS Date: a Date keeps milliseconds, so two rows in
 * the same millisecond would fall back to id here while the SQL still tells them apart.
 */
export function keepOrder<T extends Rankable>(rows: readonly T[], kept?: ReadonlySet<string>): T[] {
  const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows].sort((a, b) => {
    if (kept !== undefined) {
      const k = Number(kept.has(b.id)) - Number(kept.has(a.id));
      if (k !== 0) return k;
    }
    if (a.pausedByDowngrade !== b.pausedByDowngrade) return a.pausedByDowngrade ? 1 : -1;
    const [x, y] = [a.activityKey ?? null, b.activityKey ?? null];
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return asc(y, x);
    }
    return asc(a.createdKey, b.createdKey) || asc(a.id, b.id);
  });
}

/**
 * A project that USES NO PLAN SLOT (owner decision 2026-10-23): archived, or paused by a person. Billing never counts,
 * pauses or resumes it; leaving that state needs room under `projects.max` (project-reactivation.ts).
 */
export function usesNoSlot(project: Pick<PauseProject, "status" | "pausedByDowngrade">): boolean {
  return project.status === "archived" || (project.status === "paused" && !project.pausedByDowngrade);
}

/** The order a pause takes rows in: the end of `keepOrder` first. */
function pauseOrder<T extends Rankable>(rows: readonly T[], kept?: ReadonlySet<string>): T[] {
  return keepOrder(rows, kept).reverse();
}

/** The `count - limit` rows at the end of `keepOrder` (all of them for a limit of 0; none when unlimited or within it). */
function excessOf<T extends Rankable>(rows: readonly T[], limit: number | null, kept?: ReadonlySet<string>): T[] {
  if (limit === null || rows.length <= limit) return [];
  return keepOrder(rows, kept).slice(limit);
}

/**
 * Pure: what the cut-over (or a later upgrade) must pause and resume.
 *
 * PROJECTS: the excess is the last N in `keepOrder` of the projects that use a slot or were paused by a downgrade
 * (`usesNoSlot` excludes archived and person-paused ones: owner decision 2026-10-23). An active/initializing project in
 * it is paused and marked; a marked project out of it is resumed.
 *
 * PROMPTS (review round 2): the target is the ACTIVE count, never the slot count, so the customer is left tracking
 * exactly what the new limits allow - never fewer:
 *   1. a project the downgrade pauses (or keeps paused) takes its active prompts with it: nothing tracks them, so they
 *      must not hold the workspace's active room;
 *   2. per project: pause the last (active - per-project limit) active prompts in `keepOrder`; with room, resume the
 *      first marked in it;
 *   3. workspace-wide, over what step 2 left active: pause (active - total) more, taken first from projects nothing
 *      tracks (person-paused, archived), from the end of `keepOrder`; with room, resume marked prompts from its start,
 *      tracked projects first.
 * A person's pause is never marked and never resumed, and it does not count (it is not active). A reconcile that lowers
 * no limit finds the active count already within it and pauses nothing - so a prompt a person resumed stays resumed.
 */
export function planDowngradePause(limits: PauseLimits, projects: readonly PauseProject[], prompts: readonly PausePrompt[], keep?: KeepChoice): DowngradePausePlan {
  const { pausedFor: _reasons, ...plan } = planDowngradePauseWithReasons(limits, projects, prompts, keep);
  return plan;
}

/** Which step of `planDowngradePause` pauses a prompt: with its project (1), the per-project limit (2), the workspace-wide limit (3). */
export type PromptPauseReason = "with_project" | "per_project" | "total";

/**
 * `planDowngradePause`, plus WHY each paused prompt is paused. The preview
 * (downgrade-excess.ts, review round 3) and the keep view (downgrade-keep.service.ts) run this same planner as a dry run,
 * so what they name is the cut-over's own, never a second rule.
 *
 * With a `keep` choice (STORY-077 D2) the chosen rows rank first in `keepOrder`, and per project the chosen prompts are
 * kept before any other, downgrade-paused or not: a chosen paused prompt resumes and an unchosen active one pauses in its
 * place. Room left after the choice is filled by the default order, so the next reconcile (which has no choice) finds
 * nothing to change.
 */
export function planDowngradePauseWithReasons(
  limits: PauseLimits,
  projects: readonly PauseProject[],
  prompts: readonly PausePrompt[],
  keep?: KeepChoice,
): DowngradePausePlan & { readonly pausedFor: ReadonlyMap<string, PromptPauseReason> } {
  const rankedProjects = keepOrder(
    projects.filter((p) => !usesNoSlot(p)),
    keep?.projectIds,
  );
  const excess = new Set(limits.projects === null || rankedProjects.length <= limits.projects ? [] : rankedProjects.slice(limits.projects).map((p) => p.id));
  const projectsToPause = [...rankedProjects].reverse();
  const pauseProjects = projectsToPause.filter((p) => excess.has(p.id) && !p.pausedByDowngrade && (p.status === "active" || p.status === "initializing")).map((p) => p.id);
  const resumeProjects = rankedProjects.filter((p) => p.pausedByDowngrade && !excess.has(p.id)).map((p) => p.id);

  // Each project's state once the plan above is applied.
  const stateOf = new Map<string, "downgrade_paused" | "tracking" | "untracked">();
  for (const p of projects) {
    if (p.pausedByDowngrade) stateOf.set(p.id, excess.has(p.id) ? "downgrade_paused" : "tracking");
    else if (p.status === "active" || p.status === "initializing") stateOf.set(p.id, excess.has(p.id) ? "downgrade_paused" : "tracking");
    else stateOf.set(p.id, "untracked");
  }

  const pause = new Map<string, PromptPauseReason>();
  const resume = new Set<string>();
  const byProject = new Map<string, PausePrompt[]>();
  for (const prompt of prompts) {
    if (stateOf.get(prompt.projectId) === "downgrade_paused") {
      // 1. Paused with its project; a marked or person-paused prompt there stays as it is.
      if (prompt.status === "active") pause.set(prompt.id, "with_project");
      continue;
    }
    const list = byProject.get(prompt.projectId);
    if (list === undefined) byProject.set(prompt.projectId, [prompt]);
    else list.push(prompt);
  }
  const keptPrompts = keep?.promptIds;
  const isTracked = (p: PausePrompt) => stateOf.get(p.projectId) !== "untracked";
  const total = limits.promptsTotal;

  if (keep === undefined) {
    // 2. Per project, on the active count.
    const stillActive: PausePrompt[] = [];
    const resumable: PausePrompt[] = [];
    for (const list of byProject.values()) {
      const active = list.filter((p) => p.status === "active");
      const marked = list.filter((p) => p.status === "paused" && p.pausedByDowngrade);
      const over = excessOf(active, limits.promptsPerProject);
      for (const p of over) pause.set(p.id, "per_project");
      stillActive.push(...active.filter((p) => !pause.has(p.id)));
      if (over.length === 0) {
        const room = limits.promptsPerProject === null ? marked.length : limits.promptsPerProject - active.length;
        resumable.push(...keepOrder(marked).slice(0, Math.max(0, room)));
      }
    }

    // 3. Workspace-wide, over what step 2 left active.
    if (total !== null && stillActive.length > total) {
      const untracked = pauseOrder(stillActive.filter((p) => !isTracked(p)));
      const tracked = pauseOrder(stillActive.filter(isTracked));
      for (const p of [...untracked, ...tracked].slice(0, stillActive.length - total)) pause.set(p.id, "total");
    } else {
      const room = total === null ? resumable.length : total - stillActive.length;
      for (const p of [...keepOrder(resumable.filter(isTracked)), ...keepOrder(resumable.filter((p) => !isTracked(p)))].slice(0, room)) resume.add(p.id);
    }
  } else {
    // 2'. Per project, the chosen first: every active or downgrade-paused prompt competes for the project's room.
    const selected: PausePrompt[] = [];
    for (const list of byProject.values()) {
      const ranked = keepOrder(list.filter((p) => p.status === "active" || p.pausedByDowngrade), keptPrompts);
      const fits = limits.promptsPerProject === null ? ranked : ranked.slice(0, limits.promptsPerProject);
      for (const p of ranked.slice(fits.length)) if (p.status === "active") pause.set(p.id, "per_project");
      selected.push(...fits);
    }
    // 3'. Workspace-wide: tracked projects first, the chosen first within them.
    const ordered = [...keepOrder(selected.filter(isTracked), keptPrompts), ...keepOrder(selected.filter((p) => !isTracked(p)), keptPrompts)];
    const kept = total === null ? ordered : ordered.slice(0, total);
    for (const p of ordered.slice(kept.length)) if (p.status === "active") pause.set(p.id, "total");
    for (const p of kept) if (p.status === "paused") resume.add(p.id);
  }

  return {
    pauseProjects,
    resumeProjects,
    pausePrompts: pauseOrder(prompts, keptPrompts).filter((p) => pause.has(p.id)).map((p) => p.id),
    resumePrompts: keepOrder(prompts, keptPrompts).filter((p) => resume.has(p.id)).map((p) => p.id),
    pausedFor: pause,
  };
}

export interface DowngradePauseOutcome {
  readonly paused: {
    readonly projects: ReadonlyArray<{ id: string; name: string }>;
    /** `withProject`: paused because its project was paused in the same step (the email names the project, not each prompt). */
    readonly prompts: ReadonlyArray<{ id: string; projectId: string; projectName: string; text: string; withProject: boolean }>;
  };
  readonly resumed: { readonly projects: ReadonlyArray<{ id: string; name: string }>; readonly prompts: number };
}

/**
 * Applies `planDowngradePause` to the workspace inside the CALLER's tenant-context transaction (the webhook's, after
 * the plan and add-ons were adopted), with the customer's `keep` choice when the downgrade being adopted has one. Every write is conditional on the state it was planned from, so a concurrent
 * change by a person is never overwritten. Nothing is deleted.
 */
/**
 * "Last active" (STORY-077 D2, contracts/billing/downgrade-keep.schema.ts), as `keepOrder` reads it: a project's latest
 * finished capture run (`completed` or `partial`; a failed or cancelled run produced nothing), a prompt's latest answer
 * capture (`answeredStatusSql`: captured, parsed, or a reused `skipped` cell - the rule freshness uses). Microsecond keys, as `createdKey`. A row with none is absent from the map.
 */
export async function readActivityKeys(tx: ClientBase, workspaceId: string): Promise<{ projects: Map<string, string>; prompts: Map<string, string> }> {
  const projects = await tx.query<{ id: string; activity_key: string }>(
    `SELECT r.project_id AS id, to_char(max(r.finished_at) AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS activity_key
       FROM capture_runs r
      WHERE r.workspace_id = $1 AND r.status IN ('completed', 'partial') AND r.finished_at IS NOT NULL
      GROUP BY r.project_id`,
    [workspaceId],
  );
  // Per prompt through the (workspace_id, prompt_id, captured_at DESC) index, only for the prompts that occupy a slot.
  const prompts = await tx.query<{ id: string; activity_key: string }>(
    `SELECT t.id, to_char(c.captured_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS activity_key
       FROM (SELECT id, workspace_id FROM tracked_prompts WHERE workspace_id = $1 AND ${PROMPT_OCCUPIES_SLOT}) t
       JOIN LATERAL (
         SELECT a.captured_at FROM answer_captures a
          WHERE a.workspace_id = t.workspace_id AND a.prompt_id = t.id AND ${answeredStatusSql("a.status")}
          ORDER BY a.captured_at DESC LIMIT 1
       ) c ON true`,
    [workspaceId],
  );
  return {
    projects: new Map(projects.rows.map((r) => [r.id, r.activity_key])),
    prompts: new Map(prompts.rows.map((r) => [r.id, r.activity_key])),
  };
}

export async function reconcileDowngradePause(tx: ClientBase, workspaceId: string, keep?: KeepChoice): Promise<DowngradePauseOutcome> {
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

  const activity = await readActivityKeys(tx, workspaceId);
  const plan = planDowngradePause(
    limits,
    projectRows.rows.map((r) => ({ id: r.id, createdKey: r.created_key, status: r.status, pausedByDowngrade: r.paused_by_downgrade_at !== null, activityKey: activity.projects.get(r.id) ?? null })),
    promptRows.rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      createdKey: r.created_key,
      status: r.status,
      pausedByDowngrade: r.paused_by_downgrade_at !== null,
      activityKey: activity.prompts.get(r.id) ?? null,
    })),
    keep,
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
    // STORY-067 AC10 - a paused project's pending re-measurements are cancelled with the pause, not left to be found by the sweep.
    for (const projectId of plan.pauseProjects) await cancelTaskVerifications(tx, { projectId }, "project_paused");
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
        return { id, projectId: row.project_id, projectName: nameOf.get(row.project_id) ?? "", text: row.text, withProject: pausedProjects.has(row.project_id) };
      }),
    },
    resumed: { projects: plan.resumeProjects.map((id) => ({ id, name: nameOf.get(id) ?? "" })), prompts: plan.resumePrompts.length },
  };
}

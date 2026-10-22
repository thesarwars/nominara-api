import type { ClientBase } from "pg";
import { downgradeKeepRecordSchema, type DowngradeKeepRecord, type DowngradeKeepRequest } from "../../../contracts/billing/downgrade-keep.schema.js";
import { holdsSlotUntracked, keepOrder, type DowngradePauseOutcome, type DowngradePausePlan, type KeepChoice, type PauseLimits, type PauseProject, type PausePrompt } from "./downgrade-pause.js";

// STORY-077 D2 — the customer's keep choice for a pending downgrade (owner approved 2026-10-20). Pure helpers for the
// route (downgrade-keep.service.ts) and the cut-over (stripe-subscription.handler.ts). The contract
// (contracts/billing/downgrade-keep.schema.ts) states what "keep" means; the planner (downgrade-pause.ts) applies it.

export interface KeepIssue {
  readonly path: Array<string | number>;
  readonly message: string;
}

/**
 * How many projects a choice may name (`limits.projects_keepable`): the target's project limit less the slots held by
 * projects that are not tracking and not ours to resume (archived, or paused by a person: `holdsSlotUntracked`), which the
 * cut-over ranks first (review round 1). Never below 0; null = unlimited.
 */
export function projectSlotsKeepable(limits: PauseLimits, projects: ReadonlyArray<Pick<PauseProject, "status" | "pausedByDowngrade">>): number | null {
  if (limits.projects === null) return null;
  return Math.max(0, limits.projects - projects.filter(holdsSlotUntracked).length);
}

/**
 * Checks a choice against what can be kept and the target plan's resolved limits. `keepable` maps each keepable project
 * (tracking now, or paused by an earlier downgrade) to its keepable prompts (active, or paused by an earlier downgrade).
 * `heldSlots` is the number of non-deleted projects that cannot be kept (archived, or paused by a person): they hold
 * their slots, so at most `limits.projects - heldSlots` projects may be chosen (review round 1).
 * An id that cannot be kept is named at its index; only a choice whose every id can be kept is counted against the limits.
 */
export function validateKeepChoice(request: DowngradeKeepRequest, keepable: ReadonlyMap<string, ReadonlySet<string>>, limits: PauseLimits, heldSlots: number): KeepIssue[] {
  const issues: KeepIssue[] = [];
  request.project_ids.forEach((projectId, index) => {
    if (!keepable.has(projectId)) issues.push({ path: ["project_ids", index], message: "not a project that can be kept" });
  });
  const projectOfPrompt = new Map<string, string>();
  for (const [projectId, prompts] of keepable) for (const promptId of prompts) projectOfPrompt.set(promptId, projectId);
  const chosenProjects = new Set(request.project_ids);
  const perProject = new Map<string, number>();
  request.prompt_ids.forEach((promptId, index) => {
    const projectId = projectOfPrompt.get(promptId);
    if (projectId === undefined) issues.push({ path: ["prompt_ids", index], message: "not a prompt that can be kept" });
    else if (!chosenProjects.has(projectId)) issues.push({ path: ["prompt_ids", index], message: "its project is not in project_ids" });
    else perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);
  });
  if (issues.length > 0) return issues;

  if (limits.projects !== null) {
    const held = Math.min(heldSlots, limits.projects);
    const allowed = limits.projects - held;
    if (request.project_ids.length > allowed) {
      issues.push({
        path: ["project_ids"],
        message:
          held === 0
            ? `the target plan keeps at most ${String(limits.projects)} projects`
            : `the target plan keeps at most ${String(allowed)} more ${allowed === 1 ? "project" : "projects"}: ${String(held)} of its ${String(limits.projects)} project slots ${held === 1 ? "is" : "are"} held by archived or paused projects`,
      });
    }
  }
  const perProjectLimit = limits.promptsPerProject;
  if (perProjectLimit !== null && [...perProject.values()].some((n) => n > perProjectLimit)) {
    issues.push({ path: ["prompt_ids"], message: `the target plan keeps at most ${String(perProjectLimit)} prompts in one project` });
  }
  if (limits.promptsTotal !== null && request.prompt_ids.length > limits.promptsTotal) {
    issues.push({ path: ["prompt_ids"], message: `the target plan keeps at most ${String(limits.promptsTotal)} prompts in all` });
  }
  return issues;
}

/**
 * What still tracks once `plan` is applied: the projects (active or initializing and not paused, or resumed) in
 * `keepOrder`, and, project by project in that order, their prompts that are active and not paused, or resumed. The GET's
 * `default` is this for the planner's dry run with no choice. A prompt in a project nothing tracks is never named.
 */
export function keptAfter(plan: DowngradePausePlan, projects: readonly PauseProject[], prompts: readonly PausePrompt[]): { projectIds: string[]; promptIds: string[] } {
  const pausedProjects = new Set(plan.pauseProjects);
  const resumedProjects = new Set(plan.resumeProjects);
  const pausedPrompts = new Set(plan.pausePrompts);
  const resumedPrompts = new Set(plan.resumePrompts);
  const tracking = keepOrder(projects).filter(
    (p) => resumedProjects.has(p.id) || (!p.pausedByDowngrade && (p.status === "active" || p.status === "initializing") && !pausedProjects.has(p.id)),
  );
  const promptIds: string[] = [];
  for (const project of tracking) {
    const own = keepOrder(prompts.filter((p) => p.projectId === project.id));
    for (const p of own) if (resumedPrompts.has(p.id) || (p.status === "active" && !pausedPrompts.has(p.id))) promptIds.push(p.id);
  }
  return { projectIds: tracking.map((p) => p.id), promptIds };
}

/** `subscriptions.downgrade_keep` as a record, or null when absent or unreadable (an unreadable choice is not honoured). */
export function readKeepRecord(raw: unknown): DowngradeKeepRecord | null {
  if (raw === null || raw === undefined) return null;
  const parsed = downgradeKeepRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The choice the cut-over honours: the one recorded for the intent being adopted on this subscription, for this plan.
 * Read inside the webhook's transaction, before the intent is spent (which clears the choice with it).
 */
export async function keepChoiceForAdoption(tx: ClientBase, workspaceId: string, subscriptionId: string, intentId: string, planKey: string): Promise<KeepChoice | undefined> {
  if (intentId.length === 0) return undefined;
  const row = await tx.query<{ downgrade_keep: unknown }>(
    `SELECT downgrade_keep FROM subscriptions
      WHERE workspace_id = $1 AND stripe_subscription_id = $2 AND status IN ('trialing','active','past_due')
        AND pending_plan_change ->> 'id' = $3 AND pending_plan_change ->> 'to_plan_key' = $4 AND pending_plan_change ->> 'direction' = 'downgrade'`,
    [workspaceId, subscriptionId, intentId, planKey],
  );
  const record = readKeepRecord(row.rows[0]?.downgrade_keep);
  if (record === null || record.intent_id !== intentId) return undefined;
  return { projectIds: new Set(record.project_ids), promptIds: new Set(record.prompt_ids) };
}

/** True when the cut-over paused something the customer chose (the limits fell after the choice): the email says so. */
export function pausedAnyChosen(keep: KeepChoice, paused: DowngradePauseOutcome["paused"]): boolean {
  return paused.projects.some((p) => keep.projectIds.has(p.id)) || paused.prompts.some((p) => keep.promptIds.has(p.id));
}

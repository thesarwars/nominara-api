import type { ClientBase } from "pg";
import { MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import type { DowngradeExcessItem } from "../../../contracts/common/downgrade-excess.schema.js";
import type { Entitlement, EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { FEATURE_FLAG_KEYS, isFeatureGranted, structuralLimitFrom, type StructuralLimitKey } from "../entitlements/classification.js";
import { ADDON_KINDS, mergeEntitlements, type AddonKind, type AddonQuantities } from "../entitlements/resolution.js";
import { countStructural, PROMPT_OCCUPIES_SLOT } from "../entitlements/structural-usage.js";
import { ADDON_CATALOG } from "./addon-catalog.js";
import { pauseLimitsFrom, planDowngradePauseWithReasons, readActivityKeys, type PausePrompt } from "./downgrade-pause.js";

// STORY-184 T5 — what a downgrade would cost the customer, named exactly.
//
// plans-and-entitlements.md §14: "the confirmation screen names exactly what exceeds the new limits", and no downgrade
// path destroys data without a named warning. STORY-077 slice A: a projects or prompts excess no longer blocks — it is
// PAUSED at the cut-over (`effect: paused_at_period_end`, see downgrade-pause.ts). Seats, competitors and API keys,
// which §14 does not name as pausable, still block until usage is reduced (`effect: must_reduce`, STORY-184's refusal
// kept for these keys only). Features lost, add-ons dropped and a shortened retention window are named and never block.
//
// ⚠ THE LIMIT A USAGE IS CHECKED AGAINST IS THE TARGET'S RESOLVED ONE, not the bare plan's. It is computed with the
// SAME `mergeEntitlements` the guards resolve through: the add-ons that survive the move still raise it, an add-on the
// target does not allow is dropped (and named), and an operator override is the final word. Comparing against the
// plan's bare number would refuse a customer who holds the seats they paid for, or let one through whose add-on is
// about to disappear.
//
// ⚠ THE COUNTS ARE THE GUARDS' OWN (`countStructural`), not a second set of predicates.
//
// ⚠ WHAT IS PAUSED IS THE CUT-OVER'S OWN (STORY-077 review round 3). `current`/`excess` are the guard's slot counts, but
// the cut-over reconciles prompts on the ACTIVE count and a paused project takes its active prompts with it, so the
// number of rows it pauses can differ from `excess` in either direction. Each `paused_at_period_end` entry therefore
// carries `paused`, and each named project its `prompts`, from a DRY RUN of the cut-over's own planner
// (`planDowngradePauseWithReasons`) on the target's resolved limits - the confirmation never names fewer (or more) than
// the cut-over pauses.

const WORKSPACE_KEYS = ["projects.max", "prompts.max_total", "seats.max", "api.keys_max"] as const satisfies readonly StructuralLimitKey[];
const PROJECT_KEYS = ["prompts.max_per_project", "competitors.max_per_project"] as const satisfies readonly StructuralLimitKey[];
const RETENTION_KEYS = ["retention.raw_captures_days", "retention.rollups_days"] as const;
/** §14: the structural keys the cut-over PAUSES (projects and prompts). Every other structural key must be reduced first. */
export const PAUSABLE_KEYS: ReadonlySet<StructuralLimitKey> = new Set<StructuralLimitKey>(["projects.max", "prompts.max_total", "prompts.max_per_project"]);
const effectOf = (key: StructuralLimitKey): "paused_at_period_end" | "must_reduce" => (PAUSABLE_KEYS.has(key) ? "paused_at_period_end" : "must_reduce");
/** The most excess projects named; the list is for the confirmation screen, the count is exact regardless. */
const MAX_NAMED_PROJECTS = 100;

type WorkspaceKey = (typeof WORKSPACE_KEYS)[number];

export interface ExcessUsage {
  /** The workspace-wide counts, by structural key. */
  readonly workspace: Readonly<Record<WorkspaceKey, number>>;
  /** Live projects, NEWEST FIRST, each with its own prompt and competitor counts. */
  readonly projects: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly prompts: number;
    readonly competitors: number;
    readonly status: "initializing" | "active" | "paused" | "archived";
    /** Already paused by an earlier downgrade (`paused_by_downgrade_at`). */
    readonly pausedByDowngrade: boolean;
    /** `created_at` as the planner's microsecond key (downgrade-pause.ts `PauseProject.createdKey`). */
    readonly createdKey: string;
    /** STORY-077 D2: the planner's activity key (latest finished capture run); null or absent: never. */
    readonly activityKey?: string | null;
  }>;
  /** Every slot-occupying prompt (`PROMPT_OCCUPIES_SLOT`), as the cut-over's planner reads them. */
  readonly slotPrompts: readonly PausePrompt[];
}

export interface ExcessInput {
  readonly currentPlan: Readonly<Record<string, Entitlement>>;
  readonly targetPlan: Readonly<Record<string, Entitlement>>;
  readonly heldAddons: AddonQuantities;
  readonly overrides: Readonly<Record<string, EntitlementValue>>;
  readonly usage: ExcessUsage;
}

export interface DowngradeExcess {
  /** Every structural excess, each with its `effect`, in a stable order. */
  readonly structural: DowngradeExcessItem[];
  /** The `must_reduce` structural entries: the downgrade is refused while any of these exists. */
  readonly blocking: DowngradeExcessItem[];
  /** Named, never blocking: features lost, add-ons dropped, retention shortened. */
  readonly informational: DowngradeExcessItem[];
  /** `structural` then `informational`. */
  readonly all: DowngradeExcessItem[];
}

/** The add-ons the target plan still allows, and those it does not. */
export function splitAddons(targetPlan: Readonly<Record<string, Entitlement>>, held: AddonQuantities): { surviving: AddonQuantities; dropped: Array<{ addon: AddonKind; quantity: number }> } {
  const surviving: Partial<Record<AddonKind, number>> = {};
  const dropped: Array<{ addon: AddonKind; quantity: number }> = [];
  for (const kind of ADDON_KINDS) {
    const quantity = held[kind] ?? 0;
    if (quantity <= 0) continue;
    if (isFeatureGranted(targetPlan[ADDON_CATALOG[kind].allowedKey]?.value ?? null)) surviving[kind] = quantity;
    else dropped.push({ addon: kind, quantity });
  }
  return { surviving, dropped };
}

/** A retention window in days: a number, `Infinity` for "unlimited", or `null` for "not applicable for this tier". */
function windowOf(value: EntitlementValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (value === "unlimited") return Infinity;
  return null;
}

export function computeDowngradeExcess(input: ExcessInput): DowngradeExcess {
  const { surviving, dropped } = splitAddons(input.targetPlan, input.heldAddons);
  const current = mergeEntitlements(input.currentPlan, input.heldAddons, input.overrides);
  const target = mergeEntitlements(input.targetPlan, surviving, input.overrides);

  // The cut-over's own plan, dry run on the target's resolved limits (review round 3).
  const plan = planDowngradePauseWithReasons(
    pauseLimitsFrom(target),
    input.usage.projects.map((p) => ({ id: p.id, createdKey: p.createdKey, status: p.status, pausedByDowngrade: p.pausedByDowngrade, activityKey: p.activityKey ?? null })),
    input.usage.slotPrompts,
  );
  const projectOf = new Map(input.usage.slotPrompts.map((p) => [p.id, p.projectId]));
  const pausedPrompts = (reason: "with_project" | "per_project" | "total", projectId?: string): number => {
    let n = 0;
    for (const [id, why] of plan.pausedFor) if (why === reason && (projectId === undefined || projectOf.get(id) === projectId)) n += 1;
    return n;
  };

  const structural: DowngradeExcessItem[] = [];
  const limitOf = (key: StructuralLimitKey): number | null => {
    const limit = structuralLimitFrom(target[key]?.value ?? null);
    return limit === undefined || limit.kind === "unlimited" ? null : limit.limit;
  };

  for (const key of WORKSPACE_KEYS) {
    const limit = limitOf(key);
    const used = input.usage.workspace[key];
    if (limit === null || used <= limit) continue;
    const excess = used - limit;
    if (key === "projects.max") {
      // The planner's own (STORY-077 D2: the least recently active, in the order the cut-over pauses them). The guard
      // counts TRACKING projects (owner decision 2026-10-23), so the excess is exactly what the cut-over pauses: an
      // archived, person-paused or already downgrade-paused project is neither counted nor named.
      const byId = new Map(input.usage.projects.map((p) => [p.id, p]));
      const items = plan.pauseProjects
        .map((id) => byId.get(id)!)
        .slice(0, MAX_NAMED_PROJECTS)
        .map((p) => ({ id: p.id, name: p.name, prompts: pausedPrompts("with_project", p.id) }));
      structural.push({ kind: "structural", key, limit, current: used, excess, effect: effectOf(key), paused: plan.pauseProjects.length, items });
    } else if (key === "prompts.max_total") {
      structural.push({ kind: "structural", key, limit, current: used, excess, effect: effectOf(key), paused: pausedPrompts("total") });
    } else {
      structural.push({ kind: "structural", key, limit, current: used, excess, effect: effectOf(key) });
    }
  }
  for (const project of input.usage.projects) {
    for (const key of PROJECT_KEYS) {
      const limit = limitOf(key);
      const used = key === "prompts.max_per_project" ? project.prompts : project.competitors;
      if (limit === null || used <= limit) continue;
      if (key === "prompts.max_per_project") {
        structural.push({ kind: "structural", key, project_id: project.id, limit, current: used, excess: used - limit, effect: effectOf(key), paused: pausedPrompts("per_project", project.id) });
      } else {
        structural.push({ kind: "structural", key, project_id: project.id, limit, current: used, excess: used - limit, effect: effectOf(key) });
      }
    }
  }

  const informational: DowngradeExcessItem[] = [];
  for (const { addon, quantity } of dropped) informational.push({ kind: "addon_dropped", addon, quantity });

  const lost = FEATURE_FLAG_KEYS.filter((key) => {
    const before = current[key];
    // A feature that is not live renders nowhere (§1 rule 5), so losing it is not something to tell the customer.
    return before !== undefined && before.live && isFeatureGranted(before.value) && !isFeatureGranted(target[key]?.value ?? null);
  });
  for (const key of [...lost].sort((a, b) => a.localeCompare(b))) informational.push({ kind: "feature_lost", key });

  for (const key of RETENTION_KEYS) {
    const from = windowOf(current[key]?.value);
    if (from === null) continue;
    const to = windowOf(target[key]?.value) ?? 0;
    if (to < from) informational.push({ kind: "retention_shortened", key, from_days: Number.isFinite(from) ? from : null, to_days: to });
  }

  const blocking = structural.filter((entry) => entry.kind === "structural" && entry.effect === "must_reduce");
  return { structural, blocking, informational, all: [...structural, ...informational] };
}

/**
 * Reads the workspace's usage for a downgrade check, inside the caller's tenant-context transaction (RLS scopes every
 * count; the `workspace_id` predicates are for the planner). Counts come from `countStructural`, the guards' own.
 */
export async function readExcessUsage(tx: ClientBase, workspaceId: string): Promise<ExcessUsage> {
  const workspace = {} as Record<WorkspaceKey, number>;
  for (const key of WORKSPACE_KEYS) workspace[key] = await countStructural(tx, key, workspaceId);

  const activity = await readActivityKeys(tx, workspaceId);
  const rows = await tx.query<{ id: string; name: string; created_key: string; status: ExcessUsage["projects"][number]["status"]; paused_by_downgrade: boolean }>(
    `SELECT id, name, to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_key, status, paused_by_downgrade_at IS NOT NULL AS paused_by_downgrade
       FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
    [workspaceId],
  );
  const projects: Array<ExcessUsage["projects"][number]> = [];
  for (const row of rows.rows) {
    projects.push({
      id: row.id,
      name: row.name,
      status: row.status,
      pausedByDowngrade: row.paused_by_downgrade,
      createdKey: row.created_key,
      activityKey: activity.projects.get(row.id) ?? null,
      prompts: await countStructural(tx, "prompts.max_per_project", workspaceId, row.id),
      competitors: await countStructural(tx, "competitors.max_per_project", workspaceId, row.id),
    });
  }
  // The same rows, read the same way, as the cut-over's reconcile (downgrade-pause.ts), without its row locks.
  const prompts = await tx.query<{ id: string; project_id: string; created_key: string; status: "active" | "paused"; paused_by_downgrade: boolean }>(
    `SELECT id, project_id, to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_key, status, paused_by_downgrade_at IS NOT NULL AS paused_by_downgrade
       FROM tracked_prompts WHERE workspace_id = $1 AND ${PROMPT_OCCUPIES_SLOT}`,
    [workspaceId],
  );
  const slotPrompts = prompts.rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    createdKey: r.created_key,
    status: r.status,
    pausedByDowngrade: r.paused_by_downgrade,
    activityKey: activity.prompts.get(r.id) ?? null,
  }));
  return { workspace, projects, slotPrompts };
}

import type { ClientBase } from "pg";
import type { DowngradeExcessItem } from "../../../contracts/common/downgrade-excess.schema.js";
import type { Entitlement, EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { FEATURE_FLAG_KEYS, isFeatureGranted, structuralLimitFrom, type StructuralLimitKey } from "../entitlements/classification.js";
import { ADDON_KINDS, mergeEntitlements, type AddonKind, type AddonQuantities } from "../entitlements/resolution.js";
import { countStructural } from "../entitlements/structural-usage.js";
import { ADDON_CATALOG } from "./addon-catalog.js";

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
  }>;
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
      // The excess is the most recently created ones, exactly the order §14 pauses them in. Every one is COUNTED (the
      // guard's count), but only those the cut-over pauses - or a downgrade already paused - are NAMED as paused: an
      // archived or person-paused project in the excess is not tracked and is never paused (downgrade-pause.ts).
      const items = input.usage.projects
        .slice(0, excess)
        .filter((p) => p.pausedByDowngrade || p.status === "active" || p.status === "initializing")
        .slice(0, MAX_NAMED_PROJECTS)
        .map((p) => ({ id: p.id, name: p.name }));
      structural.push({ kind: "structural", key, limit, current: used, excess, effect: effectOf(key), items });
    } else {
      structural.push({ kind: "structural", key, limit, current: used, excess, effect: effectOf(key) });
    }
  }
  for (const project of input.usage.projects) {
    for (const key of PROJECT_KEYS) {
      const limit = limitOf(key);
      const used = key === "prompts.max_per_project" ? project.prompts : project.competitors;
      if (limit === null || used <= limit) continue;
      structural.push({ kind: "structural", key, project_id: project.id, limit, current: used, excess: used - limit, effect: effectOf(key) });
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

  const rows = await tx.query<{ id: string; name: string; status: ExcessUsage["projects"][number]["status"]; paused_by_downgrade: boolean }>(
    `SELECT id, name, status, paused_by_downgrade_at IS NOT NULL AS paused_by_downgrade
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
      prompts: await countStructural(tx, "prompts.max_per_project", workspaceId, row.id),
      competitors: await countStructural(tx, "competitors.max_per_project", workspaceId, row.id),
    });
  }
  return { workspace, projects };
}

import type { ClientBase } from "pg";
import {
  entitlementOverridesSchema,
  type EntitlementSource,
  type ResolvedEntitlement,
  type ResolvedEntitlementsResponse,
} from "../../../contracts/entitlements/resolved-entitlements.schema.js";
import type { Entitlement, EntitlementValue } from "../../db/seed/plan-entitlements.js";

// STORY-069 AC3, AC9, AC12 — plans-and-entitlements.md §8 "Entitlement
// resolution":
//
//   effective(key) = plan.entitlements[key] + Σ addon contributions
//                    then overridden by workspaces.entitlement_overrides[key]
//
// THE ORDER IS NOT COSMETIC. Add-ons are additive and overrides are absolute,
// so applying them the other way round would let a purchased add-on quietly
// raise a negotiated ceiling above what the contract says — an enterprise
// agreement capped at 25 projects would become 26 the moment somebody bought a
// project slot, and nothing would report it. Overrides last means an override
// is the final word, which is what "negotiated" has to mean to be worth
// writing down.

export const ADDON_KINDS = ["extra_project", "extra_seat"] as const;

export type AddonKind = (typeof ADDON_KINDS)[number];

/** Active add-on quantities, by kind. Absent means none. */
export type AddonQuantities = Readonly<Partial<Record<AddonKind, number>>>;

export type { EntitlementSource, ResolvedEntitlement, ResolvedEntitlementsResponse };

/**
 * The contributions the active add-ons make, as a sparse map of key → new
 * value. Only keys an add-on actually moves appear.
 *
 * §8, and `FR-CRD-05` beside it: **"an extra project must carry its own prompt
 * slots. A project you cannot put prompts in is a broken purchase"** — called
 * out in the reference as "the single most likely misreading in the product",
 * and again in this story's AC9. The natural implementation adds a project
 * slot and stops, so the prompt-slot half is written first here and has its own
 * test.
 */
export function addonContributions(
  plan: Readonly<Record<string, Entitlement>>,
  addons: AddonQuantities,
): Readonly<Record<string, EntitlementValue>> {
  const contributions: Record<string, EntitlementValue> = {};

  const extraProjects = addons.extra_project ?? 0;
  if (extraProjects > 0) {
    addNumeric(contributions, plan, "projects.max", extraProjects);

    // The prompt-slot half. §8: "grants `+1 project` **and**
    // `+prompts.max_per_project` prompt slots". The grant is on
    // `prompts.max_total` — the workspace-wide ceiling — because
    // `prompts.max_per_project` is a PER-project cap and raising it would give
    // every existing project more room, which is not what was bought.
    const perProject = plan["prompts.max_per_project"]?.value;
    if (typeof perProject === "number") {
      addNumeric(contributions, plan, "prompts.max_total", extraProjects * perProject);
    }
  }

  const extraSeats = addons.extra_seat ?? 0;
  if (extraSeats > 0) {
    addNumeric(contributions, plan, "seats.max", extraSeats);
  }

  return contributions;
}

/**
 * Adds `delta` to a plan value, but only where the plan value is a number.
 *
 * The guard is the interesting half. Enterprise carries `"custom"`,
 * `"uncapped"` and `"unlimited"` for exactly these keys, and turning
 * `"unlimited" + 1` into anything at all would replace a negotiated
 * open ceiling with a hard number nobody agreed to. §8 restricts the extra-
 * project add-on to Growth and Business and the extra-seat add-on to Starter+
 * — every tier where these keys are numeric — so on the paths that can really
 * happen this guard never fires. It is here because "the tiers that can buy it
 * all have numbers" is a property of today's matrix, which §2 says is data and
 * may be edited without a redeploy.
 */
function addNumeric(
  into: Record<string, EntitlementValue>,
  plan: Readonly<Record<string, Entitlement>>,
  key: string,
  delta: number,
): void {
  const base = plan[key]?.value;
  if (typeof base !== "number") {
    return;
  }
  into[key] = base + delta;
}

/**
 * The pure merge: plan, then add-on contributions, then overrides.
 *
 * Separated from the query so the ordering property AC3 names can be tested
 * without a database, and so the resolver below has nothing in it but IO.
 */
export function mergeEntitlements(
  plan: Readonly<Record<string, Entitlement>>,
  addons: AddonQuantities,
  overrides: Readonly<Record<string, EntitlementValue>>,
): Readonly<Record<string, ResolvedEntitlement>> {
  const contributions = addonContributions(plan, addons);
  const resolved: Record<string, ResolvedEntitlement> = {};

  for (const [key, entitlement] of Object.entries(plan)) {
    const planValue = entitlement.value;
    let value = planValue;
    let source: EntitlementSource = "plan";

    const contributed = contributions[key];
    if (contributed !== undefined) {
      value = contributed;
      source = "add_on";
    }

    // Last, and absolute. `Object.hasOwn` rather than an `undefined` check:
    // `null` is a real entitlement value in this encoding ("— / not applicable
    // for that tier"), so an override that deliberately sets a key to `null`
    // must be honoured rather than read as "no override present".
    if (Object.hasOwn(overrides, key)) {
      value = overrides[key] as EntitlementValue;
      source = "override";
    }

    resolved[key] = {
      value,
      // `live` is NOT overridable — see the note on entitlementOverridesSchema.
      // §1 rule 5: a deferred entitlement renders nowhere, and whether the
      // feature has been built is a fact about the build, not about a contract.
      live: entitlement.live,
      source,
      plan_value: planValue,
    };
  }

  return resolved;
}

interface WorkspaceEntitlementRow {
  plan_key: string;
  entitlement_version: number;
  entitlement_overrides: unknown;
  plan_entitlements: Record<string, Entitlement>;
  addons: Record<string, number>;
}

export class UnknownWorkspaceError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} does not exist or is deleted — no entitlements can be resolved`);
    this.name = "UnknownWorkspaceError";
  }
}

export class InvalidEntitlementOverridesError extends Error {
  constructor(workspaceId: string, detail: string) {
    super(
      `workspace ${workspaceId} has invalid entitlement_overrides: ${detail}. ` +
        "An override that cannot be parsed is not applied, and an unapplied override is invisible — " +
        "STORY-069 AC12 requires a non-standard limit to be visible rather than mysterious.",
    );
    this.name = "InvalidEntitlementOverridesError";
  }
}

/**
 * Reads the version alone.
 *
 * DELIBERATELY NOT MEMOISED, and this is the whole of AC4's "a version bump
 * invalidates it immediately". The memo key contains the version, so a bump
 * lands on a key nothing has written and the next resolve is a miss — no
 * invalidation call, nothing to forget, and no window during which a downgrade
 * has been recorded but is not yet enforced. That property only holds while the
 * version itself is read fresh; memoising this probe too would reintroduce
 * exactly the non-deterministic lag §8 says the version exists to remove.
 *
 * It costs one primary-key lookup of one integer column. The expensive part —
 * the plans join, the add-on aggregate, the merge — is what the memo saves.
 */
export async function readEntitlementVersion(tx: ClientBase, workspaceId: string): Promise<number> {
  const result = await tx.query<{ entitlement_version: number }>(
    "SELECT entitlement_version FROM workspaces WHERE id = $1 AND deleted_at IS NULL",
    [workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new UnknownWorkspaceError(workspaceId);
  }
  return row.entitlement_version;
}

/**
 * The full resolution, in ONE round trip.
 *
 * The add-on aggregate is a correlated subquery rather than a join so a
 * workspace with no add-ons still returns exactly one row — a plain join would
 * need an outer join plus a GROUP BY to say the same thing, and would fan the
 * plan's 50-key jsonb out across one row per add-on to do it.
 *
 * `active_until IS NULL` is what "active" means for this table
 * (`ux_addons_active` is unique on `(workspace_id, kind)` under exactly that
 * predicate, so the aggregate below cannot see two rows of one kind).
 * `active_from <= now()` is the other half: an add-on row written ahead of its
 * start date is recorded, not yet granted.
 */
export async function resolveEntitlements(
  tx: ClientBase,
  workspaceId: string,
): Promise<ResolvedEntitlementsResponse> {
  const result = await tx.query<WorkspaceEntitlementRow>(
    `SELECT w.plan_key,
            w.entitlement_version,
            w.entitlement_overrides,
            p.entitlements AS plan_entitlements,
            COALESCE(
              (SELECT jsonb_object_agg(a.kind, a.quantity)
                 FROM subscription_addons a
                WHERE a.workspace_id = w.id
                  AND a.active_until IS NULL
                  AND a.active_from <= now()),
              '{}'::jsonb
            ) AS addons
       FROM workspaces w
       JOIN plans p ON p.key = w.plan_key
      WHERE w.id = $1
        AND w.deleted_at IS NULL`,
    [workspaceId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new UnknownWorkspaceError(workspaceId);
  }

  const parsedOverrides = entitlementOverridesSchema.safeParse(row.entitlement_overrides);
  if (!parsedOverrides.success) {
    throw new InvalidEntitlementOverridesError(
      workspaceId,
      parsedOverrides.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "),
    );
  }

  return {
    workspace_id: workspaceId,
    plan_key: row.plan_key,
    entitlement_version: row.entitlement_version,
    entitlements: mergeEntitlements(
      row.plan_entitlements,
      row.addons as AddonQuantities,
      parsedOverrides.data as Record<string, EntitlementValue>,
    ),
  };
}

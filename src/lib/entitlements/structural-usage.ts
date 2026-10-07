import type { Pool } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { isFeatureGranted, type FeatureFlagKey, type StructuralLimitKey } from "./classification.js";

// STORY-069 AC6 — `details.{key, limit, current}`. `limit` comes from
// resolution; `current` is what the workspace has right now, and it has to be
// counted per key because each key counts a different thing.
//
// `current` CAN LEGITIMATELY EXCEED `limit`, which is why
// entitlementExceededDetailsSchema expresses neither in terms of the other: a
// downgrade leaves a workspace over its new ceiling, and §14 (downgrade and
// over-limit policy) makes that a supported state rather than an error. The
// guard's job is only to refuse the NEXT one.

/** Whether the count is scoped to the workspace or to one project inside it. */
export type StructuralScope = "workspace" | "project";

interface StructuralCounter {
  readonly scope: StructuralScope;
  readonly sql: string;
}

/**
 * A prompt occupies a slot until it is ARCHIVED, not until it is paused.
 *
 * §10's worked example counts "32 already active" against a 40-prompt cap, and
 * `FR-CRD-06` gives `status='archived'` its meaning: "Unactivated candidates
 * persist with `status='archived'` and activate later at 0 credits." So
 * archived is the state that does not consume a slot, and by elimination
 * `active` and `paused` both do.
 *
 * Counting only `active` would make the cap trivially bypassable — pause forty
 * prompts, activate forty more, repeat — and nothing in the reference says a
 * paused prompt releases its slot. STORY-046 owns pause semantics; if it
 * decides otherwise, this predicate is the one line to change and the tests
 * below say what depends on it.
 */
// Exported (STORY-169 review) so the dev-only demo seed can count against
// the EXACT same predicate this file's own `COUNTERS["prompts.max_total" /
// "prompts.max_per_project"]` use, rather than a second literal that could
// silently drift from this one and under- or over-count what actually
// occupies a slot.
export const PROMPT_OCCUPIES_SLOT = "status <> 'archived' AND deleted_at IS NULL";

const COUNTERS: Record<StructuralLimitKey, StructuralCounter> = {
  "projects.max": {
    scope: "workspace",
    sql: "SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL",
  },
  "prompts.max_total": {
    scope: "workspace",
    sql: `SELECT count(*)::int AS n FROM tracked_prompts WHERE workspace_id = $1 AND ${PROMPT_OCCUPIES_SLOT}`,
  },
  "prompts.max_per_project": {
    scope: "project",
    sql: `SELECT count(*)::int AS n FROM tracked_prompts WHERE workspace_id = $1 AND project_id = $2 AND ${PROMPT_OCCUPIES_SLOT}`,
  },
  "competitors.max_per_project": {
    scope: "project",
    sql: "SELECT count(*)::int AS n FROM competitors WHERE workspace_id = $1 AND project_id = $2 AND deleted_at IS NULL",
  },
  "seats.max": {
    // `status <> 'removed'` matches ux_members_ws_user's own predicate: a
    // removed member has released the seat, a suspended one has not.
    scope: "workspace",
    sql: "SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND status <> 'removed'",
  },
  "api.keys_max": {
    // A revoked key is gone; an EXPIRED one is not counted either — it cannot
    // authenticate anything, so holding a slot open for it would charge the
    // customer for a key that does nothing.
    scope: "workspace",
    sql: "SELECT count(*)::int AS n FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())",
  },
};

export function scopeOf(key: StructuralLimitKey): StructuralScope {
  return COUNTERS[key].scope;
}

export class MissingProjectScopeError extends Error {
  constructor(key: StructuralLimitKey) {
    super(
      `entitlement '${key}' is counted per project, but the route declared no @ProjectParam() ` +
        "to read the project id from. Counting it workspace-wide would refuse a second project's " +
        "first prompt, so the request is refused rather than answered wrongly.",
    );
    this.name = "MissingProjectScopeError";
  }
}

export class StructuralUsage {
  constructor(private readonly pool: Pool) {}

  async current(key: StructuralLimitKey, workspaceId: string, projectId?: string): Promise<number> {
    const counter = COUNTERS[key];
    if (counter.scope === "project" && projectId === undefined) {
      throw new MissingProjectScopeError(key);
    }

    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const params = counter.scope === "project" ? [workspaceId, projectId] : [workspaceId];
        const result = await tx.query<{ n: number }>(counter.sql, params);
        return result.rows[0]?.n ?? 0;
      });
    } finally {
      client.release();
    }
  }

  /**
   * The lowest tier whose plan grants `key`, read from `plans` — never a
   * constant.
   *
   * AC10 forbids a hardcoded limit, price or credit cost anywhere, and a
   * hardcoded `min_plan` is the same defect wearing a different hat: it keeps
   * working after a plan edit and diverges from billing silently, which is the
   * exact failure the criterion's own note describes.
   *
   * `undefined` when NO tier grants it. That is a configuration error rather
   * than a customer condition — see EntitlementGuard, which refuses to tell
   * somebody to upgrade to a plan that would not help.
   */
  async minimumPlanFor(key: FeatureFlagKey): Promise<string | undefined> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ key: string; value: unknown }>(
        `SELECT key, entitlements -> $1 -> 'value' AS value
           FROM plans
          ORDER BY sort_order`,
        [key],
      );
      for (const row of result.rows) {
        if (isFeatureGranted(row.value as never)) {
          return row.key;
        }
      }
      return undefined;
    } finally {
      client.release();
    }
  }
}


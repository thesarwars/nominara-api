import { Injectable } from "@nestjs/common";
import {
  ENTITY_INDEX_LIMIT_PER_KIND,
  ENTITY_INDEX_NAME_MAX,
  type EntityIndexEntry,
  type EntityIndexKind,
  type EntityIndexResponse,
} from "../../../contracts/command/entity-index.schema.js";
import type { StructuralLimitKey } from "../../lib/entitlements/classification.js";
import { countStructural } from "../../lib/entitlements/structural-usage.js";
import { evaluatePermission } from "../../tenancy/permission-matrix.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import type { CommandCaller } from "./command-caller.js";

// STORY-085 AC2/AC3 - the prefetched entity index, and the one place a typed project name becomes an id.
//
// READ-ONLY by construction: every statement here is a SELECT run in the request's own tenant transaction, so
// RLS (workspace) and `app.current_scope_projects()` (the caller's project scope) narrow every row. A scoped
// manager's index, and a scoped manager's binding of a typed name, can only ever see their own projects.
//
// The workspace-level `tool_runs` follow the tool-run list's own gate (`lookup:read_history`): a caller who may
// not read the history does not get its names through the index either.

/** The scope predicate every project-owned kind uses; the planner hint is `workspace_id`, correctness is RLS. */
const IN_SCOPE = (column: string): string =>
  `(cardinality(app.current_scope_projects()) = 0 OR ${column} = ANY(app.current_scope_projects()))`;

interface Row {
  readonly id: string;
  readonly name: string;
  readonly project_id: string | null;
}

@Injectable()
export class EntityIndexService {
  /**
   * How much of a structural limit the workspace uses now (FR-CMD-05's disabled reason): the same count the creation guards enforce, in this
   * request's own tenant transaction.
   */
  async usageOf(caller: CommandCaller, key: StructuralLimitKey): Promise<number> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("EntityIndexService requires an active tenant context");
    return await countStructural(store.client, key, caller.workspaceId);
  }

  async read(caller: CommandCaller): Promise<EntityIndexResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("EntityIndexService requires an active tenant context");
    const { client } = store;
    // One extra row per kind says whether the bound cut something off.
    const fetch = ENTITY_INDEX_LIMIT_PER_KIND + 1;
    // ⚠ A manager scoped to NOTHING must see no project-owned entity. The tenant context sets the scope GUC only when the
    // scope is non-empty (tenant-context.ts), so an empty scope would read as "unrestricted" in the predicate below.
    const noProjects = scopedToNothing(caller);
    const cut = ENTITY_INDEX_NAME_MAX;

    const none = { rows: [] as Row[] };
    const projects = noProjects ? none : await client.query<Row>(
      `SELECT id, left(name, ${cut}) AS name, NULL::uuid AS project_id FROM projects
        WHERE workspace_id = app.current_workspace() AND deleted_at IS NULL AND ${IN_SCOPE("id")}
        ORDER BY created_at DESC, id DESC LIMIT $1`,
      [fetch],
    );
    const competitors = noProjects ? none : await client.query<Row>(
      `SELECT id, left(name, ${cut}) AS name, project_id FROM competitors
        WHERE workspace_id = app.current_workspace() AND deleted_at IS NULL AND ${IN_SCOPE("project_id")}
        ORDER BY created_at DESC, id DESC LIMIT $1`,
      [fetch],
    );
    const prompts = noProjects ? none : await client.query<Row>(
      `SELECT id, left(text, ${cut}) AS name, project_id FROM tracked_prompts
        WHERE workspace_id = app.current_workspace() AND deleted_at IS NULL AND status = 'active' AND ${IN_SCOPE("project_id")}
        ORDER BY created_at DESC, id DESC LIMIT $1`,
      [fetch],
    );

    const history = mayReadToolRuns(caller)
      ? await client.query<Row>(
          `SELECT id, left(coalesce(brand_name, tool_key), ${cut}) AS name, NULL::uuid AS project_id FROM tool_runs
            WHERE workspace_id = app.current_workspace()
            ORDER BY created_at DESC, id DESC LIMIT $1`,
          [fetch],
        )
      : { rows: [] as Row[] };

    const bounded = (kind: EntityIndexKind, rows: readonly Row[]): { entries: EntityIndexEntry[]; truncated: boolean } => ({
      entries: rows.slice(0, ENTITY_INDEX_LIMIT_PER_KIND).map((row) => ({ kind, id: row.id, name: row.name, project_id: row.project_id })),
      truncated: rows.length > ENTITY_INDEX_LIMIT_PER_KIND,
    });
    const p = bounded("project", projects.rows);
    const c = bounded("competitor", competitors.rows);
    const q = bounded("prompt", prompts.rows);
    const t = bounded("tool_run", history.rows);

    return {
      entities: [...p.entries, ...c.entries, ...q.entries, ...t.entries],
      limit_per_kind: ENTITY_INDEX_LIMIT_PER_KIND,
      truncated: { project: p.truncated, competitor: c.truncated, prompt: q.truncated, tool_run: t.truncated },
    };
  }

  /**
   * The ONE project a typed name or slug names, within the caller's scope; null when it names none or names
   * several (a guess between two projects could spend credits on the wrong one - the client disambiguates).
   */
  async bindProject(caller: CommandCaller, normalizedName: string): Promise<{ id: string; name: string } | null> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("EntityIndexService requires an active tenant context");
    if (scopedToNothing(caller)) return null;
    const found = await store.client.query<{ id: string; name: string }>(
      `SELECT id, name FROM projects
        WHERE workspace_id = app.current_workspace() AND deleted_at IS NULL AND ${IN_SCOPE("id")}
          AND (lower(name) = $1 OR slug = $1::citext)
        LIMIT 2`,
      [normalizedName],
    );
    return found.rows.length === 1 ? found.rows[0]! : null;
  }
}

function scopedToNothing(caller: CommandCaller): boolean {
  return caller.membership?.projectScope?.length === 0;
}

function mayReadToolRuns(caller: CommandCaller): boolean {
  const membership = caller.membership;
  if (membership === undefined) return false;
  const rule = evaluatePermission(membership.role, "lookup:read_history");
  if (rule.access === "deny") return false;
  // The tool-run list lets a scoped member through only with a non-empty scope (`@ScopedByQuery()`).
  return !(rule.access === "scoped" && membership.projectScope?.length === 0);
}

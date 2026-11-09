import type { ClientBase } from "pg";
import type { ResolvedEntitlementsResponse } from "../entitlements/resolution.js";
import { captureReadyEngineKeys } from "../engines/registry.js";
import { selectScanEngines } from "../visibility-scan/engine-set.js";

// STORY-079 / STORY-080 - FR-TL-07: the PLAN determines the Tools engine set, for every capture-backed tool alike. One reading, so a Visibility Scan and a Prompt
// Research run in the same workspace are answered by the same engines.

/** The plan's engine set, with display names, for the workspace the ambient transaction is scoped to. */
export async function toolsEngineSet(client: ClientBase, resolved: ResolvedEntitlementsResponse): Promise<{ engine_key: string; display_name: string }[]> {
  const size = Number(resolved.entitlements["tools.engine_set"]?.value);
  // The plan floor is compared in the database (plans.sort_order), exactly as the catalog's entitled-engines view does: no tier name is parsed in code.
  const rows = await client.query<{ key: string; display_name: string }>(
    `SELECT e.key, e.display_name
       FROM engines e
       JOIN plans floor ON floor.key = e.min_plan_key
       JOIN workspaces w ON w.id = app.current_workspace()
       JOIN plans own ON own.key = w.plan_key
      WHERE e.status = 'active' AND floor.sort_order <= own.sort_order`,
  );
  const names = new Map(rows.rows.map((row) => [row.key, row.display_name]));
  return selectScanEngines({ size: Number.isFinite(size) ? size : 0, entitled: [...names.keys()], captureReady: captureReadyEngineKeys() }).map((key) => ({ engine_key: key, display_name: names.get(key) ?? key }));
}

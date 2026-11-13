import { Injectable, Logger } from "@nestjs/common";
import type { ToolCatalogResponse } from "../../../contracts/tools/index.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { buildToolCatalog, gatedEntitlementKeys, TOOL_GATES, type UnlockPlan } from "../../lib/tools/tool-catalog.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore, type TenantContext } from "../../tenancy/tenant-context.js";

const logger = new Logger("tools.catalog");

// STORY-078 AC23 - the catalog of the six tools for the caller's plan. Free to read, writes nothing, calls nothing outside the database. `plans` is a global,
// versioned table (no tenant column), so the lowest-unlocking-plan read takes no workspace filter; the plan the caller is ON comes from the resolved entitlements.
@Injectable()
export class ToolCatalogService {
  constructor(private readonly entitlements: EntitlementResolver) {}

  async catalog(tenant: TenantContext): Promise<ToolCatalogResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ToolCatalogService requires an active tenant context");
    const resolved = await this.entitlements.resolveForWorkspace(tenant.workspaceId);
    const unlockers = new Map<string, UnlockPlan>();
    for (const key of gatedEntitlementKeys(TOOL_GATES)) {
      // Fail closed on what counts as granted: false, null and an absent entry all mean no (the same reading `auxAuditsIncluded` has).
      const lowest = await store.client.query<{ key: string; display_name: string }>(
        `SELECT key, display_name FROM plans WHERE (entitlements -> $1 -> 'value') NOT IN ('false'::jsonb, 'null'::jsonb) ORDER BY sort_order ASC LIMIT 1`,
        [key],
      );
      const row = lowest.rows[0];
      if (row !== undefined) unlockers.set(key, { key: row.key, display_name: row.display_name });
    }
    const response = buildToolCatalog({ entitlements: resolved.entitlements, gates: TOOL_GATES, unlockers });
    const disabled = response.tools.filter((t) => !t.enabled).length + response.tools.reduce((n, t) => n + t.modes.filter((m) => !m.enabled).length, 0);
    incrementCounter("nominara_tools_catalog_reads_total", { disabled: disabled > 0 ? "some" : "none" });
    logger.log({ event: "tools.catalog.read", workspace_id: tenant.workspaceId, disabled_count: disabled });
    return response;
  }
}

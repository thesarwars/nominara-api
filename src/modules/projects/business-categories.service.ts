import { Injectable } from "@nestjs/common";
import type { BusinessCategoriesResponse } from "../../../contracts/projects/index.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-189 — `GET /business-categories`: the taxonomy the category override picker lists. `business_categories` is GLOBAL (no workspace_id, no RLS, read-only to
// every runtime role), so there is no tenant predicate to add and nothing of any workspace in the body. Reads only this database.
@Injectable()
export class BusinessCategoriesService {
  async list(): Promise<BusinessCategoriesResponse> {
    const result = await currentTenantStore()!.client.query<BusinessCategoriesResponse["categories"][number]>(
      "SELECT slug, name, parent_slug, parent_name, description FROM business_categories ORDER BY slug",
    );
    // An empty taxonomy is a fault (a migration not applied), never an empty answer: the picker would offer nothing and say nothing.
    if (result.rows.length === 0) throw new Error("business_categories is empty");
    incrementCounter("nominara_business_categories_reads_total");
    return { categories: result.rows };
  }
}

import { Injectable, Logger } from "@nestjs/common";
import type { ProjectListItem } from "../../../contracts/projects/index.js";
import type {
  SummaryProject,
  WorkspaceSummaryResponse,
} from "../../../contracts/workspaces/workspace-summary-response.schema.js";
import { FeatureNotInPlanError } from "../../api/errors/domain-errors.js";
import { captureReadyEngineKeys } from "../../lib/engines/registry.js";
import { resolveEntitlements } from "../../lib/entitlements/resolution.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { BillingService } from "../billing/billing.service.js";
import { ProjectsService } from "../projects/projects.service.js";

// NEW-B-2 — `GET /v1/workspaces/{id}/summary`. FR-DASH-01 / STORY-089.
//
// A COMPOSITION, NOT A TABLE OWNER. The matrix is `ProjectsService`'s table,
// the wallet is `BillingService`'s, and the limits are the entitlement
// resolver's; this service imports the owners (coding-standards.md §1 "one
// table, one owning service") and joins what they return. It runs no SQL of
// its own, so the scoping that matters — `app.current_scope_projects()` — is
// applied once, inside `ProjectsService.listForSummary`, and everything here
// that counts (`projects_used`, `prompts_used`) counts THAT result. Counting
// from a second query would let the numbers disagree with the rows.
//
// SEQUENTIAL ON PURPOSE: every collaborator shares the request's one pg
// client, which queues rather than parallelises.

/** A limit the plan states as a figure. "custom", "uncapped" and the like are null: no numeric cap to render, which is not a cap of zero. */
function numericLimit(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

@Injectable()
export class WorkspaceSummaryService {
  private readonly logger = new Logger(WorkspaceSummaryService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly billing: BillingService,
  ) {}

  async summary(workspaceId: string): Promise<WorkspaceSummaryResponse> {
    const store = currentTenantStore()!;

    const { projects, engineKeys } = await this.projects.listForSummary();
    const resolved = await resolveEntitlements(store.client, workspaceId);

    // The Command Center health strip shows the balance, so it is read here —
    // but only the headline figures. The bucket split is `billing:read`'s
    // (wallet-response.schema.ts), and this route is `project:read`.
    let credits: WorkspaceSummaryResponse["health"]["credits"] = null;
    try {
      const wallet = await this.billing.wallet();
      credits = { available: wallet.available, expiring_soon: wallet.expiring_soon, cycle_end: wallet.cycle_end };
    } catch (error) {
      // ONLY the negotiated-grant case is "no figure". Anything else is a real
      // failure and propagates: a summary that hid a ledger discrepancy behind
      // `credits: null` would be swallowing an error to keep a happy path.
      if (!(error instanceof FeatureNotInPlanError)) throw error;
    }

    const live = new Set<string>(captureReadyEngineKeys());
    const dataSource = (engineKey: string): "live" | "demo" => (live.has(engineKey) ? "live" : "demo");

    const response: WorkspaceSummaryResponse = {
      workspace_id: workspaceId,
      plan_key: resolved.plan_key,
      window_days: 30,
      projects: projects.map((project) => withDataSources(project, dataSource)),
      engines: engineKeys.map((engineKey) => ({ engine_key: engineKey, data_source: dataSource(engineKey) })),
      health: {
        projects_used: projects.length,
        projects_limit: numericLimit(resolved.entitlements["projects.max"]?.value),
        prompts_used: projects.reduce((sum, project) => sum + project.prompts_active, 0),
        prompts_limit: numericLimit(resolved.entitlements["prompts.max_total"]?.value),
        credits,
      },
    };

    incrementCounter("nominara_workspace_summary_reads_total", { empty: String(projects.length === 0) });
    // The workspace ID, never its name; counts only.
    this.logger.log(`workspace ${workspaceId} summary: ${String(projects.length)} projects, ${String(engineKeys.length)} engines`);
    return response;
  }
}

function withDataSources(project: ProjectListItem, dataSource: (engineKey: string) => "live" | "demo"): SummaryProject {
  return {
    ...project,
    engine_scores:
      project.engine_scores === null
        ? null
        : project.engine_scores.map((score) => ({ ...score, data_source: dataSource(score.engine_key) })),
  };
}

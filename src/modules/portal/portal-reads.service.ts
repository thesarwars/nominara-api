import { Injectable, Logger } from "@nestjs/common";
import type { ScorecardEntry } from "../../../contracts/analytics/index.js";
import type {
  PortalGrowthMapQuery,
  PortalGrowthMapResponse,
  PortalMatrixResponse,
  PortalOverviewQuery,
  PortalOverviewResponse,
} from "../../../contracts/portal/index.js";
import type { ReportTimeframe } from "../../../contracts/reports/index.js";
import { selectPortalProject, type PortalSessionContext } from "../../api/decorators/portal-route.decorator.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { assertPortalTab, findCostFields, portalTimeframeDays, resolvePortalTimeframe, toPortalGrowthMap } from "../../lib/portal/portal-view.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { AgencyService } from "../agency/agency.service.js";
import { GrowthMapService } from "../analytics/growth-map.service.js";
import { ScorecardsService } from "../analytics/scorecards.service.js";
import { ProjectsService } from "../projects/projects.service.js";
import { MethodologyService } from "../reports/methodology.service.js";
import { WorkspacesService } from "../workspaces/workspaces.service.js";
import { PortalCache, portalCacheKey } from "./portal-cache.js";

// NEW-E-099a — the portal's three read endpoints (STORY-099 part A).
//
// THIS SERVICE FORKS NOTHING. The figures come from ScorecardsService and GrowthMapService, the footer from
// MethodologyService, the theme from AgencyService: the portal is a different PROJECTION of the same reads, with its
// own rules (scope, hiding, lock, cache) applied here and in lib/portal/portal-view.ts. Every query runs on the ambient
// transaction PortalContextInterceptor opened on the `nominara_portal` pool, READ ONLY, with the workspace and scope
// GUCs set from the cookie: RLS enforces scope independently of anything below.
//
// Scope and settings come from the SESSION (cookie scope; the token row's policy, re-read on this very request) and
// never from the request. `?project=` is a selector intersected with the scope, and `?timeframe=` cannot widen a lock.
//
// Tracing: OpenTelemetry spans are DEFERRED to week 2 by owner decision. This story ships the counter and the redacted
// log line below; a missing span is not a failed criterion this week.
const logger = new Logger("PortalReadsService");

// The agency-side query types carry a defaulted `timeframe` the portal replaces with an explicit day count, so this
// value is never what sets the window — `days` is.
const WINDOW_PLACEHOLDER = "30d" as const;

type Tab = "overview" | "growth_map" | "matrix";

@Injectable()
export class PortalReadsService {
  private readonly cache = new PortalCache();

  constructor(
    private readonly scorecards: ScorecardsService,
    private readonly growthMaps: GrowthMapService,
    private readonly methodology: MethodologyService,
    private readonly agency: AgencyService,
    private readonly workspaces: WorkspacesService,
    private readonly projects: ProjectsService,
  ) {}

  async overview(session: PortalSessionContext, query: PortalOverviewQuery): Promise<PortalOverviewResponse> {
    assertPortalTab(session, "overview");
    const timeframe = resolvePortalTimeframe(query.timeframe, session.policy.timeframeLock);
    return this.cached(session, "overview", "all", timeframe, async () => {
      const days = portalTimeframeDays(timeframe);
      const names = await this.projects.namesFor(session.scopeProjectIds);
      const projects: PortalOverviewResponse["projects"] = [];
      // Scope order is the token's order; a project the database does not show (deleted, or outside the workspace) is absent.
      for (const id of session.scopeProjectIds) {
        const name = names.get(id);
        if (name === undefined) continue;
        const cards = await this.scorecards.scorecards(id, { timeframe: WINDOW_PLACEHOLDER }, { days });
        const blended = cards.blended;
        projects.push({
          id,
          name,
          visibility: blended.visibility_score,
          delta: blended.visibility_delta,
          confidence: blended.confidence,
          sentiment: blended.metrics.sentiment_score,
          citations: blended.metrics.citations_total,
          // The footer is built here, unconditionally, from the same builder the export uses: no theme or token setting reaches it.
          footer: await this.methodology.footer(id, { timeframe }),
        });
      }
      return {
        agency: await this.workspaces.displayName(),
        theme: await this.agency.themeForPortal(session.themeId),
        label: session.policy.label,
        tabs: session.scopeTabs as PortalOverviewResponse["tabs"],
        hide_competitors: session.policy.hideCompetitors,
        hide_costs: session.policy.hideCosts,
        timeframe,
        timeframe_locked: session.policy.timeframeLock !== null,
        projects,
      };
    });
  }

  async growthMap(session: PortalSessionContext, query: PortalGrowthMapQuery): Promise<PortalGrowthMapResponse> {
    assertPortalTab(session, "growth_map");
    const project = selectPortalProject(session, query.project);
    const timeframe = resolvePortalTimeframe(query.timeframe, session.policy.timeframeLock);
    return this.cached(session, "growth_map", project, timeframe, async () => {
      const source = await this.growthMaps.growthMap(
        project,
        { timeframe: WINDOW_PLACEHOLDER, granularity: "day" },
        { days: portalTimeframeDays(timeframe), portal: { hideCompetitors: session.policy.hideCompetitors } },
      );
      return toPortalGrowthMap(source, { hideCompetitors: session.policy.hideCompetitors });
    });
  }

  async matrix(session: PortalSessionContext, query: PortalGrowthMapQuery): Promise<PortalMatrixResponse> {
    assertPortalTab(session, "matrix");
    const project = selectPortalProject(session, query.project);
    const timeframe = resolvePortalTimeframe(query.timeframe, session.policy.timeframeLock);
    return this.cached(session, "matrix", project, timeframe, async () => {
      const cards = await this.scorecards.scorecards(project, { timeframe: WINDOW_PLACEHOLDER }, { days: portalTimeframeDays(timeframe) });
      return { engines: cards.engines.map(toMatrixEngine) };
    });
  }

  // The per-token cache (NFR-AGY-03/04). It sits AFTER the interceptor's per-request liveness check, its key carries the
  // token id and a fingerprint of the token's policy, and under hide_costs the payload is scanned before it is stored or
  // served: a cost-side field reaching this point is a defect, so it fails closed rather than leaks.
  private async cached<T extends object>(session: PortalSessionContext, tab: Tab, project: string, timeframe: ReportTimeframe, compute: () => Promise<T>): Promise<T> {
    const started = Date.now();
    let computed = false;
    const key = portalCacheKey(cacheKeyNamespace(), {
      workspaceId: session.workspaceId,
      tokenId: session.tokenId,
      route: tab,
      project,
      timeframe,
      policy: policyFingerprint(session),
    });
    const value = await this.cache.getOrCompute(key, async () => {
      computed = true;
      const fresh = await compute();
      if (session.policy.hideCosts) {
        const leaked = findCostFields(fresh);
        if (leaked.length > 0) throw new Error(`portal ${tab} payload carries cost-side fields under hide_costs: ${leaked.join(", ")}`);
      }
      return fresh;
    });
    incrementCounter("nominara_portal_reads_total", { tab, cache: computed ? "miss" : "hit" });
    // Workspace and token IDs only: no workspace name, no label, no figure, no engine text.
    logger.log({ span: "portal.read", workspace_id: session.workspaceId, token_id: session.tokenId, tab, cache: computed ? "miss" : "hit", duration_ms: Date.now() - started });
    return value;
  }
}

function policyFingerprint(session: PortalSessionContext): string {
  const { hideCompetitors, hideCosts, timeframeLock } = session.policy;
  return `hc${hideCompetitors ? "1" : "0"}-hk${hideCosts ? "1" : "0"}-lock${timeframeLock ?? "none"}-theme${session.themeId ?? "none"}`;
}

function toMatrixEngine(entry: ScorecardEntry): PortalMatrixResponse["engines"][number] {
  return {
    engine_key: entry.engine_key,
    // Null = nothing measured; an absent marker is not "demo".
    data_source: entry.data_source ?? null,
    visibility_score: entry.visibility_score,
    presence_rate: entry.metrics.presence_rate,
    share_of_voice: entry.metrics.share_of_voice,
  };
}

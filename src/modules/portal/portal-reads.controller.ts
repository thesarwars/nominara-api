import { Controller, Get, Query } from "@nestjs/common";
import {
  portalGrowthMapResponseSchema,
  portalMatrixResponseSchema,
  portalOverviewQuerySchema,
  portalOverviewResponseSchema,
  portalProjectQuerySchema,
  portalSourcesQuerySchema,
  portalSourcesResponseSchema,
  portalTasksQuerySchema,
  portalTasksResponseSchema,
  type PortalSourcesQuery,
  type PortalSourcesResponse,
  type PortalTasksQuery,
  type PortalTasksResponse,
  type PortalGrowthMapQuery,
  type PortalGrowthMapResponse,
  type PortalMatrixResponse,
  type PortalOverviewQuery,
  type PortalOverviewResponse,
} from "../../../contracts/portal/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { PortalRoute, PortalSession, type PortalSessionContext } from "../../api/decorators/portal-route.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { PortalReadsService } from "./portal-reads.service.js";

// NEW-E-099a — integrations-and-sharing.md §3 `GET /portal/*`. GET ONLY, by construction: this controller declares no
// other verb, so every POST/PUT/PATCH/DELETE under /portal/* (the session mint aside) is an unknown route. Auth is the
// portal cookie and nothing else (@PortalRoute); the interceptor runs before the query pipes, so an unauthenticated
// request is a 401 before any validation or data.
@Controller("portal")
export class PortalReadsController {
  constructor(private readonly reads: PortalReadsService) {}

  @Get("overview")
  @PortalRoute()
  @ApiContract({ operationId: "getPortalOverview", querySchema: portalOverviewQuerySchema, responseSchema: portalOverviewResponseSchema })
  overview(
    @PortalSession() session: PortalSessionContext,
    @Query(new ZodValidationPipe(portalOverviewQuerySchema)) query: PortalOverviewQuery,
  ): Promise<PortalOverviewResponse> {
    return this.reads.overview(session, query);
  }

  @Get("growth-map")
  @PortalRoute()
  @ApiContract({ operationId: "getPortalGrowthMap", querySchema: portalProjectQuerySchema, responseSchema: portalGrowthMapResponseSchema })
  growthMap(
    @PortalSession() session: PortalSessionContext,
    @Query(new ZodValidationPipe(portalProjectQuerySchema)) query: PortalGrowthMapQuery,
  ): Promise<PortalGrowthMapResponse> {
    return this.reads.growthMap(session, query);
  }

  @Get("matrix")
  @PortalRoute()
  @ApiContract({ operationId: "getPortalMatrix", querySchema: portalProjectQuerySchema, responseSchema: portalMatrixResponseSchema })
  matrix(
    @PortalSession() session: PortalSessionContext,
    @Query(new ZodValidationPipe(portalProjectQuerySchema)) query: PortalGrowthMapQuery,
  ): Promise<PortalMatrixResponse> {
    return this.reads.matrix(session, query);
  }

  @Get("tasks")
  @PortalRoute()
  @ApiContract({ operationId: "getPortalTasks", querySchema: portalTasksQuerySchema, responseSchema: portalTasksResponseSchema })
  tasks(
    @PortalSession() session: PortalSessionContext,
    @Query(new ZodValidationPipe(portalTasksQuerySchema)) query: PortalTasksQuery,
  ): Promise<PortalTasksResponse> {
    return this.reads.tasks(session, query);
  }

  // Decision 83 (c) — the Sources tab. Read-only like every route here; the database narrows scope (portal_scope_source_domains).
  @Get("sources")
  @PortalRoute()
  @ApiContract({ operationId: "getPortalSources", querySchema: portalSourcesQuerySchema, responseSchema: portalSourcesResponseSchema })
  sources(
    @PortalSession() session: PortalSessionContext,
    @Query(new ZodValidationPipe(portalSourcesQuerySchema)) query: PortalSourcesQuery,
  ): Promise<PortalSourcesResponse> {
    return this.reads.sources(session, query);
  }
}

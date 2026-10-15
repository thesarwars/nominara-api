import { Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  runProgressResponseSchema,
  runUndoResponseSchema,
  type RunProgressResponse,
  type RunUndoResponse,
} from "../../../contracts/tracking/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";
import { RunLifecycleService } from "./run-lifecycle.service.js";

// STORY-034 — §3's Tracking table, the run-scoped half.
//
// A SEPARATE CONTROLLER BECAUSE THE PATHS ARE SEPARATE. §3 writes `GET
// /runs/{id}` and `POST /runs/{id}/cancel` at the root, not under the
// project: a run id is globally unique and a client holding one from a
// realtime event does not necessarily know which project it belongs to.
// Nesting them under `/projects/{id}` would force that lookup on the client
// for no gain — RLS scopes the tenant either way.
@Controller("runs")
export class RunsController {
  constructor(private readonly lifecycle: RunLifecycleService) {}

  // `tracking:read`, which analysts and viewers have. Watching a scan is not
  // the same permission as starting one.
  @Get(":id")
  @RequirePermission("tracking:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getRun", responseSchema: runProgressResponseSchema })
  progress(@Param("id") runId: string): Promise<RunProgressResponse> {
    return this.lifecycle.progress(runId);
  }

  // 200: the cancellation is complete when this returns. The row says
  // `canceled` and no further result will be recorded against the run —
  // draining the queue is cleanup that costs nothing if it lags.
  //
  // No `@Idempotent()`. §3 marks the route neither `✚` nor `¢`, and a repeat
  // is refused by the status check rather than replayed: a second cancel of
  // an already-cancelled run is a `409`, which is the honest answer.
  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("tracking:trigger")
  @ScopedByQuery()
  @Audit({ action: "run.canceled", resourceType: "capture_run" })
  @ApiContract({ operationId: "cancelRun", responseSchema: runProgressResponseSchema })
  cancel(@Param("id") runId: string): Promise<RunProgressResponse> {
    return this.lifecycle.cancel(runId);
  }

  // STORY-074 AC8 — the five-second undo.
  //
  // ⚠ IT REFUNDS RATHER THAN RELEASING, because there is nothing left to
  // release: `CreditInterceptor` commits when the handler returns and the 202
  // arrives with cells already dispatched. See `lib/credits/undo.ts`.
  //
  // 200 EVEN WHEN IT REFUSES. "Disabled with an explanation" needs the
  // explanation and the run's state to render it; a 409 carrying neither
  // would send the client back for another round trip to find out what
  // happened. Nothing went wrong — the answer is no.
  //
  // `tracking:trigger` rather than a billing permission: undoing your own
  // scan is part of running one, and anyone who could start it can stop it.
  @Post(":id/undo")
  @HttpCode(200)
  @RequirePermission("tracking:trigger")
  @ScopedByQuery()
  @Audit({ action: "run.undone", resourceType: "capture_run" })
  @ApiContract({ operationId: "undoRun", responseSchema: runUndoResponseSchema })
  undo(@Req() req: RbacScopedRequest, @Param("id") runId: string): Promise<RunUndoResponse> {
    return this.lifecycle.undo(runId, req.auth?.sub ?? null);
  }
}

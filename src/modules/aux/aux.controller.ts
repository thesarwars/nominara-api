import { Body, Controller, Get, Param, Patch, Query } from "@nestjs/common";
import {
  auxAuditListQuerySchema,
  auxAuditSchema,
  auxFindingListQuerySchema,
  auxFindingSchema,
  auxPatchSchema,
  updateAuxFindingRequestSchema,
  type AuxAudit,
  type AuxAuditListQuery,
  type AuxFinding,
  type AuxFindingListQuery,
  type AuxPatch,
  type UpdateAuxFindingRequest,
} from "../../../contracts/aux/index.js";
import type { Page } from "../../api/pagination/page.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { AuxService } from "./aux.service.js";

// A controller resolves the request, calls one service method, and returns —
// no logic here (coding-standards.md §1). Mounted at the root so the paths are
// the reference's (api-specification.md "AUX").
//
// There is deliberately no route that can set `resolved`: PATCH names it only so
// the refusal is a 422 that says why.
@Controller()
export class AuxController {
  constructor(private readonly service: AuxService) {}

  @Get("aux-audits/:id")
  @RequirePermission("aux:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getAuxAudit", responseSchema: auxAuditSchema })
  getAudit(@Param("id") id: string): Promise<AuxAudit> {
    return this.service.getAudit(id);
  }

  // Not in the reference: "the latest audit" (`?limit=1`) for the AUX Health page.
  @Get("projects/:id/aux-audits")
  @RequirePermission("aux:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "listProjectAuxAudits", querySchema: auxAuditListQuerySchema, responseSchema: auxAuditSchema, listOf: true })
  listProjectAudits(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(auxAuditListQuerySchema)) query: AuxAuditListQuery,
  ): Promise<Page<AuxAudit>> {
    return this.service.listProjectAudits(id, query);
  }

  @Get("projects/:id/aux-findings")
  @RequirePermission("aux:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "listProjectAuxFindings", querySchema: auxFindingListQuerySchema, responseSchema: auxFindingSchema, listOf: true })
  listProjectFindings(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(auxFindingListQuerySchema)) query: AuxFindingListQuery,
  ): Promise<Page<AuxFinding>> {
    return this.service.listProjectFindings(id, query);
  }

  // STORY-053: a patch is made by the audit and read here; there is no route that creates, regenerates or edits one. The URL names a
  // patch, not a project: scope is enforced by the service against the patch's project (403 out-of-scope).
  @Get("patches/:id")
  @RequirePermission("aux:read")
  @ScopedByQuery()
  @ApiContract({ operationId: "getAuxPatch", responseSchema: auxPatchSchema })
  getPatch(@Param("id") id: string): Promise<AuxPatch> {
    return this.service.getPatch(id);
  }

  // The URL names a finding, not a project: scope is enforced by the service
  // against the finding's project (403 out-of-scope), as PATCH /tasks/{id} does.
  @Patch("aux-findings/:id")
  @RequirePermission("task:create")
  @ScopedByQuery()
  @Audit({ action: "aux_finding.updated", resourceType: "aux_finding" })
  @ApiContract({ operationId: "updateAuxFinding", requestSchema: updateAuxFindingRequestSchema, responseSchema: auxFindingSchema })
  updateFinding(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateAuxFindingRequestSchema)) body: UpdateAuxFindingRequest,
  ): Promise<AuxFinding> {
    return this.service.updateFinding(id, body);
  }
}

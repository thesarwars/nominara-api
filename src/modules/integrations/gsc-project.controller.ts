import { Controller, Get, Param } from "@nestjs/common";
import { gscProjectConnectionSchema, type GscProjectConnection } from "../../../contracts/integrations/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { ProjectParam } from "../../api/decorators/project-param.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { GscService } from "./gsc.service.js";

// STORY-115 - `GET /projects/{id}/gsc`: finds the project's active Search Console connection so a client can call the `/integrations/gsc/{id}`
// routes. Same rule as the sibling `GET /integrations/gsc/{id}` (`project:read`, no plan gate: a downgraded workspace can still see its connection's health).
@Controller("projects/:id/gsc")
export class GscProjectController {
  constructor(private readonly gsc: GscService) {}

  @Get()
  @RequirePermission("project:read")
  @ProjectParam("id")
  @ApiContract({ operationId: "getProjectGscConnection", responseSchema: gscProjectConnectionSchema })
  find(@Param("id") projectId: string): Promise<GscProjectConnection> {
    return this.gsc.findForProject(projectId);
  }
}

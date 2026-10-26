import { Body, Controller, Get, HttpCode, Put, Query } from "@nestjs/common";
import {
  agencyThemeListQuerySchema,
  agencyThemeListResponseSchema,
  agencyThemeAdminSchema,
  updateAgencyThemeRequestSchema,
  type AgencyThemeAdmin,
  type AgencyThemeListQuery,
  type UpdateAgencyThemeRequest,
} from "../../../contracts/agency/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import type { Page } from "../../api/pagination/page.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { AgencyService } from "./agency.service.js";

// STORY-097 — api-specification.md §3: GET/PUT /agency/theme, `agency:branding`,
// "contrast validated server-side on save". The validation lives in the
// service, so nothing here can be skipped by a client that skips the editor.
@Controller("agency")
export class AgencyController {
  constructor(private readonly service: AgencyService) {}

  @Get("theme")
  @RequirePermission("agency:branding")
  @ApiContract({ operationId: "listAgencyThemes", querySchema: agencyThemeListQuerySchema, responseSchema: agencyThemeListResponseSchema, listOf: true })
  list(@Query(new ZodValidationPipe(agencyThemeListQuerySchema)) query: AgencyThemeListQuery): Promise<Page<AgencyThemeAdmin>> {
    return this.service.listThemes(query);
  }

  // Every theme write is audited (FR-AGY-01 / scenario 16). The audit row is
  // written in the same transaction as the write, so neither can exist alone.
  @Put("theme")
  @HttpCode(200)
  @RequirePermission("agency:branding")
  @Audit({ action: "agency.theme_updated", resourceType: "theme", resourceIdFrom: "response" })
  @ApiContract({
    operationId: "saveAgencyTheme",
    requestSchema: updateAgencyThemeRequestSchema,
    responseSchema: agencyThemeAdminSchema,
  })
  save(@Body(new ZodValidationPipe(updateAgencyThemeRequestSchema)) body: UpdateAgencyThemeRequest): Promise<AgencyThemeAdmin> {
    return this.service.saveTheme(body);
  }
}

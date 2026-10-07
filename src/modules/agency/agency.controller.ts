import { Body, Controller, Get, HttpCode, Put } from "@nestjs/common";
import {
  agencyThemeListResponseSchema,
  agencyThemeSchema,
  updateAgencyThemeRequestSchema,
  type AgencyTheme,
  type UpdateAgencyThemeRequest,
} from "../../../contracts/agency/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
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
  @ApiContract({ operationId: "listAgencyThemes", responseSchema: agencyThemeListResponseSchema })
  list(): Promise<AgencyTheme[]> {
    return this.service.listThemes();
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
    responseSchema: agencyThemeSchema,
  })
  save(@Body(new ZodValidationPipe(updateAgencyThemeRequestSchema)) body: UpdateAgencyThemeRequest): Promise<AgencyTheme> {
    return this.service.saveTheme(body);
  }
}

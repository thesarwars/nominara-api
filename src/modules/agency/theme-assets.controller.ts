import { Body, Controller, Get, Header, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { FastifyReply } from "fastify";
import type { AuditableRequest } from "../../api/interceptors/audit.interceptor.js";
import {
  MAX_THEME_ASSET_BASE64_LENGTH,
  themeAssetFetchParamsSchema,
  themeAssetParamsSchema,
  uploadThemeAssetRequestSchema,
  uploadThemeAssetResponseSchema,
  type ThemeAssetFetchParams,
  type ThemeAssetParams,
  type UploadThemeAssetRequest,
  type UploadThemeAssetResponse,
} from "../../../contracts/agency/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ThemeAssetsService } from "./theme-assets.service.js";

// STORY-097 · owner decision 67 (n) — logo and favicon upload, and the platform-origin route that serves them.
// The body limit is this route's own (a 1 MiB image is ~1.4 MB of base64, above Fastify's 1 MiB default): see src/api/route-body-limit.ts.
@Controller("themes")
export class ThemeAssetsController {
  constructor(private readonly service: ThemeAssetsService) {}

  @Post(":id/assets")
  @HttpCode(201)
  @RequirePermission("agency:branding")
  @RouteConfig({ bodyLimit: MAX_THEME_ASSET_BASE64_LENGTH + 4096 })
  // The interceptor row records the accepted REQUEST (it commits with the request transaction, before the storage write). The outcome row,
  // agency.theme_asset_uploaded, is written by ThemeAssetsService in the transaction that records the key.
  @Audit({ action: "agency.theme_asset_upload_requested", resourceType: "theme" })
  @ApiContract({
    operationId: "uploadThemeAsset",
    paramsSchema: themeAssetParamsSchema,
    requestSchema: uploadThemeAssetRequestSchema,
    responseSchema: uploadThemeAssetResponseSchema,
  })
  upload(
    @Param(new ZodValidationPipe(themeAssetParamsSchema)) params: ThemeAssetParams,
    @Body(new ZodValidationPipe(uploadThemeAssetRequestSchema)) body: UploadThemeAssetRequest,
    @Req() req: AuditableRequest,
  ): Promise<UploadThemeAssetResponse> {
    return this.service.upload(params, body, req);
  }

  // The Location is a short-lived credential: never cached, never leaked in a Referer.
  @Get(":id/assets/:slot")
  @HttpCode(302)
  @RequirePermission("agency:branding")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiContract({ operationId: "fetchThemeAsset", paramsSchema: themeAssetFetchParamsSchema, redirect: true })
  async fetch(@Param(new ZodValidationPipe(themeAssetFetchParamsSchema)) params: ThemeAssetFetchParams, @Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    await this.service.resolve(params, (url) => void reply.header("location", url));
  }
}

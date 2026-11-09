import { Body, Controller, Header, HttpCode, Options, Post, Req } from "@nestjs/common";
import { RouteConfig } from "@nestjs/platform-fastify";
import type { FastifyRequest } from "fastify";
import {
  INGEST_BODY_LIMIT_BYTES,
  ingestAttributionRequestSchema,
  ingestAttributionResponseSchema,
  type IngestAttributionRequest,
  type IngestAttributionResponse,
} from "../../../contracts/attribution/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Public } from "../../api/decorators/public.decorator.js";
import { SkipTenantContext } from "../../api/decorators/skip-tenant-context.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { AttributionIngestService } from "./attribution-ingest.service.js";

const headerOf = (value: string | string[] | undefined): string | undefined => (typeof value === "string" ? value : undefined);

// STORY-113 - the public beacon. No session: the site token in the body names the configuration, and the Origin header is checked
// against its allow-list. Tenant-less (the workspace comes from the token and only selects row-level security). The body is capped by
// Fastify before it is parsed. No logic here.
@Controller("ingest/attribution")
export class AttributionIngestController {
  constructor(private readonly ingest: AttributionIngestService) {}

  // The browser's CORS preflight carries no token, so it cannot be answered per configuration; it grants nothing but the right to
  // attempt the POST, which is origin-checked. Static headers, no handler logic.
  @Options()
  @HttpCode(204)
  @Public()
  @SkipTenantContext()
  @Header("Access-Control-Allow-Origin", "*")
  @Header("Access-Control-Allow-Methods", "POST")
  @Header("Access-Control-Allow-Headers", "content-type")
  @Header("Access-Control-Max-Age", "86400")
  @ApiContract({ operationId: "preflightIngestAttribution", voidResponse: true })
  preflight(): void {
    return;
  }

  @Post()
  @HttpCode(202)
  @Public()
  @SkipTenantContext()
  @Header("Access-Control-Allow-Origin", "*")
  @RouteConfig({ bodyLimit: INGEST_BODY_LIMIT_BYTES })
  @ApiContract({ operationId: "ingestAttribution", requestSchema: ingestAttributionRequestSchema, responseSchema: ingestAttributionResponseSchema })
  receive(
    @Req() req: FastifyRequest,
    @Body(new ZodValidationPipe(ingestAttributionRequestSchema)) body: IngestAttributionRequest,
  ): Promise<IngestAttributionResponse> {
    return this.ingest.ingest(body, {
      origin: headerOf(req.headers.origin),
      userAgent: headerOf(req.headers["user-agent"]),
      countryHeader: headerOf(req.headers["cf-ipcountry"]),
    });
  }
}

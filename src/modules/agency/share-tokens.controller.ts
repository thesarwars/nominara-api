import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import {
  mintedShareTokenSchema,
  mintShareTokenRequestSchema,
  shareTokenListResponseSchema,
  shareTokenSchema,
  shareTokenViewListResponseSchema,
  type MintedShareToken,
  type MintShareTokenRequest,
  type ShareToken,
  type ShareTokenView,
} from "../../../contracts/agency/index.js";
import { ApiContract } from "../../api/decorators/api-contract.decorator.js";
import { Audit } from "../../api/decorators/audit.decorator.js";
import { RequireFeature } from "../../api/decorators/require-entitlement.decorator.js";
import { RequirePermission } from "../../api/decorators/require-permission.decorator.js";
import { ScopedByQuery } from "../../api/decorators/scoped-by-query.decorator.js";
import { ZodValidationPipe } from "../../api/pipes/zod-validation.pipe.js";
import { ShareTokensService, type AuditRequestMeta } from "./share-tokens.service.js";

const idPipe = new ZodValidationPipe(z.uuid());

interface RequestLike {
  readonly ip?: string;
  readonly id?: unknown;
  readonly headers: Record<string, string | string[] | undefined>;
}

function metaOf(req: RequestLike): AuditRequestMeta {
  const ua = req.headers["user-agent"];
  return { ip: req.ip ?? null, userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null), requestId: req.id !== undefined ? String(req.id) : "" };
}

// STORY-098 part A — api-specification.md §3 share-token routes. The matrix
// has only share_token:mint / share_token:revoke, so reads (list, views) sit
// behind `share_token:mint`: whoever may create a link may see its use.
// `@ScopedByQuery()` lets a project-scoped manager reach the handler; the
// service then narrows to their scope.
@Controller("share-tokens")
export class ShareTokensController {
  constructor(private readonly service: ShareTokensService) {}

  @Get()
  @RequirePermission("share_token:mint")
  @ScopedByQuery()
  @ApiContract({ operationId: "listShareTokens", responseSchema: shareTokenListResponseSchema })
  list(): Promise<ShareToken[]> {
    return this.service.list();
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("share_token:mint")
  @ScopedByQuery()
  @RequireFeature("share_links.enabled")
  @Audit({ action: "share_token.minted", resourceType: "share_token", resourceIdFrom: "response", responseIdPath: "token.id" })
  @ApiContract({ operationId: "mintShareToken", requestSchema: mintShareTokenRequestSchema, responseSchema: mintedShareTokenSchema })
  mint(
    @Body(new ZodValidationPipe(mintShareTokenRequestSchema)) body: MintShareTokenRequest,
    @Req() req: RequestLike,
  ): Promise<MintedShareToken> {
    return this.service.mint(body, metaOf(req));
  }

  @Delete(":id")
  @HttpCode(200)
  @RequirePermission("share_token:revoke")
  @ScopedByQuery()
  @Audit({ action: "share_token.revoked", resourceType: "share_token" })
  @ApiContract({ operationId: "revokeShareToken", responseSchema: shareTokenSchema })
  revoke(@Param("id", idPipe) id: string): Promise<ShareToken> {
    return this.service.revoke(id);
  }

  @Get(":id/views")
  @RequirePermission("share_token:mint")
  @ScopedByQuery()
  @ApiContract({ operationId: "listShareTokenViews", responseSchema: shareTokenViewListResponseSchema })
  views(@Param("id", idPipe) id: string): Promise<ShareTokenView[]> {
    return this.service.views(id);
  }
}

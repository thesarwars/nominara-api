import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import {
  styleRefusalDetailsSchema,
  type ThemeAssetFetchParams,
  type ThemeAssetParams,
  type UploadThemeAssetRequest,
  type UploadThemeAssetResponse,
} from "../../../contracts/agency/index.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { requestAuditActorOf, type AuditableRequest } from "../../api/interceptors/audit.interceptor.js";
import { afterTransaction } from "../../api/after-transaction.js";
import { DegradedError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { validateThemeAsset, type ThemeAssetType } from "../../lib/theme/asset-limits.js";
import { isStoredObjectKey } from "../../lib/reports/artifact-key.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { AgencyService, themeAssetPath } from "./agency.service.js";

// STORY-097 AC "Assets" · owner decision 67 (n). POST /v1/themes/{id}/assets and GET /v1/themes/{id}/assets/{slot}.
//
// The upload is validated on its BYTES (asset-limits.ts: PNG/JPEG/WebP, <= 1 MiB, logo <= 1200x400, favicon square <= 100 KB; an SVG is
// refused) and the theme is checked against the caller's workspace on the ambient request client (RLS). The STORAGE write and the
// brand_themes update then run AFTER the request transaction has committed and released its connection (afterTransaction, ADR-0003):
// no transaction is held across the object-store call (KAD-06). The object is written FIRST and the key recorded second, so a row
// never points at a missing object; a failed write fails the response (503/500), it is never swallowed. The superseded object is
// deleted last and best-effort (an orphan is a leak of a few KB, never a broken theme).
//
// The stored file is served by a route on the platform's own origin that answers 302 to a short presign (60 s), minted fresh on every
// fetch. The theme carries the platform path, never the key, the bucket host or the URL.

export const THEME_ASSET_URL_SECONDS = 60;
const logger = new Logger("ThemeAssets");
const EXTENSION: Readonly<Record<ThemeAssetType, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

@Injectable()
export class ThemeAssetsService {
  constructor(
    private readonly agency: AgencyService,
    private readonly objects: TenantObjectStore,
    private readonly auditChain: AuditChainService,
  ) {}

  async upload(params: ThemeAssetParams, body: UploadThemeAssetRequest, req: AuditableRequest): Promise<UploadThemeAssetResponse> {
    const started = Date.now();
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ThemeAssetsService requires an active tenant context");
    const { context } = store;
    const actor = requestAuditActorOf(req);
    // 404 for an unknown or foreign theme before any byte is looked at (RLS hides the other workspace's row).
    await this.agency.assetKey(params.id, body.slot);

    const bytes = new Uint8Array(Buffer.from(body.data_base64, "base64"));
    const checked = validateThemeAsset(body.slot, body.content_type, bytes);
    if (!checked.ok) {
      for (const r of checked.refused) incrementCounter("nominara_theme_asset_refusals_total", { slot: body.slot, construct: r.construct });
      logger.warn({ span: "agency.theme_asset", workspace_id: context.workspaceId, slot: body.slot, outcome: "refused", constructs: checked.refused.map((r) => r.construct) });
      throw new ValidationFailedError({
        message: "the " + body.slot + " asset was refused: " + checked.refused.map((r) => r.message).join("; "),
        details: styleRefusalDetailsSchema.parse({ issues: checked.refused.map((r) => ({ path: ["data_base64"], message: r.message })), refused: checked.refused }),
      });
    }

    const relative = "branding/" + params.id + "/" + body.slot + "-" + randomUUID() + "." + EXTENSION[checked.contentType];
    const bound = this.objects.bind();
    const registered = afterTransaction(async () => {
      let outcome = "error";
      try {
        const key = await bound.put("reports", relative, checked.bytes, { contentType: checked.contentType });
        let previous: string | null;
        try {
          // The success audit row shares the key's transaction: the log says "uploaded" only if the theme now points at the object.
          previous = await this.agency.recordAssetKey(context, params.id, body.slot, key, async (tx) => {
            await this.auditChain.append(tx, {
              workspaceId: context.workspaceId,
              actorType: actor.actorType,
              actorId: context.actorId,
              actorIp: actor.ip,
              actorUa: actor.ua,
              action: "agency.theme_asset_uploaded",
              resourceType: "theme",
              resourceId: params.id,
              beforeState: null,
              afterState: { slot: body.slot, content_type: checked.contentType, bytes: checked.bytes.length },
              requestId: actor.requestId,
              supportGrantId: actor.supportGrantId,
              severity: "info",
            });
          });
        } catch (error) {
          // The object was written but no row points at it (the theme went away, or the database is down): remove it, best-effort.
          await bound.deleteStored("reports", key).catch(() => {
            incrementCounter("nominara_theme_asset_orphans_total", { slot: body.slot });
          });
          throw error;
        }
        outcome = "stored";
        if (previous !== null && previous !== key && isStoredObjectKey(previous)) {
          await bound.deleteStored("reports", previous).catch(() => {
            incrementCounter("nominara_theme_asset_orphans_total", { slot: body.slot });
          });
        }
      } finally {
        incrementCounter("nominara_theme_asset_uploads_total", { slot: body.slot, outcome });
        // Workspace ID, slot and outcome only: never the key, the file's content or the theme's name.
        logger.log({ span: "agency.theme_asset", workspace_id: context.workspaceId, slot: body.slot, outcome, bytes: checked.bytes.length, duration_ms: Date.now() - started });
      }
    });
    // Fail closed: with no request transaction to wait for, the file would never be stored.
    if (!registered) throw new Error("ThemeAssetsService requires a request transaction to run after");

    return {
      theme_id: params.id,
      slot: body.slot,
      url: themeAssetPath(params.id, body.slot),
      content_type: checked.contentType as UploadThemeAssetResponse["content_type"],
      width: checked.width,
      height: checked.height,
      bytes: checked.bytes.length,
    };
  }

  /** Looks the key up on the ambient client, then presigns once the request transaction has ended (no connection held over the SDK call). */
  async resolve(params: ThemeAssetFetchParams, setLocation: (url: string) => void): Promise<void> {
    const key = await this.agency.assetKey(params.id, params.slot);
    if (key === null) throw new NotFoundError({ message: "no such asset" });
    if (!isStoredObjectKey(key)) throw new DegradedError({ message: "the asset is not available" });
    const bound = this.objects.bind();
    const registered = afterTransaction(async () => {
      setLocation(await bound.presignGetStored("reports", key, { expiresInSeconds: THEME_ASSET_URL_SECONDS }));
      incrementCounter("nominara_theme_asset_fetches_total", { slot: params.slot });
    });
    if (!registered) throw new Error("ThemeAssetsService requires a request transaction to run after");
  }
}

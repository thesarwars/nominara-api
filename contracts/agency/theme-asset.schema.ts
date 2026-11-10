import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-097 AC "Assets" · owner decision 67 (n) — POST /v1/themes/{id}/assets and the route that serves the stored file.
//
// A request carries the file as base64 in a JSON body (no multipart dependency). The file's size, type and dimensions are checked
// against the BYTES by the service (src/lib/theme/asset-limits.ts), never against these declared fields: the declared
// `content_type` must agree with the bytes or the upload is refused. PNG, JPEG and WebP only; an SVG is refused.
// `data_base64` is bounded here only so an absurd body is a 400 before it is decoded; the exact limit (1 MiB of decoded bytes) is the
// service's, so the refusal can name it.

export const THEME_ASSET_SLOTS = ["logo_light", "logo_dark", "favicon"] as const;
export const themeAssetSlotSchema = z.enum(THEME_ASSET_SLOTS);
export type ThemeAssetSlotName = z.infer<typeof themeAssetSlotSchema>;

export const THEME_ASSET_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** 1 MiB decoded is 1,398,102 base64 characters; the margin is for padding and nothing else. */
/** The media types `GET /v1/themes/{id}/assets/{slot}` streams (owner decision 69 (c)): the same three the upload accepts. */
export const THEME_ASSET_MEDIA_TYPES = THEME_ASSET_CONTENT_TYPES;

export const MAX_THEME_ASSET_BASE64_LENGTH = 1_400_000;

export const themeAssetParamsSchema = z.object({ id: lowercaseUuidSchema }).strict();
export type ThemeAssetParams = z.infer<typeof themeAssetParamsSchema>;

export const themeAssetFetchParamsSchema = z.object({ id: lowercaseUuidSchema, slot: themeAssetSlotSchema }).strict();
export type ThemeAssetFetchParams = z.infer<typeof themeAssetFetchParamsSchema>;

export const uploadThemeAssetRequestSchema = z
  .object({
    slot: themeAssetSlotSchema,
    content_type: z.enum(THEME_ASSET_CONTENT_TYPES),
    data_base64: z.string().min(1).max(MAX_THEME_ASSET_BASE64_LENGTH).regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be standard base64"),
  })
  .strict();
export type UploadThemeAssetRequest = z.infer<typeof uploadThemeAssetRequestSchema>;

export const uploadThemeAssetResponseSchema = z
  .object({
    theme_id: z.uuid(),
    slot: themeAssetSlotSchema,
    /** A path on the platform's own origin; a GET on it streams the image itself (owner decision 69 (c)); never a stored key, never a third-party host. */
    url: z.string().min(1),
    content_type: z.enum(THEME_ASSET_CONTENT_TYPES),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().positive(),
  })
  .strict();
export type UploadThemeAssetResponse = z.infer<typeof uploadThemeAssetResponseSchema>;

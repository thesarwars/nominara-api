import { z } from "zod";
import { toolKeySchema } from "./tool-key.schema.js";

// STORY-078 AC23 - GET /v1/tools: the tool catalog for the caller's plan. FR-TL-11 / FR-DASH-08: "a tool outside the plan renders disabled, naming the plan that
// unlocks it". A tool the plan lacks is NEVER a missing entry: it is a descriptor with `enabled: false` and `unlocked_by_plan` naming the lowest plan that grants it,
// so the client renders a disabled tile from the server's word rather than a plan table of its own.
//
// `credits` is `null` where the price is not one figure (it depends on the mode, the page band or the plan's rate); the paired estimate routes carry the exact
// figure before the click. `0` is a free tool, never an absent price.

export const TOOL_PRICING_RATES = ["free", "flat", "per_unit", "per_page_band"] as const;
export const toolPricingRateSchema = z.enum(TOOL_PRICING_RATES);

export const toolUnlockPlanSchema = z.object({ key: z.string().min(1), display_name: z.string().min(1) }).strict();

export const toolCatalogModeSchema = z
  .object({
    mode: z.string().min(1),
    enabled: z.boolean(),
    credits: z.number().int().nonnegative().nullable(),
    /** The lowest plan that grants this mode; null when the caller's plan already has it (or no plan states it). */
    unlocked_by_plan: toolUnlockPlanSchema.nullable(),
  })
  .strict();

export const toolCatalogEntrySchema = z
  .object({
    tool_key: toolKeySchema,
    pricing: z.object({ rate: toolPricingRateSchema, credits: z.number().int().nonnegative().nullable() }).strict(),
    /** False: the caller's plan does not include the tool. The descriptor is still present. */
    enabled: z.boolean(),
    /** Set exactly when `enabled` is false and a plan grants the tool; null otherwise. */
    unlocked_by_plan: toolUnlockPlanSchema.nullable(),
    /** The tool's separately-gated modes (the AUX Audit's full mode); empty for a single-mode tool. */
    modes: z.array(toolCatalogModeSchema),
  })
  .strict();

export const toolCatalogResponseSchema = z.object({ tools: z.array(toolCatalogEntrySchema) }).strict();

export type ToolCatalogMode = z.infer<typeof toolCatalogModeSchema>;
export type ToolCatalogEntry = z.infer<typeof toolCatalogEntrySchema>;
export type ToolCatalogResponse = z.infer<typeof toolCatalogResponseSchema>;

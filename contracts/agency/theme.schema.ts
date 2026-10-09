import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { validationFailedDetailsSchema } from "../common/error-details.schema.js";
import { hexColorSchema } from "../reports/report-shared.schema.js";

// NEW-E-0 — GET/PUT /v1/agency/theme. Permission agency:branding.
// integrations-and-sharing.md §3 (FR-AGY-01g/h/i); STORY-097.
//
// DECISIONS CITED (planner contractMismatches, approved):
//  - D6 (ui-plan.md): colours are NULLABLE; null = platform default (Aurora
//    Signal). lib/api/pending.ts types them `string`; the frontend widens to
//    `string | null`.
//  - Theme multiplicity: week 1 keeps the singular path. GET returns the
//    LIST (frontend `AgencyTheme[]`, exactly one is_default); PUT updates the
//    theme named by `theme_id`, or creates one when `theme_id` is absent.
//    No delete / set-default endpoint yet (week 2).
//  - `custom_css` and every `*_key` asset field are NOT in the request
//    schema. `.strict()` turns them into a 400 validation_failed rather than
//    a silent drop (asset pipeline and CSS allow-list are week 2).
//  - hide_nominara_brand = true without whitelabel.remove_branding is
//    403 feature_not_in_plan (service-enforced).

export const agencyThemeSchema = z
  .object({
    theme_id: z.uuid(),
    name: z.string(),
    is_default: z.boolean(),
    color_primary: hexColorSchema.nullable(),
    color_accent: hexColorSchema.nullable(),
    color_bg: hexColorSchema.nullable(),
    color_fg: hexColorSchema.nullable(),
    /** One of the curated self-hosted families; the allow-list is the service's, so it is not duplicated as an enum here. */
    font_family: z.string().min(1),
    logo_url: z.string().nullable(),
    hide_nominara_brand: z.boolean(),
  })
  .strict();

// NEW-E-7 checkpoint-6 — the cursor envelope; `pagination` is published by the route's `listOf` marker.
export const agencyThemeListQuerySchema = paginationRequestSchema;
export type AgencyThemeListQuery = z.infer<typeof agencyThemeListQuerySchema>;
export const agencyThemeListResponseSchema = z.array(agencyThemeSchema);

export const updateAgencyThemeRequestSchema = z
  .object({
    /** Absent = create a new theme. */
    theme_id: z.uuid().optional(),
    name: z.string().trim().min(1).max(80).optional(),
    is_default: z.boolean().optional(),
    /** null resets a colour to the platform default. */
    color_primary: hexColorSchema.nullable().optional(),
    color_accent: hexColorSchema.nullable().optional(),
    color_bg: hexColorSchema.nullable().optional(),
    color_fg: hexColorSchema.nullable().optional(),
    font_family: z.string().min(1).max(80).optional(),
    hide_nominara_brand: z.boolean().optional(),
  })
  .strict();

/**
 * Contrast rejection (FR-AGY-01h). The status/code follow api-specification
 * §2, NOT the demo backend (which answers 422 with {measured, suggestion}):
 * `400 validation_failed`, whose `details` is the §2 validation shape
 * (`issues[]`, naming the colour field) extended with the measurement.
 *
 *   token           the colour pair that failed, e.g. "color_fg_on_bg"
 *   measured_ratio  WCAG contrast ratio of the submitted pair
 *   threshold       the ratio it had to meet (4.5 text, 3 graph strokes)
 *   suggestion      nearest passing hex for the colour being changed
 *
 * Extending (rather than replacing) validationFailedDetailsSchema keeps a
 * client that already renders `issues[]` working.
 */
export const contrastRejectionDetailsSchema = validationFailedDetailsSchema.extend({
  measured_ratio: z.number().positive(),
  threshold: z.number().positive(),
  token: z.string().min(1),
  suggestion: hexColorSchema,
});

export type AgencyTheme = z.infer<typeof agencyThemeSchema>;
export type UpdateAgencyThemeRequest = z.infer<typeof updateAgencyThemeRequestSchema>;
export type ContrastRejectionDetails = z.infer<typeof contrastRejectionDetailsSchema>;

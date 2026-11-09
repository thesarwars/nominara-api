import { z } from "zod";
import { paginationRequestSchema } from "../common/pagination.schema.js";
import { validationFailedDetailsSchema } from "../common/error-details.schema.js";
import { hexColorSchema } from "../reports/report-shared.schema.js";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

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
//  - Every `*_key` asset field is NOT in the request schema (`custom_css` and `email_footer_html` are, since STORY-097 week 2).
//    `.strict()` turns them into a 400 validation_failed rather than a silent drop; they stay refused until the asset endpoint exists.
//  - hide_nominara_brand = true without whitelabel.remove_branding is
//    403 feature_not_in_plan (service-enforced).

// Both are written into mail headers, so the schema refuses what could break out of one: no control characters (a CR or LF
// is header injection), and no angle brackets, quotes or backslash in a display name (they would close or escape it). The
// mail adapter sanitises again: a value stored before this rule, or by any other path, still cannot reach a header.
const emailFromNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  // eslint-disable-next-line no-control-regex -- the point of the rule: a control character in a header is an injection
  .regex(/^[^\u0000-\u001f\u007f<>"\\]+$/, "a display name cannot contain control characters, angle brackets, quotes or a backslash");
const emailReplyToSchema = z.email().max(254);

/** Mirrors src/lib/theme (custom-css.ts / email-footer.ts), which a unit test holds equal. The contract is the published number. */
export const MAX_CUSTOM_CSS_LENGTH = 20_000;
export const MAX_EMAIL_FOOTER_LENGTH = 2_000;

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
    /** STORY-097. The SANITISED, re-serialised style override (never the upload); null = none. Colours in it are only var(--nm-color-primary|accent|bg|fg) references, each rule contrast-checked against the theme at save time. */
    custom_css: z.string().nullable(),
  })
  .strict();

// STORY-100 AC10 — what the AGENCY's editor reads and writes: the portal's theme plus the two email fields. They are NOT
// on `agencyThemeSchema`, because the portal response embeds that one and a portal viewer (a client of the agency, possibly
// anonymous through a share link) must not be handed the agency's mail configuration.
export const agencyThemeAdminSchema = agencyThemeSchema
  .extend({
    /** The display name a scheduled report's email is sent under. null = the platform's sender name alone. */
    email_from_name: emailFromNameSchema.nullable(),
    /** Owner decision 6: the Reply-To of a scheduled report's email. null = the header is omitted. */
    email_reply_to: emailReplyToSchema.nullable(),
    /** STORY-097. The SANITISED email footer subset (never the upload); null = none. Agency editor only, like the other mail fields. */
    email_footer_html: z.string().nullable(),
    /** STORY-097. The platform-origin path of the stored dark-mode logo (`GET /v1/themes/{id}/assets/logo_dark` streams it); null = none uploaded. Agency editor only. */
    logo_dark_url: z.string().nullable(),
    /** STORY-097. The platform-origin path of the stored favicon; null = none uploaded. Agency editor only. */
    favicon_url: z.string().nullable(),
  })
  .strict();

// NEW-E-7 checkpoint-6 — the cursor envelope; `pagination` is published by the route's `listOf` marker.
export const agencyThemeListQuerySchema = paginationRequestSchema;
export type AgencyThemeListQuery = z.infer<typeof agencyThemeListQuerySchema>;
export const agencyThemeListResponseSchema = z.array(agencyThemeAdminSchema);

export const updateAgencyThemeRequestSchema = z
  .object({
    /** Absent = create a new theme. */
    theme_id: lowercaseUuidSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    is_default: z.boolean().optional(),
    /** null resets a colour to the platform default. */
    color_primary: hexColorSchema.nullable().optional(),
    color_accent: hexColorSchema.nullable().optional(),
    color_bg: hexColorSchema.nullable().optional(),
    color_fg: hexColorSchema.nullable().optional(),
    font_family: z.string().min(1).max(80).optional(),
    hide_nominara_brand: z.boolean().optional(),
    /** STORY-100 AC10. Absent leaves it as stored; null clears it. */
    email_from_name: emailFromNameSchema.nullable().optional(),
    /** STORY-100 AC10 / owner decision 6. Absent leaves it as stored; null clears it (the Reply-To header is then omitted). */
    email_reply_to: emailReplyToSchema.nullable().optional(),
    /** STORY-097. Parsed against a property allow-list and RE-SERIALISED; unrecognised input is dropped and reported, url()/@import/content/position:fixed refuse the save. null clears. */
    custom_css: z.string().max(MAX_CUSTOM_CSS_LENGTH).nullable().optional(),
    /** STORY-097. A sanitised HTML subset, re-serialised. null clears. */
    email_footer_html: z.string().max(MAX_EMAIL_FOOTER_LENGTH).nullable().optional(),
  })
  .strict();

const droppedInputSchema = z.object({ construct: z.string(), reason: z.string() }).strict();

/**
 * STORY-097 — what PUT /agency/theme answers: the saved theme plus what the sanitisers LEFT OUT, so an agency learns which of its
 * input does nothing instead of believing the product is broken. Both arrays are empty when nothing was dropped.
 */
export const saveAgencyThemeResponseSchema = agencyThemeAdminSchema
  .extend({
    dropped: z
      .object({
        custom_css: z.array(droppedInputSchema.extend({ kind: z.enum(["property", "value", "selector", "at_rule", "rule"]) }).strict()),
        email_footer_html: z.array(droppedInputSchema),
      })
      .strict(),
  })
  .strict();

/**
 * STORY-097 — a REFUSED style override or footer (url(), @import, content, position:fixed, an escape sequence, oversize). 400
 * `validation_failed`; `refused` names each construct so the agency knows which one to remove.
 */
export const styleRefusalDetailsSchema = validationFailedDetailsSchema.extend({
  refused: z.array(z.object({ construct: z.string().min(1), message: z.string().min(1) }).strict()).min(1),
});

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
export type AgencyThemeAdmin = z.infer<typeof agencyThemeAdminSchema>;
export type SaveAgencyThemeResponse = z.infer<typeof saveAgencyThemeResponseSchema>;
export type StyleRefusalDetails = z.infer<typeof styleRefusalDetailsSchema>;
export type UpdateAgencyThemeRequest = z.infer<typeof updateAgencyThemeRequestSchema>;
export type ContrastRejectionDetails = z.infer<typeof contrastRejectionDetailsSchema>;

import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-043 — POST /v1/projects. api-specification.md §4.1.
//
// `.strict()` carries three acceptance criteria at once, and it is worth
// naming them because they read as separate requirements in the story:
//
//   AC2  topics, engines and cadence are "not accepted at creation" — topics
//        are derived by clustering, engines come from the plan, cadence is a
//        settings change. Not listing them IS the rejection.
//   AC3  a supplied `root_domain` is "rejected rather than trusted" — it is
//        derived from root_url. Same mechanism: it is simply not a key here.
//   §9   security-and-tenancy.md's mass-assignment control, "zod .strict() on
//        every request DTO — an unknown key is a 400, never silently ignored".
//
// One consequence to keep in mind when editing: adding a key here to be
// "permissive" silently un-implements whichever of those it belonged to.

const trimmedString = (max: number) => z.string().trim().min(1).max(max);

/** A competitor supplied at creation. Stored user-authored, charges nothing, consumes cap. */
export const suppliedCompetitorSchema = z
  .object({
    name: trimmedString(200),
    root_domain: trimmedString(253).optional(),
    aliases: z.array(trimmedString(200)).max(50).optional(),
  })
  .strict();

/** A prompt supplied at creation. Stored `manual`, charges nothing, consumes cap. */
export const suppliedPromptSchema = z
  .object({
    text: trimmedString(500),
  })
  .strict();

/** The field shape, before the cross-field rule. Exported so the
 * `fields_supplied` key list can be checked against it directly rather than
 * reaching through `.refine()`'s internals, which are a zod implementation
 * detail and change between majors. */
export const createProjectFieldsSchema = z
  .object({
    // The ONLY required field (§4: "root_url is the only required field").
    // Validated for shape here; the guarded fetcher's scheme/port/address
    // checks run in the service, because they resolve DNS and a zod schema
    // must stay synchronous and side-effect free.
    root_url: z.string().url().max(2048),

    // Identity and matching.
    name: trimmedString(200).optional(),
    description: z.string().trim().max(2000).optional(),
    brand_aliases: z.array(trimmedString(200)).max(50).optional(),
    negative_aliases: z.array(trimmedString(200)).max(50).optional(),
    owned_domains: z.array(trimmedString(253)).max(50).optional(),
    locale: trimmedString(35).optional(),

    // Classification.
    category_slug: trimmedString(100).optional(),
    verticals: z.array(trimmedString(100)).max(20).optional(),

    // Seeding. Both consume plan capacity and cost nothing.
    competitors: z.array(suppliedCompetitorSchema).max(200).optional(),
    prompts: z.array(suppliedPromptSchema).max(500).optional(),

    // Hierarchy — set at creation only (AC6).
    kind: z.enum(["brand", "product_line"]).optional(),
    parent_project_id: lowercaseUuidSchema.optional(),
  })
  .strict();

// AC6 — "kind='product_line' requires a parent project". Expressed as a
// refinement rather than checked in the service so it fails as
// `400 validation_failed` with the offending path, like every other shape
// error, instead of as a bespoke domain error the client must special-case.
export const createProjectRequestSchema = createProjectFieldsSchema.refine(
  (value) => value.kind !== "product_line" || value.parent_project_id !== undefined,
  {
    message: "parent_project_id is required when kind is product_line",
    path: ["parent_project_id"],
  },
);

export type CreateProjectRequest = z.infer<typeof createProjectFieldsSchema>;
export type SuppliedCompetitor = z.infer<typeof suppliedCompetitorSchema>;
export type SuppliedPrompt = z.infer<typeof suppliedPromptSchema>;

/**
 * The optional keys a caller may supply, in the order §4.1 documents them.
 *
 * Derived from the schema rather than restated: `fields_supplied` (AC4) must
 * echo exactly what the caller sent, and a hand-kept second list would drift
 * from the schema the moment a field is added — reporting a field as
 * discovered when it was supplied, which is precisely the mistake AC4 exists
 * to prevent.
 */
export const OPTIONAL_PROJECT_FIELDS = [
  "name",
  "description",
  "brand_aliases",
  "negative_aliases",
  "owned_domains",
  "locale",
  "category_slug",
  "verticals",
  "competitors",
  "prompts",
  "kind",
  "parent_project_id",
] as const satisfies readonly (keyof CreateProjectRequest)[];

export type OptionalProjectField = (typeof OPTIONAL_PROJECT_FIELDS)[number];

import { z } from "zod";

// STORY-044 — POST /v1/projects/{id}/discovery/confirm.
// api-specification.md §3's route table: "accept or override discovered
// fields and proposed competitors", `project:update`.
//
// A per-field DECISION, not a patch body. "Accept as discovered" and
// "override with this value" are different events even when they produce the
// same column value: only the second means a human disagreed with us, and
// AC4 turns on recording exactly that. A plain `{ name: "..." }` patch cannot
// express the difference, so the shape is a discriminated union per field.

/**
 * The discovered fields that map onto a project column and can therefore be
 * confirmed.
 *
 * `products` is deliberately absent: §4.5 discovers it, but there is no
 * `projects.products` column for it to be applied to — product lines are their
 * own `kind='product_line'` projects (§4.1). Accepting it would have nowhere
 * to write, so it is not offered rather than silently ignored.
 */
export const CONFIRMABLE_FIELDS = [
  "brand_name",
  "description",
  "category",
  "locale",
  "aliases",
  "negative_aliases",
  "verticals",
] as const;

export type ConfirmableField = (typeof CONFIRMABLE_FIELDS)[number];

/** Fields whose value is a list of strings; everything else is a single string. */
export const LIST_VALUED_FIELDS: readonly ConfirmableField[] = ["aliases", "negative_aliases", "verticals"];

const acceptDecision = z.object({ decision: z.literal("accept") }).strict();

const overrideDecision = z
  .object({
    decision: z.literal("override"),
    // `unknown` here and validated per field in the service against
    // LIST_VALUED_FIELDS — a zod union keyed on the field NAME would need one
    // branch per field and would drift from that list the moment one is added.
    value: z.union([z.string().trim().min(1).max(2000), z.array(z.string().trim().min(1).max(200)).max(50)]),
  })
  .strict();

export const fieldDecisionSchema = z.discriminatedUnion("decision", [acceptDecision, overrideDecision]);

export const confirmCompetitorSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    root_domain: z.string().trim().min(1).max(253).optional(),
    aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  })
  .strict();

export const confirmDiscoveryRequestSchema = z
  .object({
    // Partial by design — AC6: "confirmation is not required to use the
    // project". Confirming one field and leaving the rest is a normal,
    // complete request, not a half-finished one.
    // `partialRecord`, NOT `record`. With an enum key, z.record infers every
    // key as REQUIRED — so a caller confirming one field would have to send
    // all seven, which is the exact opposite of AC6 ("confirmation is not
    // required to use the project"). Runtime validation accepted a partial
    // object either way; only `tsc` saw it, which is why the type matters
    // here and not just the parse.
    fields: z.partialRecord(z.enum(CONFIRMABLE_FIELDS), fieldDecisionSchema).optional(),
    competitors: z.array(confirmCompetitorSchema).max(200).optional(),
  })
  .strict();

export type ConfirmDiscoveryRequest = z.infer<typeof confirmDiscoveryRequestSchema>;
export type FieldDecision = z.infer<typeof fieldDecisionSchema>;
export type ConfirmCompetitor = z.infer<typeof confirmCompetitorSchema>;

/** Which project column each confirmable field writes to. */
export const COLUMN_FOR_FIELD: Record<ConfirmableField, string> = {
  brand_name: "name",
  description: "description",
  category: "category_slug",
  locale: "locale",
  aliases: "brand_aliases",
  negative_aliases: "negative_aliases",
  verticals: "verticals",
};

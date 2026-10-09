import { z } from "zod";

// NEW-C-3 / STORY-056 + STORY-057 — the three jsonb columns of
// `displacement_events` (`schemas/captures-and-facts.md`). Every jsonb column
// has a schema; the rollup step parses what it writes through these.

/** The `citation_facts.source_class` CHECK list, verbatim (it includes `social`, which the read-side enum omits). */
export const displacementSourceClassSchema = z.enum([
  "community_forum",
  "review_marketplace",
  "encyclopedic",
  "news_media",
  "vendor_owned",
  "developer_platform",
  "social",
  "blog",
  "academic",
  "other",
]);

export const displacementPositionClassSchema = z.enum(["recommendation", "ranked", "neutral_list", "also_consider", "caveat"]);

/** One entity that now holds the slot — tracked or not (STORY-056 AC4/AC5). */
export const displacedByEntrySchema = z
  .object({
    entity_label: z.string().min(1),
    entity_id: z.string().uuid().nullable(),
    is_tracked: z.boolean(),
    position: z.number().int().positive().nullable(),
    prominence: z.number(),
    position_class: displacementPositionClassSchema,
    citations: z.array(z.object({ url: z.string(), domain: z.string(), source_class: displacementSourceClassSchema }).strict()),
  })
  .strict();

/**
 * A citation the displacing entities hold on the AFTER-capture and the brand
 * does not (STORY-057 AC1/AC2). `brand_present` comes from the verified
 * `project_source_index`; `null` = never verified, never assumed.
 */
export const citationGapEntrySchema = z
  .object({
    url: z.string().min(1),
    domain: z.string().min(1),
    source_class: displacementSourceClassSchema,
    held_by: z.array(z.string().min(1)).min(1),
    brand_present: z.boolean().nullable(),
  })
  .strict();

/** STORY-057 AC5: a concept without evidence cannot exist. Stored as `[]` until STORY-058 builds the corpus. */
export const conceptGapEntrySchema = z
  .object({
    concept: z.string().min(1),
    prevalence: z.number().min(0).max(1),
    evidence_url: z.string().min(1),
  })
  .strict();

export const displacedBySchema = z.array(displacedByEntrySchema);
export const citationGapSchema = z.array(citationGapEntrySchema);
export const conceptGapSchema = z.array(conceptGapEntrySchema);

export type DisplacedByEntry = z.infer<typeof displacedByEntrySchema>;
export type CitationGapEntry = z.infer<typeof citationGapEntrySchema>;
export type ConceptGapEntry = z.infer<typeof conceptGapEntrySchema>;

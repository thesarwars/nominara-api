import { z } from "zod";

// STORY-060 S3 / owner decision 99(k) - the zod schema for `geo_alignments.page_structure` (jsonb): what the STORY-050 document model found on the
// cluster's target page when the alignment session read it - the tables and the lists of each kind, summed over the page's content blocks. Strict.
// NULL in the column means the page was never read for structure (a session older than migration 0201); a page with nothing on it is zeros.

export const geoPageStructureSchema = z
  .object({
    tables: z.number().int().min(0),
    lists: z.object({ ordered: z.number().int().min(0), unordered: z.number().int().min(0), definition: z.number().int().min(0) }).strict(),
  })
  .strict();
export type GeoPageStructure = z.infer<typeof geoPageStructureSchema>;

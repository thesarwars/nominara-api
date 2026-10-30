import { z } from "zod";

// STORY-029 - the SerpApi response shapes this adapter reads, taken from RECORDED responses (fixtures/serp-recorded.ts) and the
// vendor's documentation (serpapi.com/google-ai-mode-api, /google-ai-overview-api). Every object is LOOSE: the vendor adds fields
// (source_icon, snippet_links, ...) and an unknown one must not fail a capture. What is declared is what the mapper reads; a
// declared field that is the wrong type fails the parse, and a failed parse is `malformed_response` (tracking-engine.md section 2).

const referenceSchema = z.looseObject({
  index: z.number().int().min(0),
  title: z.string().optional(),
  link: z.string().min(1),
  snippet: z.string().optional(),
  source: z.string().optional(),
});
export type SerpReference = z.infer<typeof referenceSchema>;

const snippetLinkSchema = z.looseObject({ text: z.string().optional(), link: z.string().min(1) });

const shoppingResultSchema = z.looseObject({
  title: z.string().optional(),
  product_link: z.string().optional(),
  thumbnail: z.string().optional(),
  price: z.string().optional(),
  rating: z.number().optional(),
  reviews: z.number().optional(),
});
export type SerpShoppingResult = z.infer<typeof shoppingResultSchema>;

export interface SerpTextBlock {
  type: string;
  snippet?: string | undefined;
  title?: string | undefined;
  snippet_links?: z.infer<typeof snippetLinkSchema>[] | undefined;
  reference_indexes?: number[] | undefined;
  list?: SerpTextBlock[] | undefined;
  text_blocks?: SerpTextBlock[] | undefined;
  shopping_result?: SerpShoppingResult | undefined;
  table?: string[][] | undefined;
  product_labels?: string[] | undefined;
  comparison?: { feature?: string | undefined; values?: string[] | undefined }[] | undefined;
}

// `list` items have no `type`, and `list` / `text_blocks` nest to any depth, so the recursion is declared lazily.
const textBlockSchema: z.ZodType<SerpTextBlock> = z.lazy(() =>
  z.looseObject({
    type: z.string().optional().default("list_item"),
    snippet: z.string().optional(),
    title: z.string().optional(),
    snippet_links: z.array(snippetLinkSchema).optional(),
    reference_indexes: z.array(z.number().int().min(0)).optional(),
    list: z.array(textBlockSchema).optional(),
    text_blocks: z.array(textBlockSchema).optional(),
    shopping_result: shoppingResultSchema.optional(),
    table: z.array(z.array(z.string())).optional(),
    product_labels: z.array(z.string()).optional(),
    comparison: z.array(z.looseObject({ feature: z.string().optional(), values: z.array(z.string()).optional() })).optional(),
  }),
) as z.ZodType<SerpTextBlock>;

/** The answer body: AI Mode returns it at the top level, an AI Overview inside `ai_overview`. */
export const serpAnswerBodySchema = z.looseObject({
  text_blocks: z.array(textBlockSchema),
  references: z.array(referenceSchema).optional(),
  shopping_results: z.array(shoppingResultSchema).optional(),
});
export type SerpAnswerBody = z.infer<typeof serpAnswerBodySchema>;

const searchMetadataSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
});

/** engine=google_ai_mode (and its async read-back). */
export const serpAiModeResponseSchema = z.looseObject({
  search_metadata: searchMetadataSchema.optional(),
  error: z.string().optional(),
  text_blocks: z.array(textBlockSchema).optional(),
  references: z.array(referenceSchema).optional(),
  shopping_results: z.array(shoppingResultSchema).optional(),
});

/** engine=google: the organic response, of which only `ai_overview` matters. Absent = Google showed none. */
export const serpOrganicResponseSchema = z.looseObject({
  search_metadata: searchMetadataSchema.optional(),
  error: z.string().optional(),
  ai_overview: z
    .looseObject({
      page_token: z.string().min(1).optional(),
      text_blocks: z.array(textBlockSchema).optional(),
      references: z.array(referenceSchema).optional(),
    })
    .optional(),
});

/** engine=google_ai_overview: the deferred overview. */
export const serpAiOverviewResponseSchema = z.looseObject({
  search_metadata: searchMetadataSchema.optional(),
  error: z.string().optional(),
  ai_overview: serpAnswerBodySchema.optional(),
});

/** The submit/poll envelope of an async search. */
export const serpEnvelopeSchema = z.looseObject({ search_metadata: searchMetadataSchema.optional(), error: z.string().optional() });

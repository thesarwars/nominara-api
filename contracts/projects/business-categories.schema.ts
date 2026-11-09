import { z } from "zod";

// `GET /v1/business-categories` — the fixed taxonomy the category override picker lists (STORY-189; owner decision 91). About 180 entries, our own list.
//
// NO TENANT DATA. `business_categories` is a global, read-only table: the same body for every caller, so it is cacheable per viewer. It is an
// authenticated route (a member of some workspace), not a public one. Ordered by slug.

export const businessCategorySchema = z
  .object({
    /** The value a project's `category_slug` takes. Permanent once seeded. */
    slug: z.string().min(1),
    name: z.string().min(1),
    /** The grouping the picker nests under. Null for a category that sits at the top level. */
    parent_slug: z.string().min(1).nullable(),
    parent_name: z.string().min(1).nullable(),
    /** One sentence saying what the category covers, shown beside the name in the picker. */
    description: z.string().min(1),
  })
  .strict();

export const businessCategoriesResponseSchema = z
  .object({
    categories: z.array(businessCategorySchema).min(1),
  })
  .strict();

export type BusinessCategory = z.infer<typeof businessCategorySchema>;
export type BusinessCategoriesResponse = z.infer<typeof businessCategoriesResponseSchema>;

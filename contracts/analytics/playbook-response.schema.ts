import { z } from "zod";

// NEW-C-7 / STORY-055 read side — `GET /v1/projects/{id}/sources/{domain}/playbook`
// (not in `api-specification.md`; recorded in the NEW-C-7 plan).
//
// `rules[]` carries ONLY quotes of a platform's own published rules, each with
// a link. Nominara has no such verified text yet, so it ships empty with
// `rules_unavailable_reason` stating why — rules are never invented or
// paraphrased.

export const playbookQuerySchema = z
  .object({
    timeframe: z.enum(["7d", "30d", "90d"]).default("30d"),
  })
  .strict();

export const playbookResponseSchema = z
  .object({
    domain: z.string(),
    target_url: z.string(),
    why: z.string(),
    rules: z.array(z.object({ quote: z.string(), url: z.string() }).strict()),
    rules_unavailable_reason: z.string().nullable(),
    outline: z.array(z.string()),
    disclosure: z.string(),
    do_not: z.array(z.string()),
    verification: z.string(),
    template_slug: z.string(),
    template_version: z.number().int().positive(),
  })
  .strict();

export type PlaybookQuery = z.infer<typeof playbookQuerySchema>;
export type PlaybookResponse = z.infer<typeof playbookResponseSchema>;

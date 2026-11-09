import { z } from "zod";
import { auxPatchSchema } from "../aux/patch.schema.js";

// STORY-192 - the HTTP surface of the alignment session (api-specification.md "GEO", `optimizer:use`): open one, read its payload
// (`alignmentSessionPayloadSchema`), edit its draft, and cut a patch from it.
//
// NOTHING HERE CHARGES. Every route is 0 credits and unlimited (plans-and-entitlements.md: "GEO Alignment session, every recompute,
// patch assembly"), so no response carries a price except to say it is 0.
//
// NO GENERATION. The draft is the customer's own text, sent to be MEASURED; there is no field here that asks Nominara to write one
// (aux-and-geo-analysis.md section 9). The patch is that draft, stated as a copy-ready artifact with a precondition hash.

/**
 * The largest draft accepted, in characters. A BUILDER CHOICE (the reference sets none): the live page is fetched under the guarded
 * fetcher's own body cap, and a draft is a working copy of that page, so this bounds the chunks one edit writes and the request body.
 */
export const ALIGNMENT_DRAFT_MAX_CHARS = 200_000;

/** api-specification.md: the draft recompute answers within 200 ms p95. */
export const ALIGNMENT_DRAFT_P95_OBJECTIVE_MS = 200;

export const openAlignmentRequestSchema = z
  .object({
    project_id: z.string().uuid(),
    /** An http(s) page only: the worker fetches it through the SSRF-guarded fetcher, and no other scheme is a page. */
    target_url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), { message: "target_url must be an http(s) URL" }),
    prompt_cluster_id: z.string().uuid(),
  })
  .strict();
export type OpenAlignmentRequest = z.infer<typeof openAlignmentRequestSchema>;

/** 202: the session exists and is `pending`; `poll_url` is where its payload will say `ready`. */
export const openAlignmentResponseSchema = z
  .object({
    session_id: z.string().uuid(),
    status: z.literal("pending"),
    poll_url: z.string().min(1),
    credits_charged: z.literal(0),
  })
  .strict();
export type OpenAlignmentResponse = z.infer<typeof openAlignmentResponseSchema>;

export const alignmentIdParamSchema = z.string().uuid();

export const updateAlignmentDraftRequestSchema = z
  .object({ draft_content_md: z.string().min(1).max(ALIGNMENT_DRAFT_MAX_CHARS) })
  .strict();
export type UpdateAlignmentDraftRequest = z.infer<typeof updateAlignmentDraftRequestSchema>;

/** The patch is derived entirely from the stored draft; there is nothing to choose, so the body is empty and anything in it is refused. */
export const createAlignmentPatchRequestSchema = z.object({}).strict();
export type CreateAlignmentPatchRequest = z.infer<typeof createAlignmentPatchRequestSchema>;

/** The same wire shape as `GET /v1/patches/{id}`: an alignment patch is an optimizer patch (`finding_id` and `rule_code` are null). */
export const createAlignmentPatchResponseSchema = auxPatchSchema;
export type CreateAlignmentPatchResponse = z.infer<typeof createAlignmentPatchResponseSchema>;

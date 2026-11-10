import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// `GET /v1/geo/alignment/targets?project_id=` (api-specification.md "GEO", `optimizer:use`, behind `optimizer.enabled`; 0 credits).
// What a Content Alignment session can be opened on: the project's topic clusters and the pages worth measuring, with the latest result per
// (page, cluster) already opened. `POST /geo/alignment` takes a `target_url` and a `prompt_cluster_id`; before this route a client had no served way
// to learn either.
//
// NO PAGE TEXT. The specification stores a page's text only on a session, after the worker fetched it (`geo_alignments.live_content_md`), and the
// session payload does not carry it. This route never fetches a page and returns none, so there is nothing to prefill a draft with until the
// owner names where it comes from (see the delivery note).
//
// HONESTY: every figure of a session is `null` until it is measured, never 0, and only a `ready` session carries any (as in the payload).

export const alignmentTargetsQuerySchema = z.object({ project_id: lowercaseUuidSchema }).strict();
export type AlignmentTargetsQuery = z.infer<typeof alignmentTargetsQuerySchema>;

/** Where a candidate page came from. Order is the order they are listed in. */
export const alignmentPageSourceSchema = z.enum(["project_root", "alignment_session", "aux_audit"]);
export type AlignmentPageSource = z.infer<typeof alignmentPageSourceSchema>;

/** The most pages listed. A builder choice: it bounds the response; the client lists what is returned. */
export const ALIGNMENT_TARGETS_MAX_PAGES = 100;
/** The most recent sessions listed. A builder choice, bounding the response. */
export const ALIGNMENT_TARGETS_MAX_SESSIONS = 50;
/** The most domains named in the corpus summary. */
export const ALIGNMENT_TARGETS_MAX_DOMAINS = 20;

export const alignmentTargetClusterSchema = z
  .object({ cluster_id: z.string().uuid(), label: z.string(), prompt_count: z.number().int().nonnegative() })
  .strict();

export const alignmentTargetPageSchema = z
  .object({ target_url: z.string().min(1), sources: z.array(alignmentPageSourceSchema).min(1) })
  .strict();

/** The newest session per (page, cluster). Figures are `null` unless the session is `ready`. */
export const alignmentTargetSessionSchema = z
  .object({
    session_id: z.string().uuid(),
    target_url: z.string().min(1),
    cluster_id: z.string().uuid().nullable(),
    status: z.enum(["pending", "ready", "stale", "failed"]),
    alignment: z.number().nullable(),
    target_band: z.tuple([z.number(), z.number()]).nullable(),
    percentile_vs_cited_docs: z.number().int().min(0).max(100).nullable(),
    coverage_ratio: z.number().min(0).max(1).nullable(),
    updated_at: z.string().datetime(),
  })
  .strict();

export const alignmentTargetsResponseSchema = z
  .object({
    project_id: z.string().uuid(),
    clusters: z.array(alignmentTargetClusterSchema),
    pages: z.array(alignmentTargetPageSchema).max(ALIGNMENT_TARGETS_MAX_PAGES),
    sessions: z.array(alignmentTargetSessionSchema).max(ALIGNMENT_TARGETS_MAX_SESSIONS),
    /** The cited corpus the project holds now (unexpired passages): a count and the domains. 0 passages is a real zero (nothing cited yet). */
    corpus: z.object({ passages: z.number().int().nonnegative(), domains: z.array(z.string()).max(ALIGNMENT_TARGETS_MAX_DOMAINS) }).strict(),
    credits_charged: z.literal(0),
  })
  .strict();
export type AlignmentTargetsResponse = z.infer<typeof alignmentTargetsResponseSchema>;

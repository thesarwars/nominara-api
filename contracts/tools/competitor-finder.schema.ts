import { z } from "zod";

// STORY-081 - Competitor Finder: POST /v1/tools/competitor-finder (api-specification.md section 3 "Tools", FR-TL-02) and the stored snapshot that lives
// in tool_runs.result_json.
//
// EVERY ENTITY IS EVIDENCED BY A CAPTURE. A row carries the character span that named it (offsets into the normalized answer) and the excerpt around it; the
// schema has no way to state a name without both. The route is asynchronous (KAD-06: the page fetch and the capture happen in the worker): it answers 202 with
// the run, and the result is read from GET /v1/tools/runs/{id} like every other tool's.

/** product-spec.md section 11: "Competitor Finder - 1 credit". Flat; one capture. */
export const COMPETITOR_FINDER_CREDITS = 1;

/** FR-TL-02, in the words the payload carries: one engine, one query, one moment. */
export const COMPETITOR_FINDER_SCOPE_STATEMENT =
  "One engine, one query, one moment: these are the names this engine produced for this query, once. They are detections, not a list of your competitors.";

export const competitorFinderRequestSchema = z
  .object({
    url: z.url({ protocol: /^https?$/ }).max(2048),
  })
  .strict();

export const competitorFinderAcceptedSchema = z
  .object({
    tool_run_id: z.uuid(),
    status: z.literal("running"),
    credits_charged: z.number().int().nonnegative(),
    engine: z.object({ engine_key: z.string().min(1), display_name: z.string().min(1) }).strict(),
    poll: z.string().min(1),
  })
  .strict();

/** One detected entity. `name` is the text of `span` in the answer - it is never supplied separately. */
export const competitorFinderEntitySchema = z
  .object({
    name: z.string().min(1),
    span: z.object({ char_start: z.number().int().nonnegative(), char_end: z.number().int().positive() }).strict(),
    /** The line of the answer that named it. */
    excerpt: z.string().min(1),
    /** The domain the answer cited for this entity; `null` when the answer cited none for it (never a guess). */
    cited_domain: z.string().min(1).nullable(),
    /** Decision 67(b): a row with no cited website is still shown, labelled `no_source_cited` (the client renders "No source cited"). Derived from `cited_domain`, never independent of it. */
    source_status: z.enum(["cited", "no_source_cited"]),
  })
  .strict()
  .refine((e) => (e.cited_domain === null) === (e.source_status === "no_source_cited"), { message: "source_status must be no_source_cited exactly when cited_domain is null", path: ["source_status"] });

export const competitorFinderResultSchema = z
  .object({
    schema_version: z.literal(1),
    scope: z
      .object({
        engine: z.string().min(1),
        query: z.string().min(1),
        captured_at: z.iso.datetime(),
        statement: z.string().min(1),
      })
      .strict(),
    entities: z.array(competitorFinderEntitySchema),
    /** The names of `entities`, in order: the key the shared conversion contract pre-fills candidate competitors from. Detections only; nothing is added to the project's list. */
    competitors: z.array(z.string().min(1)),
  })
  .strict();

/** The signed `lookup.execute` job payload for a Competitor Finder run (the signing layer adds `workspaceId` and `kid`). */
export const competitorFinderJobPayloadSchema = z
  .object({
    tool: z.literal("competitor_finder"),
    toolRunId: z.uuid(),
    targetUrl: z.string().min(1),
    engine: z.string().min(1),
    locale: z.string().min(1),
    startedAt: z.iso.datetime(),
  })
  .passthrough();

export type CompetitorFinderRequest = z.infer<typeof competitorFinderRequestSchema>;
export type CompetitorFinderAccepted = z.infer<typeof competitorFinderAcceptedSchema>;
export type CompetitorFinderEntity = z.infer<typeof competitorFinderEntitySchema>;
export type CompetitorFinderResult = z.infer<typeof competitorFinderResultSchema>;
export type CompetitorFinderJobPayload = z.infer<typeof competitorFinderJobPayloadSchema>;

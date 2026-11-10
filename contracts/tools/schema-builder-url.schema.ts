import { z } from "zod";
import { SCHEMA_BUILDER_MAX_FINDINGS, schemaBuilderFindingSchema } from "./schema-builder.schema.js";

// STORY-083 AC5 / owner decision 82 - Schema Builder URL mode: `POST /v1/tools/schema-builder/url`. The URL path of CHECK: the worker fetches one page through the
// guarded fetcher and runs the SAME structured-data rules the in-project audit runs (AUX-R-008..018, minus the held AUX-R-013); there is no second rule
// implementation. The paste path is unchanged and still makes no request (`POST /tools/schema-builder` saves browser-side findings).
//
// ASYNCHRONOUS (KAD-06): the request validates the URL (DNS only, no socket), writes a `running` run and enqueues a signed `lookup.execute` job after the
// commit; the page is fetched in the worker. The result is read from `GET /v1/tools/runs/{id}` like every tool's. FREE: `credits_charged` is the literal 0 and the
// database refuses a debit on the row (`ck_tr_free_tools`).
//
// WHAT A RESULT SAYS. Only the structured data of the ONE page that was fetched. A page that could not be read is `unreachable` with a short reason and no finding:
// "could not look" is never shown as "found nothing wrong".

export const schemaBuilderUrlRequestSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => /^https?:\/\//i.test(value), { message: "url must be an http(s) URL" }),
  })
  .strict();
export type SchemaBuilderUrlRequest = z.infer<typeof schemaBuilderUrlRequestSchema>;

/** 202: the run exists and is `running`; `poll` is where its result will appear. */
export const schemaBuilderUrlAcceptedSchema = z
  .object({
    tool_run_id: z.uuid(),
    tool_key: z.literal("schema_builder"),
    mode: z.literal("check"),
    source: z.literal("url"),
    status: z.literal("running"),
    credits_charged: z.literal(0),
    poll: z.string().min(1),
  })
  .strict();
export type SchemaBuilderUrlAccepted = z.infer<typeof schemaBuilderUrlAcceptedSchema>;

/** Why the page could not be read. Short codes: never the underlying error's message (it can carry a resolved address). */
export const SCHEMA_BUILDER_URL_UNREACHABLE_REASONS = ["refused", "unreachable", "http_error", "not_html"] as const;
export const schemaBuilderUrlUnreachableReasonSchema = z.enum(SCHEMA_BUILDER_URL_UNREACHABLE_REASONS);

/**
 * `tool_runs.result_json` of a URL-mode run (findings only, never page text). `pending` is the stored value while the run is `running` (the table requires a
 * Schema Builder run to carry a result from its first write); it states nothing about the page.
 */
export const schemaBuilderUrlResultSchema = z.discriminatedUnion("state", [
  z.object({ schema_version: z.literal(1), source: z.literal("url"), state: z.literal("pending") }).strict(),
  z
    .object({
      schema_version: z.literal(1),
      source: z.literal("url"),
      state: z.literal("checked"),
      mode: z.literal("check"),
      entity_type: z.null(),
      /** The rule catalog's version the page was judged against (`aux-rules@<rule_version>`). */
      vocab_version: z.string().min(1),
      /** How many structured-data rules RAN on the page (the engine reports no "could not decide", so this is the rules run, not the rules that found something). 0 is possible and is not "no findings". */
      rules_evaluated: z.number().int().nonnegative(),
      /** True when the page was cut at the response size cap: JSON-LD past the cut was never seen, so "absent" findings may be an artefact of the cut. Always present: absent would read as "not truncated". */
      page_truncated: z.boolean(),
      findings: z.array(schemaBuilderFindingSchema).max(SCHEMA_BUILDER_MAX_FINDINGS),
      /** Findings left out to fit the cap; counted, never dropped silently. */
      findings_omitted: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ schema_version: z.literal(1), source: z.literal("url"), state: z.literal("unreachable"), reason: schemaBuilderUrlUnreachableReasonSchema }).strict(),
]);
export type SchemaBuilderUrlResult = z.infer<typeof schemaBuilderUrlResultSchema>;

/** The signed `lookup.execute` job payload for a URL-mode run (the signing layer adds `workspaceId` and `kid`). */
export const schemaBuilderUrlJobPayloadSchema = z
  .object({
    tool: z.literal("schema_builder"),
    toolRunId: z.uuid(),
    targetUrl: z.string().min(1),
    startedAt: z.iso.datetime(),
  })
  .passthrough();
export type SchemaBuilderUrlJobPayload = z.infer<typeof schemaBuilderUrlJobPayloadSchema>;

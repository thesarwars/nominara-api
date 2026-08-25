import { z } from "zod";

// STORY-026 T19 — api-specification.md §11's capture-side events, plus the two
// scan events whose payloads §11 defers to §9's worked example.
//
// Every one of these is emitted by a worker that does not exist yet
// (EPIC-04+). The CATALOG is this story's deliverable; the publish path
// belongs to the epic that builds the producer. Defining the shapes now is
// what lets the frontend type against them before a single worker ships.

const uuid = z.uuid();

/**
 * `run.progress` — the only per-run coalesced event (≤ 1 / 750 ms / run).
 *
 * `eta_ms`, NOT §11's `eta_seconds`. `NFR-API-05` is unconditional — "all
 * durations are integer milliseconds with a `_ms` suffix" — and §11's table
 * contradicts it in this one field. The same contradiction was resolved the
 * same way for `expires_in_seconds` in STORY-117: the unconditional
 * non-functional requirement wins over a single table cell, and §11 goes on
 * the hand-carried specification-fix list. Shipping `eta_seconds` would put a
 * second duration unit on the wire and make `_ms` mean nothing.
 */
export const runProgressEventSchema = z
  .object({
    run_id: uuid,
    project_id: uuid,
    planned: z.number().int().nonnegative(),
    captured: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pct: z.number().min(0).max(100),
    eta_ms: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const runCompletedEventSchema = z
  .object({
    run_id: uuid,
    project_id: uuid,
    status: z.enum(["completed", "partial", "failed"]),
    captured: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    duration_ms: z.number().int().nonnegative(),
    // A DELTA, so it is signed and may be zero. Nullable because the first run
    // of a project has nothing to compare against — and "no previous run" must
    // not be reported as "no change", which is a different fact.
    visibility_delta: z.number().nullable(),
  })
  .strict();

export const runFailedEventSchema = z
  .object({
    run_id: uuid,
    project_id: uuid,
    error_code: z.string().min(1),
    failed_engines: z.array(z.string().min(1)),
  })
  .strict();

/** §9's worked example, field for field. */
export const scanEngineResultEventSchema = z
  .object({
    engine: z.string().min(1),
    cache_layer: z.enum(["l1", "l2", "none"]),
    captured_at: z.iso.datetime(),
    latency_ms: z.number().int().nonnegative(),
    brand_present: z.boolean(),
    // Absent from the answer entirely is `null`, not 0 — rank 0 does not exist,
    // and a zero here would sort as "best position" in any client that did not
    // special-case it.
    rank_position: z.number().int().positive().nullable(),
    sov: z.number().min(0).max(1),
    sentiment: z
      .object({
        label: z.enum(["positive", "neutral", "negative"]),
        score: z.number().min(-1).max(1),
      })
      .strict(),
    citations: z.array(
      z
        .object({
          slot: z.number().int().positive(),
          domain: z.string().min(1),
          is_owned: z.boolean(),
        })
        .strict(),
    ),
    excerpt: z.string(),
  })
  .strict();

export const scanCompletedEventSchema = z
  .object({
    tool_run_id: z.string().min(1),
    // §9: "On timeout the terminal event is `scan.completed` with
    // `status: partial` and the engines that did respond; the snapshot is
    // still stored, because a partial answer is a valid historical record."
    status: z.enum(["completed", "partial", "failed"]),
    duration_ms: z.number().int().nonnegative(),
    aggregate: z
      .object({
        sov_estimate: z.number().min(0).max(1),
        citation_count: z.number().int().nonnegative(),
        owned_citation_count: z.number().int().nonnegative(),
        sentiment_label: z.enum(["positive", "neutral", "negative"]),
        brand_present: z.boolean(),
        engines_succeeded: z.array(z.string().min(1)),
        engines_failed: z.array(z.string().min(1)),
      })
      .strict(),
    convert_cta: z
      .object({
        endpoint: z.string().min(1),
        prefill: z
          .object({
            project_name: z.string().min(1),
            root_url: z.url(),
            prompts: z.array(z.string().min(1)),
            competitors: z.array(z.string().min(1)),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const engineDegradedEventSchema = z
  .object({
    engine_key: z.string().min(1),
    circuit_state: z.enum(["closed", "open", "half_open"]),
    since: z.iso.datetime(),
    affected_projects: z.number().int().nonnegative(),
  })
  .strict();

export type RunProgressEvent = z.infer<typeof runProgressEventSchema>;
export type RunCompletedEvent = z.infer<typeof runCompletedEventSchema>;
export type RunFailedEvent = z.infer<typeof runFailedEventSchema>;
export type ScanEngineResultEvent = z.infer<typeof scanEngineResultEventSchema>;
export type ScanCompletedEvent = z.infer<typeof scanCompletedEventSchema>;
export type EngineDegradedEvent = z.infer<typeof engineDegradedEventSchema>;

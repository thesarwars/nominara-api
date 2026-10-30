import { z } from "zod";

// STORY-027 — tracking-engine.md §2: "the ONLY contract the rest of the
// system knows about." Planning, parsing, and scoring never learn which
// vendor produced a capture — only `captureMode`/`adapterVersion`, recorded
// for auditability, never branched on.

// D3 (STORY-027 Implementation decisions) — the registry's key set, taken
// verbatim from src/db/migrations/sql/0003_projects_prompts_captures.up.sql's
// `engines.key` CHECK, in DDL order. The last four are reserved: enum values
// with no adapter enabled (tracking-engine.md §3).
export const engineKeySchema = z.enum([
  "google_aio",
  "google_ai_mode",
  "perplexity",
  "chatgpt",
  "gemini",
  "claude",
  "grok",
  "copilot",
  "meta_ai",
  "deepseek",
]);
export type EngineKey = z.infer<typeof engineKeySchema>;

// Matches engines.capture_mode / answer_captures.capture_mode's DB CHECK.
export const captureModeSchema = z.enum(["api", "licensed_serp", "headless"]);
export type CaptureMode = z.infer<typeof captureModeSchema>;

export const captureInputSchema = z
  .object({
    promptText: z.string().min(1),
    // 'xx-XX' shape (e.g. 'en-US') — pinned rather than an open string
    // (T18 boundary case), since the cache key and vendor locale params are
    // both built from it.
    locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/, "locale must be 'xx-XX' (e.g. 'en-US')"),
    sampleIndex: z.number().int().min(0),
    // Implementation decisions — absent means "no persona hint"; an explicit
    // `null` is a validation failure, not treated as equivalent to absent.
    personaHint: z.string().optional(),
    requireCitations: z.boolean(),
    // STORY-029 - the speed of a licensed-SERP request, chosen by the CALLER (tracking-engine.md section 3, "Two capture speeds"):
    // `queued` for scheduled work, `live` for a person watching. Absent means queued: scheduled runs are the default path, and
    // an adapter with no such mode (every API engine) ignores it. The adapter never picks one for itself.
    requestMode: z.enum(["queued", "live"]).optional(),
  })
  .strict();
export type CaptureInput = z.infer<typeof captureInputSchema>;

const structuredCitationSchema = z
  .object({
    url: z.string().min(1),
    title: z.string().optional(),
    snippet: z.string().optional(),
    // Slot is 1-based (STORY-027 Implementation decisions): the
    // position-weight formula `1/√slot_index` (tracking-engine.md §7)
    // divides by zero at slot 0, so slot 0 fails validation rather than
    // being treated as the first slot.
    slot: z.number().int().min(1),
  })
  .strict();

const answerElementLinkSchema = z
  .object({
    url: z.string().min(1),
    title: z.string().optional(),
  })
  .strict();

// D2 (STORY-027 Implementation decisions) — tracking-engine.md references
// `AnswerElement[]` but never defines its shape. Defined here as a
// discriminated union over the element kinds §3 names for AI Mode, each
// carrying the same links[] plus render-signal fields mirroring
// mention_facts.render_attrs (price/rating/reviewCount/image/availability/
// description/link/spec).
const answerElementFieldsSchema = z.object({
  links: z.array(answerElementLinkSchema),
  price: z.string().optional(),
  rating: z.number().optional(),
  reviewCount: z.number().optional(),
  image: z.string().optional(),
  availability: z.string().optional(),
  description: z.string().optional(),
  link: z.string().optional(),
  spec: z.record(z.string(), z.string()).optional(),
});

export const answerElementSchema = z.discriminatedUnion("kind", [
  answerElementFieldsSchema.extend({ kind: z.literal("ai_overview_element") }).strict(),
  answerElementFieldsSchema.extend({ kind: z.literal("table_element") }).strict(),
  answerElementFieldsSchema.extend({ kind: z.literal("shopping_element") }).strict(),
  answerElementFieldsSchema.extend({ kind: z.literal("images") }).strict(),
]);
export type AnswerElement = z.infer<typeof answerElementSchema>;

// A refusal or a successful-but-empty answer is data, not a failure
// (tracking-engine.md §2, NFR-SIM-07) — closed set, matching
// answer_captures.flags' `text[]` shape. The base adapter passes these
// through untouched; it never invents them.
//
// STORY-029 / NFR-SIM-12 - `no_ai_overview_for_query`: a licensed-SERP request that WAS sent with the async-load parameter set and
// still came back with no AI Overview. A genuine absence, stored with brand_present=false. Without the parameter the same payload is
// an adapter defect and never reaches this flag - it fails the capture.
export const captureFlagSchema = z.enum(["engine_refused_to_answer", "empty_answer", "no_ai_overview_for_query"]);
export type CaptureFlag = z.infer<typeof captureFlagSchema>;

export const rawCaptureSchema = z
  .object({
    text: z.string(),
    format: z.enum(["markdown", "plaintext", "html"]),
    structuredCitations: z.array(structuredCitationSchema).optional(),
    structuredElements: z.array(answerElementSchema).optional(),
    modelFingerprint: z.string().optional(),
    truncated: z.boolean(),
    responseTokensEst: z.number().int().min(0),
    latencyMs: z.number().int().min(0),
    vendorRequestId: z.string().optional(),
    costUsd: z.number().min(0),
    flags: z.array(captureFlagSchema).optional(),
    // STORY-029 / NFR-SIM-12 - answer_captures.async_generated. `true`: the vendor generated the overview on demand and the adapter
    // loaded it asynchronously. `false`: it came back in the first response (or there was none). `null` is a DIFFERENT fact: the
    // surface reports no such flag at all. Absent (undefined) is every engine that has no async notion; the column stays NULL.
    asyncGenerated: z.boolean().nullable().optional(),
  })
  .strict();
export type RawCapture = z.infer<typeof rawCaptureSchema>;

// D6 (STORY-027 Implementation decisions) — no OTel SDK dependency exists
// yet. This structural interface is satisfied by a real OTel span later
// with zero changes here.
export interface CaptureSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: unknown): void;
  end(): void;
}

export interface CaptureContext {
  readonly signal: AbortSignal;
  readonly span: CaptureSpan;
  /** Writes to usage_ledger (tracking-engine.md §2). */
  recordCost(usd: number): void | Promise<void>;
}

export interface CaptureAdapter {
  readonly engineKey: EngineKey;
  readonly captureMode: CaptureMode;
  /** semver; stamped onto every result row. */
  readonly adapterVersion: string;
  readonly supportsCitations: boolean;
  readonly concurrencyPerTask: number;

  capture(input: CaptureInput, ctx: CaptureContext): Promise<RawCapture>;
  healthProbe(): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}

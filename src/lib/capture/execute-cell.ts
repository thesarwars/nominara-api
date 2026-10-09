import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import type { Cache } from "../cache/cache.port.js";
import { cacheKeyNamespace } from "../cache/key-namespace.js";
import { captureL1Key } from "./l1-cache-key.js";
import { adapterMajorOf } from "./l1-exact-hash.js";
import type { CaptureAdapter, CaptureContext, RawCapture } from "../engines/contract.js";
import { CaptureFailureError, classifyCaptureFailure } from "../engines/failure-taxonomy.js";
import { EngineRefusalError, resolveEngine } from "../engines/registry.js";

// STORY-034 — one cell, captured and recorded.
//
// This is the piece STORY-124 held a slot open for: "the capture queues with
// STORY-034". Until now `capture.execute` had no entry in `QUEUE_HANDLERS`,
// so its worker never pulled a job at all — deliberately, because a worker
// that pulled a job it could not process would fail it into the dead-letter
// queue and turn "not built yet" into "tried and failed".
//
// THE THREE OUTCOMES ARE THREE DIFFERENT ROWS, and keeping them apart is the
// whole job of this file. `answer_captures.status` already has the vocabulary:
//
//   captured — an answer came back. `cache_layer = 'live'`.
//   blocked  — we could not ask. A disabled engine, a refused key.
//   failed   — we asked and no answer came. `error_code` says which.
//
// A handler that swallowed the last two and simply wrote nothing would leave
// the matrix unable to tell "we could not ask" from "the engine did not
// mention you", which is exactly what `FR-PA-01a` and §6 forbid.

export interface CaptureCellInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly promptId: string;
  readonly promptText: string;
  readonly engineKey: string;
  readonly sampleIndex: number;
  /**
   * The version the PLANNER keyed its L1 probe on — `engines.adapter_version`
   * from the catalog, carried on the cell.
   *
   * NOT the adapter's own `adapterVersion`, and the difference is load-
   * bearing. `probeExactHash` builds its key from the catalog's value because
   * that is all planning knows; seeding the cache from the adapter's would
   * write a key no plan ever probes, and every capture this handler wrote
   * would be invisible to L1 forever. Caught the first time a reuse was
   * asserted: the catalog rows say `1.0.0` and the fixture adapters report
   * `0.1.0-fixture`.
   *
   * The ROW still records the adapter's own version — that is the audit
   * question ("what produced this answer?"), and it is a different question
   * from "what did the cache key claim?". A persistent disagreement between
   * the two is catalog drift and belongs in STORY-130's seed, not here.
   */
  readonly adapterVersion: string;
  readonly ttlSeconds: number;
  readonly locale: string;
  readonly personaHint: string | null;
  readonly normalizerVersion: string;
}

export type CaptureCellOutcome =
  | { readonly kind: "captured"; readonly latencyMs: number }
  | { readonly kind: "blocked"; readonly errorCode: string }
  | { readonly kind: "failed"; readonly errorCode: string };

/** `response_excerpt` is a preview, not a copy of the answer. */
const EXCERPT_CHARS = 280;

/**
 * A capture context with no tracing (`CaptureSpan` is STORY-027's structural
 * stand-in for an OTel span no dependency provides yet) whose `recordCost`
 * collects what the adapter reports, so `captureCell` can write it to
 * `usage_ledger` once the capture row exists (E2E-B6). The adapter calls it
 * once per capture, after validation.
 */
function captureContext(signal: AbortSignal, costs: { usd: number }): CaptureContext {
  return {
    signal,
    span: { setAttribute: () => undefined, recordException: () => undefined, end: () => undefined },
    recordCost: (usd: number) => {
      costs.usd += usd;
    },
  };
}

/**
 * What serving this cell cost us (`usage_ledger`, billing-and-credits.md): one
 * `capture` row per live cell, `credits_charged = 0` because the customer's
 * debit is the run's own `credit_ledger` entry. `source` is derived from the
 * run's trigger in SQL so the two cannot disagree. Written only for a real,
 * non-zero cost; a zero-cost fixture capture has nothing to attribute.
 */
async function recordUsageCost(tx: ClientBase, input: CaptureCellInput, usd: number): Promise<void> {
  await tx.query(
    `INSERT INTO usage_ledger
       (workspace_id, project_id, metric, quantity, unit_cost_usd, engine_key, source,
        credits_charged, reference_type, reference_id, cache_layer)
     SELECT $1, $2, 'capture', 1, $3::numeric, $4,
            CASE r.trigger WHEN 'manual' THEN 'manual_run' WHEN 'scheduled' THEN 'scheduled_run' ELSE 'system' END,
            0, 'capture_run', r.id, 'live'
       FROM capture_runs r WHERE r.id = $5`,
    [input.workspaceId, input.projectId, usd.toFixed(6), input.engineKey, input.runId],
  );
}

/**
 * Capture one cell and write its row. Returns what happened.
 *
 * RETRYABLE FAILURES THROW, terminal ones return. That split is the retry
 * ladder's interface: BullMQ retries a job that throws and gives up on one
 * that returns, so a `timeout` must reach the ladder and an `auth_failed`
 * must not — retrying a bad credential four times produces four identical
 * failures and a dead-letter entry that says nothing the first attempt did
 * not.
 *
 * `content_policy_refusal` IS NEITHER. `NFR-SIM-07`: it is data, not a
 * failure, and is never retried — the engine answered, and its answer was
 * that it would not answer. It is recorded as a capture carrying the flag,
 * because "the engine refused to discuss this" is a real measurement about a
 * prompt and losing it would misreport the prompt as never asked.
 */
export async function captureCell(
  tx: ClientBase,
  cache: Cache,
  input: CaptureCellInput,
  now: Date = new Date(),
  /** Feeds the platform-wide spend meter (Valkey); fails open, so it can never fail a capture. */
  recordSpend?: (engineKey: string, usd: number) => Promise<void>,
): Promise<CaptureCellOutcome> {
  let adapter: CaptureAdapter;
  try {
    adapter = resolveEngine(input.engineKey);
  } catch (error) {
    if (!(error instanceof EngineRefusalError)) throw error;
    // A DISABLED ENGINE IS NOT A FAILURE OF THE RUN. The plan resolved the
    // engine from `project_engines` and the registry disagreed — a catalog
    // that moved under a queued job. Recorded as `blocked` so the matrix can
    // say "we could not ask", and returned rather than thrown so the retry
    // ladder does not chase a configuration state.
    await writeCell(tx, input, now, { status: "blocked", errorCode: `engine_${error.reason}` });
    return { kind: "blocked", errorCode: `engine_${error.reason}` };
  }

  const controller = new AbortController();
  const costs = { usd: 0 };
  let raw: RawCapture;
  try {
    raw = await adapter.capture(
      {
        promptText: input.promptText,
        locale: input.locale,
        sampleIndex: input.sampleIndex,
        ...(input.personaHint !== null ? { personaHint: input.personaHint } : {}),
        requireCitations: adapter.supportsCitations,
      },
      captureContext(controller.signal, costs),
    );
  } catch (error) {
    if (!(error instanceof CaptureFailureError)) throw error;
    const classification = classifyCaptureFailure(error.code);
    if (classification === "retryable") throw error;
    if (classification === "terminal") {
      await writeCell(tx, input, now, { status: "failed", errorCode: error.code });
      return { kind: "failed", errorCode: error.code };
    }
    // `content_policy_refusal` — the engine answered, and the answer was a
    // refusal. Stored as a capture with no text and the flag, so the parser
    // sees an answer that mentioned nobody rather than a missing cell.
    await writeCell(tx, input, now, {
      status: "captured",
      adapter,
      raw: {
        text: "",
        format: "plaintext",
        truncated: false,
        responseTokensEst: 0,
        latencyMs: 0,
        costUsd: 0,
        // `engine_refused_to_answer` — the contract's own flag for exactly
        // this, rather than repeating the taxonomy code in a second vocabulary.
        flags: ["engine_refused_to_answer"],
      },
    });
    return { kind: "captured", latencyMs: 0 };
  }

  await writeCell(tx, input, now, { status: "captured", adapter, raw });
  if (costs.usd > 0) {
    await recordUsageCost(tx, input, costs.usd);
    await recordSpend?.(input.engineKey, costs.usd).catch(() => undefined);
  }

  // SEED L1 ONLY AFTER THE ROW IS WRITTEN, and only on a real answer.
  //
  // The cache is a shared read-through: another tenant's planner may take
  // this entry as an L1 hit and suppress its own cell. Publishing before the
  // row existed would let a second run reuse an answer this one had not
  // durably recorded — and if this transaction then rolled back, the shared
  // cache would hold an answer belonging to a capture that never happened.
  //
  // Best-effort: a cache write that fails costs a future run one engine call,
  // which is not worth failing a completed capture over.
  await seedSharedCache(cache, input, raw, now).catch(() => undefined);

  return { kind: "captured", latencyMs: raw.latencyMs };
}

type CellWrite =
  | { readonly status: "captured"; readonly adapter: CaptureAdapter; readonly raw: RawCapture }
  | { readonly status: "blocked" | "failed"; readonly errorCode: string };

/**
 * One row per cell.
 *
 * NO `workspace_id` PREDICATE and no tenant filter — this runs inside the
 * job's tenant context, so RLS scopes the write (`NFR-SEC-01`). The column is
 * still supplied because it is NOT NULL and the policy checks it.
 *
 * `alias_fingerprint` is deliberately absent: it stamps a SUPPRESSED row with
 * the alias set that made reuse safe, and a live capture has not been matched
 * against any alias set yet. The parser stamps it when it runs.
 */
async function writeCell(tx: ClientBase, input: CaptureCellInput, now: Date, write: CellWrite): Promise<void> {
  const captured = write.status === "captured";
  const text = captured ? write.raw.text : "";
  await tx.query(
    `INSERT INTO answer_captures
       (workspace_id, project_id, run_id, prompt_id, engine_key, sample_index, captured_at,
        capture_mode, adapter_version, normalizer_version, model_fingerprint, latency_ms,
        response_tokens_est, truncated, content_hash, response_excerpt, payload,
        flags, cache_layer, status, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::text[],'live',$19,$20)`,
    [
      input.workspaceId,
      input.projectId,
      input.runId,
      input.promptId,
      input.engineKey,
      input.sampleIndex,
      now,
      captured ? write.adapter.captureMode : "api",
      captured ? write.adapter.adapterVersion : "0.0.0",
      input.normalizerVersion,
      captured ? (write.raw.modelFingerprint ?? null) : null,
      captured ? write.raw.latencyMs : null,
      captured ? write.raw.responseTokensEst : null,
      captured ? write.raw.truncated : false,
      contentHash(text),
      captured ? text.slice(0, EXCERPT_CHARS) : null,
      // THE PARSER DOCUMENT IS NOT BUILT HERE. §6's `answer_capture.v3` is
      // EPIC-05's output; this stores the raw shape the parser will read, and
      // an empty object for a cell that produced nothing.
      captured ? JSON.stringify(rawPayload(write.raw)) : "{}",
      captured ? (write.raw.flags ?? []) : [],
      write.status,
      captured ? null : write.errorCode,
    ],
  );
}

/** What the parser needs, verbatim from the adapter. Nothing is interpreted here. */
function rawPayload(raw: RawCapture): Record<string, unknown> {
  return {
    format: raw.format,
    text: raw.text,
    ...(raw.structuredCitations !== undefined ? { structured_citations: raw.structuredCitations } : {}),
    ...(raw.structuredElements !== undefined ? { structured_elements: raw.structuredElements } : {}),
    ...(raw.vendorRequestId !== undefined ? { vendor_request_id: raw.vendorRequestId } : {}),
  };
}

function contentHash(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** The L1 entry a later run's `probeExactHash` reads. Same envelope, same key. */
async function seedSharedCache(cache: Cache, input: CaptureCellInput, raw: RawCapture, now: Date): Promise<void> {
  const key = captureL1Key({
    env: cacheKeyNamespace(),
    engineKey: input.engineKey,
    adapterMajor: adapterMajorOf(input.adapterVersion),
    promptText: input.promptText,
    locale: input.locale,
    personaHint: input.personaHint,
    ttlSeconds: input.ttlSeconds,
    nowMs: now.getTime(),
  });
  await cache.set(
    key,
    JSON.stringify({
      v: 1,
      contentHash: contentHash(raw.text).toString("hex"),
      payload: rawPayload(raw),
      excerpt: raw.text.slice(0, EXCERPT_CHARS),
    }),
    { ttlMs: input.ttlSeconds * 1000 },
  );
}

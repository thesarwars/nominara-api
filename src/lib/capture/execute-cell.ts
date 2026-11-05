import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { SCORING_VERSION } from "../scoring/index.js";
import type { ClientBase } from "pg";
import type { Cache } from "../cache/cache.port.js";
import { cacheKeyNamespace } from "../cache/key-namespace.js";
import { captureL1Key } from "./l1-cache-key.js";
import { L1_ENVELOPE_VERSION, adapterMajorOf } from "./l1-exact-hash.js";
import type { CaptureAdapter, CaptureContext, RawCapture } from "../engines/contract.js";
import { CaptureFailureError, classifyCaptureFailure } from "../engines/failure-taxonomy.js";
import { EngineRefusalError, resolveEngine } from "../engines/registry.js";
import { uuidV7 } from "../ids/uuidv7.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { encodeRawObject, rawObjectRelativeKey } from "./raw-object.js";
import type { BoundRawObjects } from "./raw-object-store.js";

const logger = new Logger("capture.execute-cell");

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
  /**
   * STORY-031 AC9 - whether the cell's prompt is in the project's priority subset (`tracked_prompts.is_priority`), read by the
   * handler inside the job's tenant context. At the spend hard stop (EC-08) priority cells are still captured and the rest are
   * refused, in every tenant alike. Absent is "not priority".
   */
  readonly isPriority?: boolean;
}

export type CaptureCellOutcome =
  | { readonly kind: "captured"; readonly latencyMs: number; /** True when the cell already had a row and nothing was done: the caller must not count it again. */ readonly replayed?: true }
  | { readonly kind: "blocked"; readonly errorCode: string }
  | {
      readonly kind: "failed";
      readonly errorCode: string;
      /** Set when the cell failed but the engine was reachable (a token-budget truncation): the breaker and health record a SUCCESS, not a failure. */
      readonly engineReachable?: { readonly latencyMs: number };
    };

/** The `error_code` of a cell refused because its engine's monthly spend ceiling is reached. */
export const ENGINE_SPEND_CEILING_REACHED = "engine_spend_ceiling_reached";

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
 * STORY-034 / ADR-0003 - A CELL IS THREE PHASES, and the three are the whole shape of `capture.execute`.
 *
 *   settledCell(tx)   PREPARE, one short transaction: has this cell already been settled by an earlier delivery?
 *   fetchCell(...)    RUN, NO transaction and NO client: the vendor call, the spend meter, the raw-object PUT.
 *   commitCell(tx)    COMMIT, a second short transaction: the advisory lock, the re-check, the row, the usage ledger, the L1 seed.
 *
 * The vendor call and the object PUT used to run INSIDE one transaction that held the run `FOR KEY SHARE` and the cell's advisory
 * lock (SCANFIX D5); NFR-ARCH-04 forbids a transaction across an external await, and the S3 client has no say in how long a PUT
 * takes. What the held locks bought is rebuilt without a transaction: see `commitCell` (the terminal-run re-check under
 * `FOR KEY SHARE` at commit) and the handler's in-flight claim (two deliveries of one cell no longer pay twice).
 *
 * RETRYABLE FAILURES THROW from `fetchCell`, terminal ones become a row. That split is the retry ladder's interface: BullMQ retries
 * a job that throws and gives up on one that returns, so a `timeout` must reach the ladder and an `auth_failed` must not.
 *
 * `content_policy_refusal` IS NEITHER. `NFR-SIM-07`: it is data, not a failure, and is never retried - it is recorded as a capture
 * carrying the flag, because "the engine refused to discuss this" is a real measurement about a prompt.
 */

/** The lock that makes check-then-insert safe: taken in `commitCell`, released at COMMIT or ROLLBACK, never leaked. */
function cellLockKey(input: CaptureCellInput): string {
  return ["capture.cell", input.runId, input.promptId, input.engineKey, String(input.sampleIndex)].join("|");
}

/** The outcome an earlier delivery already recorded for this cell, or undefined when the cell has no row yet. */
export async function settledCell(tx: ClientBase, input: CaptureCellInput): Promise<CaptureCellOutcome | undefined> {
  // IDEMPOTENT PER CELL, BEFORE ANY VENDOR CALL. A job redelivered after its transaction committed (stalled-job path) would
  // otherwise call the engine again, write a second capture and ledger row, and double-count the cell. A retryable failure throws
  // and writes no row, so it never leaves one to find here.
  const existing = await tx.query<{ status: string; error_code: string | null }>(
    `SELECT status, error_code FROM answer_captures
      WHERE run_id = $1 AND prompt_id = $2 AND engine_key = $3 AND sample_index = $4
      ORDER BY captured_at DESC LIMIT 1`,
    [input.runId, input.promptId, input.engineKey, input.sampleIndex],
  );
  const prior = existing.rows[0];
  if (prior === undefined) return undefined;
  if (prior.status === "blocked") return { kind: "blocked", errorCode: prior.error_code ?? "blocked" };
  if (prior.status === "failed") return { kind: "failed", errorCode: prior.error_code ?? "failed" };
  return { kind: "captured", latencyMs: 0, replayed: true };
}

/** What the RUN phase hands the COMMIT phase: everything needed to write the row, and nothing that needs a connection. */
export interface CellFetched {
  readonly write: CellWrite;
  /** The row id, minted in the run phase because the raw object's key embeds it. A retried attempt mints a new one. */
  readonly resultId: string;
  /** The FULL key of the object already stored, or null (nothing to store, or storage unconfigured outside production). */
  readonly rawObjectKey: string | null;
  /** What the vendor billed, for `usage_ledger`. Already charged to the spend meter. */
  readonly costUsd: number;
  /** The answer to seed L1 with: a real live answer only. */
  readonly seed: RawCapture | undefined;
  readonly now: Date;
  readonly outcome: CaptureCellOutcome;
}

export interface FetchCellPorts {
  /** Feeds the platform-wide spend meter (Valkey); fails open, so it can never fail a capture. */
  readonly recordSpend?: (engineKey: string, usd: number) => Promise<void>;
  /** The pre-call spend gate: true means the engine's monthly ceiling is reached and the vendor must not be called. It may THROW (meter unreadable) - that fails closed and reaches the retry ladder. */
  readonly ceilingReached?: (engineKey: string) => Promise<boolean>;
  /**
   * STORY-181 - where the verbatim raw answer is retained. Absent only when object storage is not configured outside production
   * (the legacy payload-only path); the handler throws in production rather than pass nothing.
   */
  readonly rawObjects?: Pick<BoundRawObjects, "put">;
}

/**
 * Capture one cell and store its raw object. NO TRANSACTION, NO CLIENT: this function has none to use.
 *
 * The object is written BEFORE the row, under a key that embeds the attempt's own row id. That is what ADR-0003 asks for and it
 * keeps the old guarantee: the row is inserted only after the PUT succeeded, so no row ever points at a missing object. The price
 * is an ORPHAN when the commit then fails or a duplicate delivery wins the cell: the object stays, inside the workspace's own prefix
 * (recorded in `docs/plans/docs-carry/STORY-181.md`; no delete is attempted because a delete is a storage call and the commit phase
 * holds a transaction).
 */
export async function fetchCell(input: CaptureCellInput, ports: FetchCellPorts = {}, now: Date = new Date()): Promise<CellFetched> {
  const { recordSpend, ceilingReached, rawObjects } = ports;
  let adapter: CaptureAdapter;
  try {
    adapter = resolveEngine(input.engineKey);
  } catch (error) {
    if (!(error instanceof EngineRefusalError)) throw error;
    // A DISABLED ENGINE IS NOT A FAILURE OF THE RUN. The plan resolved the engine from `project_engines` and the registry disagreed -
    // a catalog that moved under a queued job. Recorded as `blocked` so the matrix can say "we could not ask", and not thrown so the
    // retry ladder does not chase a configuration state.
    return unansweredCell({ status: "blocked", errorCode: `engine_${error.reason}` }, { kind: "blocked", errorCode: `engine_${error.reason}` }, now);
  }

  // THE HARD STOP (EC-08). Terminal and distinct: a `blocked` row with its own code, so the ceiling is not chased by the retry ladder.
  //
  // STORY-031 AC9 - "a hard stop that degrades to the priority prompt subset across all tenants proportionally - never by starving
  // one tenant to serve another". Applied per cell, at dispatch (planner recommendation (a)): past the ceiling a PRIORITY cell is
  // still captured and every other cell is refused. The same rule holds in every workspace, so each keeps exactly its own priority
  // subset (bounded per project by `priority_prompt_limit`) - the share is proportional to each tenant's priority set by
  // construction, and no tenant's cells are spent to serve another's. The gate is still read for a priority cell, so an unreadable
  // meter still fails closed for it.
  if ((await ceilingReached?.(input.engineKey)) === true && input.isPriority !== true) return unansweredCell({ status: "blocked", errorCode: ENGINE_SPEND_CEILING_REACHED }, { kind: "blocked", errorCode: ENGINE_SPEND_CEILING_REACHED }, now);

  const controller = new AbortController();
  const costs = { usd: 0 };
  // METERING ORDER, PINNED (E2E-B6 audit): the Valkey spend meter is charged the moment the vendor call RETURNS (or throws), before any
  // database write and independent of the job's commit. The money is spent when the vendor answers; a rollback or a crash afterwards
  // does not un-spend it, and the retry will pay again. So a rollback leaves the meter ahead of `usage_ledger`, which errs toward
  // blocking sooner. `usage_ledger` is written with the cell, so it commits or rolls back with it.
  const meterSpend = async (): Promise<void> => {
    if (costs.usd > 0) await recordSpend?.(input.engineKey, costs.usd).catch(() => undefined);
  };
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
    // A call the vendor billed is spend even when its answer is unusable or the call failed after billing.
    await meterSpend();
    if (!(error instanceof CaptureFailureError)) throw error;
    const classification = classifyCaptureFailure(error.code);
    if (classification === "retryable") throw error;
    if (classification === "terminal") {
      return unansweredCell({ status: "failed", errorCode: error.code }, { kind: "failed", errorCode: error.code }, now, costs.usd);
    }
    // `content_policy_refusal` - the engine answered, and the answer was a refusal. Stored as a capture with no text and the flag, so
    // the parser sees an answer that mentioned nobody rather than a missing cell.
    const refusal: RawCapture = {
      text: "",
      format: "plaintext",
      truncated: false,
      responseTokensEst: 0,
      latencyMs: 0,
      costUsd: 0,
      // `engine_refused_to_answer` - the contract's own flag for exactly this, rather than repeating the taxonomy code in a second vocabulary.
      flags: ["engine_refused_to_answer"],
    };
    const stored = await storeRawObject(input, now, rawObjects, refusal);
    return { write: { status: "captured", adapter, raw: refusal }, ...stored, costUsd: costs.usd, seed: undefined, now, outcome: { kind: "captured", latencyMs: 0 } };
  }

  await meterSpend();
  // A TRUNCATED EMPTY ANSWER IS A TOKEN-BUDGET FAILURE, NOT AN ANSWER (Gemini MAX_TOKENS, OpenRouter finish "length"). scoring-models
  // s2.5: a failed cell is excluded from both numerator and denominator, so it is recorded `failed` (`malformed_response`: the engine
  // returned no usable body) - not `captured` with a NULL presence the per-prompt view drops and the rollup counts. Terminal, not retried
  // (the same prompt hits the same budget); the vendor billed the call, so its cost is kept. Nothing is stored or seeded. The engine
  // breaker and health still record a SUCCESS (the engine was reachable), so one long prompt cannot re-open a half-open breaker.
  if (isBlank(raw.text) && raw.truncated) {
    incrementCounter("nominara_capture_truncated_empty_total", { engine_key: input.engineKey });
    logger.warn({ event: "capture.truncated_empty", workspace_id: input.workspaceId, run_id: input.runId, engine_key: input.engineKey });
    // The CELL failed; the ENGINE did not: it was reachable and answered within its latency, so the breaker and health hear a success.
    return unansweredCell({ status: "failed", errorCode: "malformed_response" }, { kind: "failed", errorCode: "malformed_response", engineReachable: { latencyMs: raw.latencyMs } }, now, costs.usd);
  }
  const stored = await storeRawObject(input, now, rawObjects, raw);
  return { write: { status: "captured", adapter, raw }, ...stored, costUsd: costs.usd, seed: isSeedable(raw) ? raw : undefined, now, outcome: { kind: "captured", latencyMs: raw.latencyMs } };
}

/**
 * STORY-031 AC7/AC8 - a cell its engine could not take (breaker open on quota, or degraded): `blocked` with the gate's code, never
 * sent to the vendor. Written through `commitCell` like any other cell, so it is idempotent under the cell's advisory lock.
 */
export function engineSkippedCell(errorCode: string, now: Date = new Date()): CellFetched {
  return unansweredCell({ status: "blocked", errorCode }, { kind: "blocked", errorCode }, now);
}

/** A cell with no answer to store (blocked or failed): a row, no object, and whatever the vendor billed. */
function unansweredCell(write: CellWrite, outcome: CaptureCellOutcome, now: Date, costUsd = 0): CellFetched {
  return { write, resultId: uuidV7(), rawObjectKey: null, costUsd, seed: undefined, now, outcome };
}

/**
 * STORY-181 AC1 - THE VERBATIM RAW ANSWER IS RETAINED IN OBJECT STORAGE, UPLOAD FIRST. A failed PUT throws: the job retries and no row
 * exists to find. The row id is minted here (not by the column default) because the key embeds it.
 *
 * DUAL WRITE: `payload` keeps the text too. The document, the L1/L2 reuse paths and the legacy fallback read it; the object is the
 * verbatim retained copy the parser and the raw download read.
 */
async function storeRawObject(
  input: CaptureCellInput,
  now: Date,
  rawObjects: Pick<BoundRawObjects, "put"> | undefined,
  raw: RawCapture,
): Promise<{ resultId: string; rawObjectKey: string | null }> {
  const resultId = uuidV7();
  if (rawObjects === undefined) return { resultId, rawObjectKey: null };
  try {
    const rawObjectKey = await rawObjects.put(rawObjectRelativeKey(now, resultId), encodeRawObject(rawPayload(raw)));
    return { resultId, rawObjectKey };
  } catch (error) {
    incrementCounter("nominara_capture_raw_objects_total", { outcome: "upload_failed" });
    logger.error({ event: "capture.raw_object.upload_failed", workspace_id: input.workspaceId, run_id: input.runId, error: error instanceof Error ? error.name : "unknown" });
    throw error;
  }
}

/**
 * Write the row the RUN phase prepared. A SHORT transaction: only database statements, plus the best-effort L1 seed.
 *
 * CHECK-THEN-INSERT ALONE IS NOT ENOUGH, so the check is made under a lock. `answer_captures` is partitioned on `captured_at`, so no
 * unique index on the cell can exist; the database-enforced mutual exclusion is a transaction-scoped advisory lock on the cell's
 * identity, taken HERE (it can no longer span the vendor call). A delivery that reaches commit second blocks until the first
 * commits, then finds its row and REPLAYS: nothing is written and the caller must not count the cell again. The object it stored
 * is then an orphan. A hash collision only serialises two unrelated cells.
 */
export async function commitCell(tx: ClientBase, cache: Cache, input: CaptureCellInput, fetched: CellFetched): Promise<CaptureCellOutcome> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [cellLockKey(input)]);
  const prior = await settledCell(tx, input);
  if (prior !== undefined) {
    if (fetched.rawObjectKey !== null) incrementCounter("nominara_capture_raw_objects_total", { outcome: "orphaned_by_replay" });
    return prior;
  }

  await insertCell(tx, input, fetched.now, fetched.write, fetched.resultId, fetched.rawObjectKey, fetched.write.status === "captured" ? fetched.write.raw.text : "");
  if (fetched.rawObjectKey !== null) {
    incrementCounter("nominara_capture_raw_objects_total", { outcome: "written" });
    logger.log({ event: "capture.raw_object.written", workspace_id: input.workspaceId, run_id: input.runId, result_id: fetched.resultId, bytes_before_gzip: Buffer.byteLength(fetched.write.status === "captured" ? fetched.write.raw.text : "", "utf8") });
  }
  if (fetched.costUsd > 0) await recordUsageCost(tx, input, fetched.costUsd);

  // SEED L1 ONLY AFTER THE ROW IS WRITTEN, and only on a real answer.
  //
  // The cache is a shared read-through: another tenant's planner may take this entry as an L1 hit and suppress its own cell.
  // Publishing before the row existed would let a second run reuse an answer this one had not durably recorded - and if this
  // transaction then rolled back, the shared cache would hold an answer belonging to a capture that never happened.
  //
  // Best-effort: a cache write that fails costs a future run one engine call, which is not worth failing a completed capture over.
  if (fetched.seed !== undefined) await seedSharedCache(cache, input, fetched.seed, fetched.now).catch(() => undefined);
  return fetched.outcome;
}

/** The `error_code` of a cell whose retries ran out on an error that carried no engine code of its own. */
export const RETRIES_EXHAUSTED = "retries_exhausted";

/**
 * SCANFIX D1 - the TERMINAL RECORD for a cell whose retry ladder is spent.
 *
 * `captureCell` throws retryable failures so BullMQ can retry them; on the last attempt that throw
 * used to be the end of the cell - the job went to the dead-letter queue and NO row was written, so
 * `captured + failed + skipped` could never reach `planned` and the run never finished. The handler
 * calls this on the final attempt instead: the cell becomes a `failed` row carrying the engine's own
 * code (`rate_limited`, `timeout`, `upstream_5xx`) or `retries_exhausted` for an unclassified fault.
 *
 * Idempotent: if the cell already has a row (a throw AFTER the row was written) nothing is added.
 * Runs in the COMMIT phase's transaction, under the cell's advisory lock.
 */
export async function recordExhaustedCell(
  tx: ClientBase,
  input: CaptureCellInput,
  error: unknown,
  now: Date = new Date(),
): Promise<CaptureCellOutcome> {
  // The same lock `commitCell` takes: the exhausted record is a check-then-insert too, and no longer runs under the lock of a transaction
  // that spanned the attempt. A winner's answer committed first is found below and kept.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [cellLockKey(input)]);
  const existing = await tx.query<{ status: string; error_code: string | null }>(
    `SELECT status, error_code FROM answer_captures
      WHERE run_id = $1 AND prompt_id = $2 AND engine_key = $3 AND sample_index = $4
      ORDER BY captured_at DESC LIMIT 1`,
    [input.runId, input.promptId, input.engineKey, input.sampleIndex],
  );
  const prior = existing.rows[0];
  if (prior !== undefined) {
    if (prior.status === "failed") return { kind: "failed", errorCode: prior.error_code ?? RETRIES_EXHAUSTED };
    if (prior.status === "blocked") return { kind: "blocked", errorCode: prior.error_code ?? "blocked" };
    return { kind: "captured", latencyMs: 0, replayed: true };
  }
  const errorCode = error instanceof CaptureFailureError ? error.code : RETRIES_EXHAUSTED;
  await writeCell(tx, input, now, { status: "failed", errorCode });
  return { kind: "failed", errorCode };
}

export type CellWrite =
  | { readonly status: "captured"; readonly adapter: CaptureAdapter; readonly raw: RawCapture }
  | { readonly status: "blocked" | "failed"; readonly errorCode: string };

/**
 * One row per cell, for a cell that never had a vendor answer (the exhausted-retries record). Nothing to store, so no object.
 *
 * NO `workspace_id` PREDICATE and no tenant filter - this runs inside the job's tenant context, so RLS scopes the write
 * (`NFR-SEC-01`). The column is still supplied because it is NOT NULL and the policy checks it.
 *
 * `alias_fingerprint` is deliberately absent: it stamps a SUPPRESSED row with the alias set that made reuse safe, and a live
 * capture has not been matched against any alias set yet. The parser stamps it when it runs.
 */
async function writeCell(tx: ClientBase, input: CaptureCellInput, now: Date, write: CellWrite): Promise<void> {
  await insertCell(tx, input, now, write, uuidV7(), null, "");
}

async function insertCell(
  tx: ClientBase,
  input: CaptureCellInput,
  now: Date,
  write: CellWrite,
  resultId: string,
  rawObjectKey: string | null,
  text: string,
): Promise<void> {
  const captured = write.status === "captured";
  await tx.query(
    `INSERT INTO answer_captures
       (id, workspace_id, project_id, run_id, prompt_id, engine_key, sample_index, captured_at,
        capture_mode, adapter_version, normalizer_version, model_fingerprint, latency_ms,
        response_tokens_est, truncated, content_hash, response_excerpt, payload, raw_object_key,
        flags, cache_layer, status, error_code, scoring_version, async_generated)
     VALUES ($22,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$23,$18::text[],'live',$19,$20,$21,$24)`,
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
      SCORING_VERSION,
      resultId,
      rawObjectKey,
      // STORY-029 NFR-SIM-12 - persisted on every capture that reports it; NULL for an engine with no async notion.
      captured ? (write.raw.asyncGenerated ?? null) : null,
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

/** Empty after trim: `""`, `"\n"` and spaces are all "the engine said nothing". */
function isBlank(text: string): boolean {
  return text.trim() === "";
}

/**
 * ONLY A COMPLETE, UNFLAGGED, NON-EMPTY ANSWER MAY ENTER THE SHARED CACHE.
 * Flags excluded (every `captureFlagSchema` value, pinned by a unit test so a new flag forces a decision here): `engine_refused_to_answer`,
 * `empty_answer`, `no_ai_overview_for_query`. `recordSuppressedCells` writes an L1 row with
 * `truncated = false` and no flags, so an L1 copy of a truncated answer, of a refusal (its flag would be lost) or of an empty answer
 * (it would read as a measured `brand_present = false` in another tenant) would assert something the source never did.
 */
function isSeedable(raw: RawCapture): boolean {
  return !raw.truncated && !isBlank(raw.text) && (raw.flags ?? []).length === 0;
}

/** The L1 entry a later run's `probeExactHash` reads. Same envelope, same key. */
async function seedSharedCache(cache: Cache, input: CaptureCellInput, raw: RawCapture, now: Date): Promise<void> {
  if (!isSeedable(raw)) return; // belt and braces: the caller already withholds the seed
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
      v: L1_ENVELOPE_VERSION,
      contentHash: contentHash(raw.text).toString("hex"),
      payload: rawPayload(raw),
      excerpt: raw.text.slice(0, EXCERPT_CHARS),
    }),
    { ttlMs: input.ttlSeconds * 1000 },
  );
}

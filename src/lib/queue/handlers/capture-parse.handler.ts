import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { decideL3 } from "../../capture/l3-short-circuit.js";
import { loadParseContext, parseCapture, persistParse, type CaptureRow } from "../../parser/parse-capture.js";
import { NORMALIZER_VERSION } from "../../parser/normalize.js";
import { defaultParseAlertMonitor, observationFrom, type ParseAlertMonitor } from "../../parser/parse-alerts.js";
import type { SentimentArbiter } from "../../parser/sentiment/arbiter.js";
import { SCORING_VERSION } from "../../scoring/index.js";
import { markDateDirtyIfLate, type DirtyEntry } from "../../rollup/dirty-dates.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { afterCommit } from "../../../tenancy/tenant-context.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import { QueueProducer } from "../queue-producer.js";
import type { QueueHandlerContext } from "../handlers.js";
import { requestRollupIfRunComplete as requestRunRollup } from "./run-rollup-request.js";
import { PHASES_DONE, phasedProcessor, signingKeysFromEnv, type JobProcessor } from "../worker-factory.js";
import { decodeRawObject, type RawObjectBody } from "../../capture/raw-object.js";
import { rawObjectStores, type BoundRawObjects, type RawObjectStores } from "../../capture/raw-object-store.js";
import { StorageTenancyError } from "../../storage/storage-keys.js";
import type { ObjectStoragePort } from "../../storage/storage.port.js";

// STORY-135 — `capture.parse`, the second real entry in STORY-124's registry.
//
// Its comment said the capture queues land with STORY-034. `capture.execute`
// did; this one could not, because `mention_facts` has NO DEFAULTS on
// `sentiment_label`, `sentiment_score`, `sentiment_confidence`,
// `sentiment_method` or `prominence` and all five are NOT NULL — the table
// cannot represent an unscored mention. A parse stage before STORY-038 and
// STORY-041 would have had to invent those values, which is the "`null` is
// never stored as `0`" failure the plan names as one of the two highest-risk
// correctness bugs. So it waited for the libraries, and now it does not have
// to invent anything.

const payloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    resultId: z.string().uuid(),
    projectId: z.string().uuid(),
    promptId: z.string().uuid(),
    engineKey: z.string().min(1),
    capturedAt: z.string(),
    /** A re-parse from the API (STORY-034 AC9) sets this; a fresh capture does not. */
    force: z.boolean().default(false),
  })
  .strict();

export interface CaptureParseDeps {
  /** Unbound in production — see sentiment/arbiter.ts. */
  readonly arbiter?: SentimentArbiter;
  /** STORY-037/038/039 — the meters behind the three parser alerts. Injected in tests; production uses the process-wide one. */
  readonly alerts?: ParseAlertMonitor;
  /** Injected in tests; production builds a producer from env on first use. */
  readonly enqueueRollup?: (
    queue: "rollup.metric_daily",
    workspaceId: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ) => Promise<unknown>;
  /** STORY-042 AC6 — adds a late fact's (workspace, project, date) to the `rollup_dirty` set. Injected in tests; production gets it from the worker group through the handler context. */
  readonly markRollupDirty?: (entry: DirtyEntry) => Promise<void>;
  /** STORY-181 - the object-storage port the raw capture object is read through (S3 from env when absent). */
  readonly storagePort?: ObjectStoragePort;
}

/**
 * STORY-181 AC2 / ADR-0003 - this job is PHASED: `prepare` is one short transaction, `run` reads the raw object with NO transaction
 * and NO pooled connection, and `commit` is a second short transaction that parses and writes. The tenant binding of the object
 * store is taken in `prepare` (it only reads the workspace id) and works in `run` with no context at all.
 */
interface ParsePrepared {
  readonly payload: z.infer<typeof payloadSchema>;
  /** The object to read, or null: a legacy row (`raw_object_key` NULL, read from `payload`), a reused row, or a cell with nothing to parse. */
  readonly objectKey: string | null;
  readonly reader: BoundRawObjects | null;
}

interface CaptureRecord {
  id: string;
  project_id: string;
  run_id: string | null;
  prompt_id: string;
  engine_key: string;
  captured_at: Date;
  status: string;
  content_hash: Buffer;
  payload: { text?: unknown; structured_citations?: unknown; structured_elements?: unknown } | null;
  response_excerpt: string | null;
  flags: string[];
  normalizer_version: string;
  scoring_version: string;
  alias_fingerprint: Buffer | null;
  cache_layer: string;
  source_result_id: string | null;
  brand_present: boolean | null;
  truncated: boolean;
}

/**
 * STORY-032 AC7 — set on a reused row whose answer could not be recovered (an L2 source whose payload retention
 * cleared or whose row is gone). Marks the row "tried and cannot", so the run's rollup is not held for a re-match
 * that will never come. Cleared by the next successful re-match.
 */
export const REMATCH_UNAVAILABLE_FLAG = "rematch_unavailable";

export function createCaptureParseHandler(_context: QueueHandlerContext, deps?: CaptureParseDeps): JobProcessor {
  const logger = new Logger("capture.parse");

  // Built on the first rollup request, not at registration (see capture.execute:
  // the static handler table is evaluated in every worker group).
  let producer: QueueProducer | undefined;
  const enqueueRollup =
    deps?.enqueueRollup ??
    (async (queue, workspaceId, rollupPayload, idempotencyKey): Promise<unknown> => {
      producer ??= new QueueProducer(
        createQueueWorkerConnection(_context.env.QUEUE_REDIS_URL),
        queueKeyPrefix(_context.env.NODE_ENV),
        signingKeysFromEnv(_context.env),
      );
      return producer.enqueueTenantJob(queue, workspaceId, rollupPayload, { idempotencyKey });
    });

  // STORY-042 AC6 — the dirty-set writer belongs to the worker group (it owns the connection and closes it on shutdown), so
  // the handler never opens a connection of its own. With none supplied the mark FAILS visibly (retried, then logged and
  // counted as `nominara_rollup_dirty_mark_failed_total`) rather than quietly dialling a default Valkey.
  const markRollupDirty =
    deps?.markRollupDirty ??
    _context.markRollupDirty ??
    (async (): Promise<void> => {
      throw new Error("no dirty-set writer was supplied to the capture.parse handler");
    });

  /** NEW-A-7 — see run-rollup-request.ts. FROM HERE AND NOT FROM THE FINALISATION: finalisation precedes parsing, so a rollup requested there would read facts that do not exist yet. */
  const requestRollupIfRunComplete = (tx: ClientBase, record: CaptureRecord, workspaceId: string): Promise<void> =>
    requestRunRollup(
      tx,
      { runId: record.run_id, projectId: record.project_id, workspaceId, capturedAt: record.captured_at },
      enqueueRollup,
      logger,
    );

  /** STORY-032 AC7 observability — IDs only, never the answer text or an alias. */
  const rematchOutcome = (outcome: "matched" | "already_matched" | "source_unavailable", workspaceId: string, resultId: string): void => {
    incrementCounter("nominara_capture_rematch_total", { outcome });
    logger.log({ event: "capture.rematch", outcome, workspace_id: workspaceId, result_id: resultId });
  };

  let stores: RawObjectStores | undefined;
  const rawStores = (): RawObjectStores => (stores ??= rawObjectStores(_context.env, deps?.storagePort));

  const prepare = async (tx: ClientBase, job: Job): Promise<ParsePrepared | typeof PHASES_DONE> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
    const found = await tx.query<{ raw_object_key: string | null; status: string; cache_layer: string }>(
      "SELECT raw_object_key, status, cache_layer FROM answer_captures WHERE id = $1",
      [payload.resultId],
    );
    const row = found.rows[0];
    if (row === undefined) {
      // Deleted by retention, or invisible under RLS. Nothing to parse and nothing wrong.
      logger.log(`capture ${payload.resultId} is gone; skipping parse`);
      return PHASES_DONE;
    }
    // Only a row that will actually be parsed needs its object. A failed/blocked cell has none, and a reused row (`skipped`) reads
    // its text from its own payload or its source (L1/L2), never from an object of its own.
    const parseable = row.status === "captured" || row.status === "parsed";
    if (row.raw_object_key === null || !parseable) return { payload, objectKey: null, reader: null };
    // Bound HERE, inside the tenant context. Unconfigured storage with a row that names an object is an error: it cannot be read.
    return { payload, objectKey: row.raw_object_key, reader: rawStores().bindForRead() };
  };

  const run = async (prepared: ParsePrepared): Promise<RawObjectBody | null> => {
    if (prepared.objectKey === null || prepared.reader === null) return null;
    try {
      const bytes = await prepared.reader.getStored(prepared.objectKey);
      incrementCounter("nominara_capture_raw_object_reads_total", { outcome: "ok" });
      return decodeRawObject(bytes);
    } catch (error) {
      if (error instanceof StorageTenancyError) {
        // A stored key outside this workspace's prefix: corruption or an attack. IDs only; never the key. The parse fails (it is
        // retried, then dead-lettered) and writes nothing - it must not fall back to payload, which would hide the violation.
        incrementCounter("nominara_capture_raw_object_reads_total", { outcome: "tenancy_refused" });
        logger.warn({ event: "raw_object_tenancy_refused", workspace_id: prepared.payload.workspaceId, result_id: prepared.payload.resultId });
      } else {
        incrementCounter("nominara_capture_raw_object_reads_total", { outcome: "failed" });
      }
      throw error;
    }
  };

  const commit = async (tx: ClientBase, prepared: ParsePrepared, rawObject: RawObjectBody | null): Promise<void> => {
    const payload = prepared.payload;

    // FOR UPDATE (STORY-034 AC9): a customer's re-parse of this capture and this job both delete-then-insert its facts; the row
    // lock makes the second wait for the first's commit instead of interleaving with it.
    const found = await tx.query<CaptureRecord>(
      `SELECT id, project_id, run_id, prompt_id, engine_key, captured_at, status, content_hash,
              payload, response_excerpt, flags, normalizer_version, scoring_version, alias_fingerprint,
              cache_layer, source_result_id, brand_present, truncated
         FROM answer_captures
        WHERE id = $1
        FOR UPDATE`,
      [payload.resultId],
    );
    const record = found.rows[0];
    if (record === undefined) {
      // Deleted by retention, or invisible under RLS. Nothing to parse and
      // nothing wrong — a throw would send the job down the retry ladder for
      // a row that is gone.
      logger.log(`capture ${payload.resultId} is gone; skipping parse`);
      return;
    }

    // A cell that could not be captured has no text to parse. `blocked` and
    // `failed` are real states carrying an error code, and turning them into
    // `parsed` would erase the distinction the matrix depends on.
    if (record.status === "blocked" || record.status === "failed") {
      logger.log(`capture ${payload.resultId} is ${record.status}; nothing to parse`);
      return;
    }

    // STORY-032 AC7 — a REUSED (L1/L2) row is `skipped`, and it STAYS skipped: `run-progress.ts` counts
    // captured+parsed from the rows and skipped from the run row, so a reused row turned `parsed` would be counted
    // twice, and the second count flows into `finalizeRun` and the credit settlement. This job carries the FACTS
    // onto it; it never moves its status. (`persistParse` enforces the same rule in SQL.)
    const reused = record.status === "skipped";
    if (reused && record.cache_layer === "live") {
      // `skipped` with no cache layer is not a reused cell; there is no answer to re-match and none to invent.
      logger.log(`capture ${payload.resultId} is skipped without a cache layer; nothing to re-match`);
      return;
    }

    const { context, aliasFingerprint } = await loadParseContext(tx, record.project_id);

    // §7's L3 short-circuit, using the resolver STORY-032 already built: an
    // identical answer, an unchanged normaliser and scoring version, and an
    // unchanged alias set means the prior parse still holds. Skipping the
    // work is worth real money — it is the entity matcher, the arbiter and
    // every citation redirect — but only when all four agree.
    //
    // `force` bypasses it, because a re-parse whose whole purpose is to
    // recompute must not be told the prior answer is still good.
    const decision = decideL3(
      {
        contentHash: record.content_hash,
        normalizerVersion: NORMALIZER_VERSION,
        scoringVersion: SCORING_VERSION,
        aliasFingerprint,
      },
      priorOf(record),
    );
    if (!payload.force && decision.shortCircuit) {
      logger.log(`capture ${payload.resultId} short-circuits to ${decision.sourceResultId}`);
      if (reused) rematchOutcome("already_matched", payload.workspaceId, record.id);
      // A redelivery after a failed rollup enqueue lands here; re-request (same key).
      await requestRollupIfRunComplete(tx, record, payload.workspaceId);
      return;
    }

    const resolved = reused ? await reusedTextOf(tx, record, payload.workspaceId) : null;
    const text = resolved !== null ? (resolved.kind === "text" ? resolved.text : null) : textOf(record, rawObject);
    if (resolved?.kind === "missing") {
      // The answer cannot be recovered. NOT marked parsed (that would count the cell twice) and not left looking
      // pending (that would hold the run's rollup for ever): flagged, unscored, still skipped.
      await tx.query(
        "UPDATE answer_captures SET flags = array_append(flags, $2) WHERE id = $1 AND NOT ($2 = ANY(flags))",
        [record.id, REMATCH_UNAVAILABLE_FLAG],
      );
      rematchOutcome("source_unavailable", payload.workspaceId, record.id);
      await requestRollupIfRunComplete(tx, record, payload.workspaceId);
      return;
    }
    // scoring-models s2.5: "Engine refused to answer: sov = 0, flag engine_refused_to_answer, the cell counts in the denominator", and
    // FR-SIM-01f makes an empty answer a valid observation too. The cell WAS asked and answered with nothing, so it is a measurement:
    // brand_present = false, sov = 0, no mentions - not NULL, which the denominator reads as "not measured". This is a `captured`/`parsed`
    // row only: `blocked` and `failed` returned above ("we could not ask" is not data), and a reused row whose source is gone returned
    // above too. A row with NO text at all (payload expired, no object) is not an empty answer and keeps the NULL below.
    //
    // A REUSED row whose source answered with nothing (`kind: "empty"`) is the same observation: it parses "" and carries the source's refusal
    // flag. A TRUNCATED empty answer (Gemini MAX_TOKENS, text "", truncated: true) is a token-budget failure, not an answer, so it is NOT an
    // empty answer and keeps NULL (the capture stage should classify it `failed`; recorded as a follow-up).
    const emptyAnswer =
      resolved !== null
        ? resolved.kind === "empty"
        : text === null && !record.truncated && (record.flags.includes(ENGINE_REFUSED_FLAG) || answeredWithNothing(record, rawObject));
    const parseText = emptyAnswer ? "" : text;
    if (parseText === null) {
      // Reaching here means a LIVE row (a reused row either has text, is an empty answer, or returned above as unavailable) with no
      // text to parse: its payload expired or there is no object, or it is a truncated empty answer. Marked parsed with no facts rather
      // than left `captured` forever: there is genuinely nothing in it to match, and a cell stuck at `captured` would keep its run below
      // 100% and keep this job coming back.
      await tx.query("UPDATE answer_captures SET status = 'parsed', normalizer_version = $2, scoring_version = $3 WHERE id = $1", [
        record.id,
        NORMALIZER_VERSION,
        SCORING_VERSION,
      ]);
      await requestRollupIfRunComplete(tx, record, payload.workspaceId);
      return;
    }

    const capture: CaptureRow = {
      resultId: record.id,
      workspaceId: payload.workspaceId,
      projectId: record.project_id,
      promptId: record.prompt_id,
      engineKey: record.engine_key,
      capturedAt: record.captured_at,
      text: parseText,
      flags: [
        ...record.flags.filter((flag) => flag !== REMATCH_UNAVAILABLE_FLAG),
        // The source's refusal travels onto the reused row, so the row reads as the refusal it reuses.
        ...(resolved?.kind === "empty" && resolved.refused && !record.flags.includes(ENGINE_REFUSED_FLAG) ? [ENGINE_REFUSED_FLAG] : []),
      ],
      ...structuredOf(record, rawObject),
    };

    const result = await parseCapture(capture, {
      ...context,
      ...(deps?.arbiter !== undefined ? { arbiter: deps.arbiter } : {}),
    });

    // Stage 6 — the facts and the capture, in the job's own transaction.
    await persistParse(tx, capture, result, aliasFingerprint);

    // STORY-042 AC6 / EC-12 — facts written onto a day that is already closed and rolled up make that rollup stale:
    // mark the workspace-local date dirty (after commit) so the dirty-date sweep reprocesses it within 15 minutes.
    await markDateDirtyIfLate(tx, { workspaceId: payload.workspaceId, projectId: record.project_id, capturedAt: record.captured_at }, markRollupDirty, logger);

    // STORY-037 AC10 / STORY-038 AC12 / STORY-039 AC8 — feed the three alert meters from what was just persisted.
    // AFTER COMMIT: the meters are cumulative, so observing inside the transaction counts an attempt that then rolls
    // back and is retried — the same parse twice. An alert path that failed must never fail the parse it observed:
    // the facts are committed, and a retry would run the whole parse again for a metering fault.
    const observation = observationFrom(capture, result);
    afterCommit(() => {
      try {
        (deps?.alerts ?? defaultParseAlertMonitor).observe(observation);
      } catch (error) {
        logger.error(`parse alert metering failed for capture ${payload.resultId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    if (reused) rematchOutcome("matched", payload.workspaceId, record.id);
    await requestRollupIfRunComplete(tx, record, payload.workspaceId);

    logger.log(
      `parsed ${record.id}: ${String(result.mentions.length)} mentions, ${String(result.citations.length)} citations`,
    );
  };

  return phasedProcessor<ParsePrepared, RawObjectBody | null>({ prepare, run, commit: (tx, prepared, rawObject) => commit(tx, prepared, rawObject) });
}

const ENGINE_REFUSED_FLAG = "engine_refused_to_answer";

/** The row carries a text field and it is the empty string - an answer of nothing, as opposed to no text field at all. */
function answeredWithNothing(record: CaptureRecord, rawObject: RawObjectBody | null): boolean {
  return (rawObject !== null ? rawObject.text : record.payload?.text) === "";
}

/** The prior parse's identity, or null when this row has never been parsed. */
function priorOf(record: CaptureRecord): Parameters<typeof decideL3>[1] {
  // A reused row counts as already matched only once it HAS been: `brand_present` is NULL until the first re-match.
  // Its alias fingerprint cannot say so — the planner stamps the CURRENT fingerprint on it at plan time, so
  // reading the stamp as "already matched" is exactly the shortcut AC7 forbids.
  const matched = record.status === "parsed" || (record.status === "skipped" && record.brand_present !== null);
  if (!matched) return null;
  return {
    resultId: record.id,
    contentHash: record.content_hash,
    normalizerVersion: record.normalizer_version,
    scoringVersion: record.scoring_version,
    aliasFingerprint: record.alias_fingerprint,
  };
}

/**
 * The answer text.
 *
 * FROM THE RAW OBJECT WHEN THE ROW HAS ONE (STORY-181 AC2), else from `payload.text` (a legacy row). NEVER FROM
 * `response_excerpt`. The excerpt is 280 characters written for a preview; parsing it would produce offsets into a
 * truncation and report every entity past character 280 as absent — a silently wrong answer rather than a missing one.
 */
function textOf(record: CaptureRecord, rawObject: RawObjectBody | null): string | null {
  const text = rawObject !== null ? rawObject.text : record.payload?.text;
  return typeof text === "string" && text.length > 0 ? text : null;
}

/** What a reused row's answer resolved to: text, an answer of nothing (a refusal or an empty answer - a measurement), or nothing recoverable. */
type ReusedText = { kind: "text"; text: string } | { kind: "empty"; refused: boolean } | { kind: "missing" };

/**
 * STORY-032 AC7 — the answer text of a REUSED row.
 *
 * An L1 row carries its own `payload.text` (the shared entry's answer). An L2 row carries none and reaches its
 * source through `source_result_id`; that read is SCOPED TO THIS WORKSPACE AND PROJECT in the statement itself, not
 * left to RLS alone: `source_result_id` has no foreign key, so a stale or poisoned pointer must resolve to nothing
 * rather than to another tenant's answer. (RLS is the guarantee; the predicate is why the failure is a miss
 * rather than a different tenant's text under a policy mistake.)
 *
 * `id` alone is not indexed (the key is (captured_at, id)), so this scans partitions as the handler's own lookup
 * by id does; one read per reused cell, and the planner already paid the larger scan.
 */
async function reusedTextOf(tx: ClientBase, record: CaptureRecord, workspaceId: string): Promise<ReusedText> {
  const own = (record.payload as { text?: unknown } | null)?.text;
  if (typeof own === "string") {
    if (own.length > 0) return { kind: "text", text: own };
    // A truncated empty answer is a failure, not an answer; a reused row cannot be marked parsed, so it is unavailable.
    return record.truncated ? { kind: "missing" } : { kind: "empty", refused: record.flags.includes(ENGINE_REFUSED_FLAG) };
  }
  if (record.source_result_id === null) return { kind: "missing" };
  const source = await tx.query<{ payload: CaptureRecord["payload"]; flags: string[]; truncated: boolean }>(
    "SELECT payload, flags, truncated FROM answer_captures WHERE id = $1 AND workspace_id = $2 AND project_id = $3",
    [record.source_result_id, workspaceId, record.project_id],
  );
  const row = source.rows[0];
  const text = row?.payload?.text;
  if (row === undefined || typeof text !== "string") return { kind: "missing" };
  if (text.length > 0) return { kind: "text", text };
  return row.truncated ? { kind: "missing" } : { kind: "empty", refused: row.flags.includes(ENGINE_REFUSED_FLAG) };
}

function structuredOf(record: CaptureRecord, rawObject: RawObjectBody | null): Partial<Pick<CaptureRow, "structuredCitations" | "structuredElements">> {
  const citations = rawObject !== null ? rawObject.structured_citations : record.payload?.structured_citations;
  const elements = rawObject !== null ? rawObject.structured_elements : record.payload?.structured_elements;
  return {
    ...(Array.isArray(citations) ? { structuredCitations: citations as NonNullable<CaptureRow["structuredCitations"]> } : {}),
    ...(Array.isArray(elements) ? { structuredElements: elements as NonNullable<CaptureRow["structuredElements"]> } : {}),
  };
}

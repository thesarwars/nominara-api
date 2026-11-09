import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { NotFoundError } from "../../../api/errors/domain-errors.js";
import type { EnqueueEmbedBatch } from "../../embedding/prompt-embedding-request.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { chunkDocument, type TokenCounter } from "../corpus/chunker.js";
import { requestEmbeds } from "./advance.js";
import { analyseNodes } from "./analyse-nodes.js";
import { computeAlignment } from "./compute.js";
import { ALIGNMENT_JOB } from "./constants.js";
import { hashOf } from "./session.js";

// STORY-192 / STORY-059 AC11 - the DEBOUNCED, in-database, free recompute of the customer's draft.
//
//   saveAlignmentDraft   in the REQUEST's transaction: store the draft, replace its chunks (chunking is pure CPU, no network) and push the
//                        row's `draft_recompute_due_at` forward. Nothing is embedded or computed here, so the request answers fast
//                        (api-specification.md: 200 ms p95) whatever the draft's size.
//   advanceAlignmentDraft the delayed job's step. A job acts ONLY once the row is due, so a burst of edits is one recompute over the LAST
//                        text: an earlier edit's job finds the due time moved ahead of it (`not_due`), and a redelivered job finds nothing
//                        pending (`idle`). The debounce state is the row, so a Valkey flush loses no recompute.
//
// LIVE AND DRAFT ARE KEPT APART. A draft recompute measures the DRAFT's chunks (`is_draft = true`) and writes `current_alignment`, the
// coverage and the recommendations; it never touches `baseline_alignment`, `live_content_md` or a live chunk's figure (`computeAlignment`'s
// draft branch is the one place that guarantees it, and the integration spec pins it).
//
// The vectors of a new draft are asked for after the commit; the step answers `waiting` until they are in, and the draft is `failed` (not
// pending for ever) once the deadline passes. No credit is charged anywhere in this file.

const tracer = trace.getTracer("nominara.geo-alignment");
const logger = new Logger("geo.alignment");

export interface SavedDraft {
  readonly chunkIds: readonly string[];
  /**
   * The due time exactly as the database holds it (microseconds). A JS Date keeps milliseconds only, so comparing a Date with the column never matches:
   * everything that asks "is this still MY draft's due time?" compares this text with `draft_recompute_due_at::text`.
   */
  readonly dueText: string;
}

export async function saveAlignmentDraft(tx: ClientBase, tokenizer: TokenCounter, sessionId: string, markdown: string, debounceMs: number): Promise<SavedDraft> {
  // The row lock serialises two saves (and a recompute) of one session: the later text wins and the chunks always match the stored draft.
  const found = await tx.query<{ project_id: string; target_url: string }>(
    "SELECT project_id, target_url FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace() FOR UPDATE",
    [sessionId],
  );
  const session = found.rows[0];
  if (session === undefined) throw new NotFoundError({ message: "no such alignment session" });

  const chunks = chunkDocument(markdown, tokenizer);
  await tx.query("DELETE FROM content_chunks WHERE session_id = $1 AND is_draft AND workspace_id = app.current_workspace()", [sessionId]);
  let chunkIds: string[] = [];
  if (chunks.length > 0) {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO content_chunks (workspace_id, project_id, session_id, url, chunk_index, text, token_count, content_hash, is_draft)
       SELECT app.current_workspace(), $1, $2, $3, v.idx, v.text, v.tc, decode(v.ch, 'hex'), true
         FROM unnest($4::int[], $5::text[], $6::int[], $7::text[]) AS v(idx, text, tc, ch)
       RETURNING id`,
      [session.project_id, sessionId, session.target_url, chunks.map((c) => c.index), chunks.map((c) => c.text), chunks.map((c) => c.tokenCount), chunks.map((c) => hashOf(c.text).toString("hex"))],
    );
    chunkIds = inserted.rows.map((row) => row.id).sort();
  }
  const due = await tx.query<{ due: string }>(
    `UPDATE geo_alignments
        SET draft_content_md = $2, draft_state = 'pending', draft_recompute_due_at = now() + make_interval(secs => $3::double precision / 1000.0), updated_at = now()
      WHERE id = $1 AND workspace_id = app.current_workspace()
      RETURNING draft_recompute_due_at::text AS due`,
    [sessionId, markdown, debounceMs],
  );
  incrementCounter("nominara_geo_alignment_draft_saved_total");
  return { chunkIds, dueText: due.rows[0]!.due };
}

export interface DraftDeps {
  readonly workspaceId: string;
  readonly runInTx: <T>(fn: (tx: ClientBase) => Promise<T>) => Promise<T>;
  readonly tokenizer: TokenCounter;
  readonly enqueueEmbed?: EnqueueEmbedBatch;
  readonly now?: () => Date;
}

/**
 * ready    the draft was measured and the session says so
 * waiting  the draft's chunks (or a concept) still lack a vector: they were asked for again; the caller tries again later
 * not_due  a later edit moved the due time ahead of this job; `dueInMs` says how far
 * idle     nothing pending: a redelivered or superseded job
 * failed   the vectors did not arrive before the deadline
 * gone     no such session in this workspace
 */
export type DraftOutcome = { readonly state: "ready" | "waiting" | "not_due" | "idle" | "failed" | "gone"; readonly dueInMs: number | null };

export async function advanceAlignmentDraft(deps: DraftDeps, sessionId: string): Promise<DraftOutcome> {
  const started = performance.now();
  return tracer.startActiveSpan("geo.alignment.draft_recompute", async (span) => {
    try {
      const outcome = await draftStep(deps, sessionId);
      span.setAttribute("nominara.alignment.draft_state", outcome.state);
      incrementCounter("nominara_geo_alignment_draft_recompute_total", { state: outcome.state });
      // The recompute step alone (queue wait and the debounce window excluded): the in-database cost, free of any credit.
      if (outcome.state === "ready") observeValue("nominara_geo_alignment_draft_recompute_seconds", (performance.now() - started) / 1000);
      logger.log({ event: "geo.alignment.draft_advanced", workspace_id: deps.workspaceId, session_id: sessionId, state: outcome.state });
      return outcome;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      incrementCounter("nominara_geo_alignment_draft_recompute_total", { state: "error" });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function draftStep(deps: DraftDeps, sessionId: string): Promise<DraftOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  const read = await deps.runInTx(async (tx) => {
    const found = await tx.query<{ draft_state: string | null; due: boolean; due_in_ms: number | null; due_text: string | null; due_at: Date | null }>(
      `SELECT draft_state, draft_recompute_due_at <= now() AS due,
              ceil(extract(epoch FROM (draft_recompute_due_at - now())) * 1000)::int AS due_in_ms,
              draft_recompute_due_at::text AS due_text, draft_recompute_due_at AS due_at
         FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace()`,
      [sessionId],
    );
    return found.rows[0];
  });
  if (read === undefined) return { state: "gone", dueInMs: null };
  if (read.draft_state !== "pending" || read.due_text === null) return { state: "idle", dueInMs: null };
  if (!read.due) return { state: "not_due", dueInMs: Math.max(1, read.due_in_ms ?? 1) };

  // The deadline runs from the moment the draft became due: a draft that never gets its vectors is failed, not pending for ever.
  if (read.due_at !== null && now.getTime() - new Date(read.due_at).getTime() > ALIGNMENT_JOB.draftDeadlineMs) {
    await deps.runInTx((tx) =>
      tx.query(
        `UPDATE geo_alignments SET draft_state = 'failed', draft_recompute_due_at = NULL, updated_at = now()
          WHERE id = $1 AND workspace_id = app.current_workspace() AND draft_state = 'pending' AND draft_recompute_due_at::text = $2`,
        [sessionId, read.due_text],
      ),
    );
    return { state: "failed", dueInMs: null };
  }

  // The draft's chunks that still lack a vector (a hash another embedded draft chunk of this workspace and model already holds counts as embedded).
  const missing = await deps.runInTx(async (tx) => {
    const chunks = await tx.query<{ id: string }>(
      `SELECT c.id FROM content_chunks c JOIN geo_alignments g ON g.id = c.session_id
        WHERE g.id = $1 AND g.workspace_id = app.current_workspace() AND c.workspace_id = app.current_workspace() AND c.is_draft
          AND NOT EXISTS (SELECT 1 FROM content_chunks x
                           WHERE x.workspace_id = app.current_workspace() AND x.content_hash = c.content_hash AND x.is_draft = c.is_draft
                             AND x.embedding_model = g.embedding_model AND x.embedding IS NOT NULL)
        ORDER BY c.id`,
      [sessionId],
    );
    return chunks.rows.map((r) => r.id);
  });
  if (missing.length > 0) {
    await requestEmbeds(deps, "content_chunks", missing);
    return { state: "waiting", dueInMs: null };
  }

  // Measure the draft and mark it ready in ONE transaction, under the row lock, and only if no later edit moved the due time meanwhile.
  const outcome = await deps.runInTx(async (tx) => {
    const locked = await tx.query<{ due_text: string | null; draft_state: string | null }>(
      `SELECT draft_recompute_due_at::text AS due_text, draft_state FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace() FOR UPDATE`,
      [sessionId],
    );
    const row = locked.rows[0];
    if (row === undefined) return "gone" as const;
    if (row.draft_state !== "pending" || row.due_text !== read.due_text) return "superseded" as const;
    await computeAlignment(tx, sessionId, { draft: true });
    const summary = await analyseNodes(tx, sessionId, deps.tokenizer, { draft: true });
    if (summary.pending) return "waiting" as const;
    await tx.query(
      `UPDATE geo_alignments SET draft_state = 'ready', draft_recompute_due_at = NULL, updated_at = now() WHERE id = $1 AND workspace_id = app.current_workspace()`,
      [sessionId],
    );
    return "ready" as const;
  });
  if (outcome === "gone") return { state: "gone", dueInMs: null };
  if (outcome === "superseded") return { state: "not_due", dueInMs: null };
  return { state: outcome, dueInMs: null };
}

import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { UnrecoverableError, type Job } from "bullmq";
import type { ClientBase } from "pg";
import { EmbeddingProviderError, type EmbeddingProvider } from "../../../modules/prompts/ports/embedding-provider.js";
import { selectEmbeddingProvider } from "../../../modules/prompts/embedding-provider.selector.js";
import type { TextEmbedder } from "../../categories/classify.js";
import { lockNodeScope } from "../../geo/alignment/scope-lock.js";
import { CircuitBreaker, CircuitOpenError } from "../../resilience/circuit-breaker.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { resolveBillingPeriod } from "../../usage/billing-period.js";
import { meterInternalUsage } from "../../usage/tier-caps.js";
import {
  embedBatchPayloadSchema,
  splitIntoProviderBatches,
  type EmbedBatchPayload,
  type EmbedTable,
} from "../../embedding/embed-batch.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, type JobProcessor } from "../worker-factory.js";

// STORY-133 - `embed.batch`: the first thing that ever writes a vector.
//
// Until this existed `worker-embed` had nothing to run and every embedding column was NULL, so L2's `IS NOT NULL` guard made
// semantic suppression silently match nothing. This is the ONLY caller of the EMBEDDING_PROVIDER port (NFR-ARCH-01; eslint.config.js
// refuses any other importer).
//
// PHASED (ADR-0003 / KAD-06). The provider call sits between two short tenant transactions and holds neither a transaction nor a
// pooled connection:
//   prepare  read the rows named by the payload, reuse stored vectors for unchanged content (L7), decide what needs the provider.
//   run      the provider calls, 96 texts each. Nothing is written.
//   commit   ONE transaction writes every vector of the job and meters the tokens. A provider failure anywhere in `run` throws
//            before `commit`, so a batch is embedded whole or not at all (no partial batch).
//
// IDEMPOTENT UNDER AT-LEAST-ONCE DELIVERY (NFR-ARCH-02). The queue key is `emb:{sha256(batch)}` over the SORTED ids
// (embed-batch.ts), so the same batch is the same job. Redelivery after success finds every row already embedded, so `prepare`
// ends the job with no provider call and no tokens. `commit` writes only `WHERE embedding IS NULL`, so two deliveries racing past
// `prepare` cannot overwrite each other.
//
// L7 (section 8) happens BEFORE the provider call: an unchanged chunk (same workspace, content_hash and model) copies the stored
// vector in SQL and is never sent. Identical texts inside one batch are sent once.
//
// THE TOKENS are what the provider reported (never an estimate) and go through `meterInternalUsage`, the internal-cost path: no
// reservation, no ceiling read. Nothing here ever reads `limit_value`, so a depleted, over-ceiling or absent budget cannot fail
// the job. A metering error is swallowed in a savepoint and counted - the vectors are already paid for.
//
// FAIL OPEN. An open provider circuit makes the job fail onto the retry ladder (rows stay NULL, which L2 treats as "no suppression"):
// suppression is an optimisation, and a capture run never calls this path at all.
//
// All vector arithmetic stays in SQL. Vectors pass through here only as text handed to `::halfvec`.

const tracer = trace.getTracer("nominara.embed-batch");

interface PendingRow {
  readonly id: string;
  readonly text: string;
  /** content_hash, hex - chunks and passages only. */
  readonly hash: string | null;
  readonly isDraft: boolean;
}

interface EmbedPrepared {
  readonly payload: EmbedBatchPayload;
  readonly model: string;
  readonly dimensions: number;
  /** Distinct texts to send, in a stable order. */
  readonly texts: readonly string[];
  /** Rows to write: its id and the index of its text in `texts`. */
  readonly writes: readonly { readonly id: string; readonly textIndex: number }[];
  readonly reused: number;
}

interface EmbedFetched {
  /** One pgvector text literal per entry of `texts`. */
  readonly vectors: readonly string[];
  readonly totalTokens: number;
  readonly calls: number;
}

/**
 * A provider failure part-way through `run`, carrying what the calls that DID succeed were charged.
 *
 * Retryable (a 429, a 5xx, an open circuit) rides the queue's retry ladder. A PERMANENT one (a 4xx, a response without usage, a model
 * or shape mismatch after a paid call) is the `UnrecoverableError` subclass below: BullMQ fails it on the first attempt, so a
 * request that can never succeed is not paid for three more times.
 */
export class EmbedBatchFailedError extends Error {
  readonly spentTokens: number;
  readonly retryable: boolean = true;
  constructor(cause: unknown, spentTokens: number) {
    super(embedBatchFailureMessage(cause), { cause });
    this.name = "EmbedBatchFailedError";
    this.spentTokens = spentTokens;
  }
}

export class EmbedBatchPermanentError extends UnrecoverableError {
  readonly spentTokens: number;
  readonly retryable: boolean = false;
  constructor(cause: unknown, spentTokens: number) {
    super(embedBatchFailureMessage(cause));
    this.name = "EmbedBatchPermanentError";
    this.cause = cause;
    this.spentTokens = spentTokens;
  }
}

function embedBatchFailureMessage(cause: unknown): string {
  return `embed.batch provider failure (${cause instanceof Error ? cause.name : "unknown"})`;
}

function isRetryable(cause: unknown): boolean {
  return !(cause instanceof EmbeddingProviderError) || cause.retryable;
}

/**
 * STORY-192 - the model of the provider this process would embed with. The alignment job and the route that opens a session read it HERE
 * because the provider, its adapters and its selector are importable from this file only (NFR-ARCH-01); the model is a string, so no provider
 * object leaves the file. A session is pinned to this value when it opens, and is stale if it ever differs from it.
 */
export function selectedEmbeddingModel(env: Parameters<typeof selectEmbeddingProvider>[0]): string {
  return selectEmbeddingProvider(env).model;
}

/**
 * STORY-189 / decision 88(b) - the same provider, as a plain text embedder, for category classification in `crawl.discover`'s no-transaction
 * `run` phase. Exported from THIS file for the reason `selectedEmbeddingModel` is: the provider, its adapters and its selector are importable
 * here only (NFR-ARCH-01), so a second caller gets a function that returns vectors, never the provider. Reachable from queue handlers only.
 */
export function textEmbedderFor(env: Parameters<typeof selectEmbeddingProvider>[0]): TextEmbedder {
  const provider = selectEmbeddingProvider(env);
  return {
    model: provider.model,
    async embed(texts) {
      const result = await provider.embed(texts);
      return { vectors: result.vectors, totalTokens: result.totalTokens };
    },
  };
}

export interface EmbedBatchDeps {
  /** Injected in tests; production selects from env on first use. */
  readonly provider?: EmbeddingProvider;
  /** Injected in tests; production builds one breaker per handler (NFR-ARCH-05: 50% over a window, 30 s open). */
  readonly breaker?: CircuitBreaker;
}

// EVERY statement below also carries `workspace_id = app.current_workspace()`. RLS is the guarantee; this is defence in depth for the
// one connection that does not have it (a superuser run, a BYPASSRLS maintenance role): a job signed for workspace A that names
// workspace B's ids then still reads, writes and meters nothing of B's.
//
// `tracked_prompts` also re-embeds a row whose stored `embedding_model` is not the configured one (the switch from the stand-in to
// the real provider): comparing vectors from two models is EC-23's silent wrong cosine, so a stale vector is replaced, not kept.
//
// One fixed statement set per table. The table name is never interpolated from the payload: the payload's `table` only SELECTS
// which of these constants runs.
interface TableSql {
  /** Rows still needing a vector. $1 ids, $2 model. */
  readonly pending: string;
  /** L7: copy a stored vector for unchanged content. $1 ids, $2 model. Absent where the unique key already forbids a duplicate. */
  readonly reuse: string | undefined;
  /** Write vectors. $1 ids, $2 vector texts, $3 model. */
  readonly write: string;
}

const TABLE_SQL: Readonly<Record<EmbedTable, TableSql>> = {
  tracked_prompts: {
    pending: `SELECT id, text, NULL::text AS hash, false AS is_draft
                FROM tracked_prompts
               WHERE deleted_at IS NULL AND workspace_id = app.current_workspace() AND id = ANY($1::uuid[]) AND $2::text IS NOT NULL
                 AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2)
               ORDER BY id`,
    reuse: undefined,
    write: `UPDATE tracked_prompts t
               SET embedding = v.vec::halfvec(1536), embedding_model = $3
              FROM unnest($1::uuid[], $2::text[]) AS v(id, vec)
             WHERE t.id = v.id AND t.deleted_at IS NULL AND t.workspace_id = app.current_workspace()
               AND (t.embedding IS NULL OR t.embedding_model IS DISTINCT FROM $3)
            RETURNING t.id`,
  },
  content_chunks: {
    // A row whose key (workspace, hash, model, is_draft) is already held by an embedded sibling is a duplicate: ux_content_chunks
    // would refuse it the model, and the sibling's vector is the answer. It is not sent.
    pending: `SELECT c.id, c.text, encode(c.content_hash, 'hex') AS hash, c.is_draft
                FROM content_chunks c
               WHERE c.embedding IS NULL AND c.id = ANY($1::uuid[]) AND c.workspace_id = app.current_workspace()
                 AND NOT EXISTS (SELECT 1 FROM content_chunks o
                                  WHERE o.workspace_id = c.workspace_id AND o.content_hash = c.content_hash
                                    AND o.embedding_model = $2 AND o.is_draft = c.is_draft AND o.id <> c.id)
               ORDER BY c.id`,
    reuse: `UPDATE content_chunks t
               SET embedding = s.embedding, embedding_model = $2
              FROM content_chunks s
             WHERE t.id = ANY($1::uuid[]) AND t.embedding IS NULL AND t.workspace_id = app.current_workspace()
               AND s.workspace_id = t.workspace_id AND s.content_hash = t.content_hash AND s.id <> t.id
               AND s.embedding IS NOT NULL AND s.embedding_model = $2
               AND NOT EXISTS (SELECT 1 FROM content_chunks o
                                WHERE o.workspace_id = t.workspace_id AND o.content_hash = t.content_hash
                                  AND o.embedding_model = $2 AND o.is_draft = t.is_draft AND o.id <> t.id)
            RETURNING t.id`,
    write: `UPDATE content_chunks t
               SET embedding = v.vec::halfvec(1536), embedding_model = $3
              FROM unnest($1::uuid[], $2::text[]) AS v(id, vec)
             WHERE t.id = v.id AND t.embedding IS NULL AND t.workspace_id = app.current_workspace()
               AND NOT EXISTS (SELECT 1 FROM content_chunks o
                                WHERE o.workspace_id = t.workspace_id AND o.content_hash = t.content_hash
                                  AND o.embedding_model = $3 AND o.is_draft = t.is_draft AND o.id <> t.id)
            RETURNING t.id`,
  },
  corpus_passages: {
    // The row carries its model from insert (NOT NULL) and ux_corpus_passages_cluster (workspace, project, cluster, hash, model)
    // allows ONE row per (cluster, content), so each cluster's copy of a shared text is embedded once for that cluster (owner
    // decision 11); a passage stored under another model is not this job's to embed.
    pending: `SELECT id, text, encode(content_hash, 'hex') AS hash, false AS is_draft
                FROM corpus_passages
               WHERE embedding IS NULL AND embedding_model = $2 AND id = ANY($1::uuid[]) AND workspace_id = app.current_workspace()
               ORDER BY id`,
    reuse: undefined,
    write: `UPDATE corpus_passages t
               SET embedding = v.vec::halfvec(1536)
              FROM unnest($1::uuid[], $2::text[]) AS v(id, vec)
             WHERE t.id = v.id AND t.embedding IS NULL AND t.embedding_model = $3 AND t.workspace_id = app.current_workspace()
            RETURNING t.id`,
  },
  semantic_nodes: {
    // STORY-059 (owner decision 2026-10-28 #4): a node's phrase is embedded here, and the model is written WITH the vector, so a
    // node is never half-stamped. A node with a vector under another model is re-embedded (EC-23: one model per comparison), and
    // the table has no content hash, so there is no L7 copy: a phrase is a handful of tokens.
    pending: `SELECT id, phrase AS text, NULL::text AS hash, false AS is_draft
                FROM semantic_nodes
               WHERE workspace_id = app.current_workspace() AND id = ANY($1::uuid[]) AND $2::text IS NOT NULL
                 AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2)
               ORDER BY id`,
    reuse: undefined,
    write: `UPDATE semantic_nodes t
               SET embedding = v.vec::halfvec(1536), embedding_model = $3
              FROM unnest($1::uuid[], $2::text[]) AS v(id, vec)
             WHERE t.id = v.id AND t.workspace_id = app.current_workspace()
               AND (t.embedding IS NULL OR t.embedding_model IS DISTINCT FROM $3)
            RETURNING t.id`,
  },
};

export function createEmbedBatchHandler(context: QueueHandlerContext, deps: EmbedBatchDeps = {}): JobProcessor {
  const logger = new Logger("embed.batch");

  let provider: EmbeddingProvider | undefined = deps.provider;
  const providerFor = (): EmbeddingProvider => (provider ??= selectEmbeddingProvider(context.env));
  const breaker = deps.breaker ?? new CircuitBreaker({ name: "embedding-provider" });

  const payloadOf = (job: Job): EmbedBatchPayload => embedBatchPayloadSchema.parse((job.data as { payload: unknown }).payload);

  const prepare = async (tx: ClientBase, job: Job): Promise<EmbedPrepared | typeof PHASES_DONE> => {
    const payload = payloadOf(job);
    const { model, dimensions } = providerFor();
    const sql = TABLE_SQL[payload.table];
    const ids = [...new Set(payload.ids.map((id) => id.toLowerCase()))].sort();

    // L7 FIRST: reuse a stored vector for unchanged content, so the provider never sees it.
    let reused = 0;
    if (sql.reuse !== undefined) {
      reused = (await tx.query(sql.reuse, [ids, model])).rowCount ?? 0;
    }

    const found = await tx.query<{ id: string; text: string; hash: string | null; is_draft: boolean }>(sql.pending, [ids, model]);
    const rows: PendingRow[] = found.rows.map((row) => ({ id: row.id, text: row.text, hash: row.hash, isDraft: row.is_draft }));

    // Two rows of one batch that share a unique key (chunks: hash + is_draft) can carry the model once: the first is embedded,
    // the other is left for the next pass (it will find the first and be a duplicate).
    const seenKeys = new Set<string>();
    const textIndexOf = new Map<string, number>();
    const texts: string[] = [];
    const writes: { id: string; textIndex: number }[] = [];
    for (const row of rows) {
      if (row.text.trim().length === 0) continue;
      if (payload.table === "content_chunks" && row.hash !== null) {
        const key = `${row.hash}:${String(row.isDraft)}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
      }
      let index = textIndexOf.get(row.text);
      if (index === undefined) {
        index = texts.length;
        textIndexOf.set(row.text, index);
        texts.push(row.text);
      }
      writes.push({ id: row.id, textIndex: index });
    }

    if (reused > 0) incrementCounter("nominara_embed_l7_reused_total", { table: payload.table });
    if (writes.length === 0) {
      // Everything was already embedded (a redelivery) or reused: no provider call, no tokens.
      incrementCounter("nominara_embed_batches_total", { outcome: reused > 0 ? "reused" : "noop" });
      logger.log({ event: "embed.batch.noop", workspace_id: payload.workspaceId, table: payload.table, requested: ids.length, reused });
      return PHASES_DONE;
    }
    return { payload, model, dimensions, texts, writes, reused };
  };

  const run = async (prepared: EmbedPrepared): Promise<EmbedFetched> => {
    const provide = providerFor();
    return tracer.startActiveSpan("embed.batch.provider", async (span) => {
      const vectors: string[] = [];
      let totalTokens = 0;
      let calls = 0;
      try {
        for (const batch of splitIntoProviderBatches(prepared.texts)) {
          let result;
          try {
            result = await breaker.execute(() => provide.embed(batch));
          } catch (error) {
            if (error instanceof CircuitOpenError) incrementCounter("nominara_embed_circuit_open_total");
            incrementCounter("nominara_embed_provider_calls_total", { outcome: error instanceof CircuitOpenError ? "circuit_open" : "error" });
            throw error;
          }
          calls += 1;
          incrementCounter("nominara_embed_provider_calls_total", { outcome: "ok" });
          // Counted BEFORE the shape check: a response we then refuse (wrong model, wrong count) was still charged by the provider,
          // and `recover` meters `spentTokens`.
          totalTokens += result.totalTokens;
          if (result.vectors.length !== batch.length || result.model !== prepared.model || result.vectors.some((vector) => vector.length !== prepared.dimensions)) {
            throw new EmbeddingProviderError("provider returned a result that does not match the request", { retryable: false });
          }
          // A vector leaves here as a pgvector text literal and is never inspected again.
          for (const vector of result.vectors) vectors.push(JSON.stringify(vector));
        }
        span.setAttributes({ "nominara.embed.calls": calls, "nominara.embed.texts": prepared.texts.length, "nominara.embed.tokens": totalTokens });
        return { vectors, totalTokens, calls };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw isRetryable(error) ? new EmbedBatchFailedError(error, totalTokens) : new EmbedBatchPermanentError(error, totalTokens);
      } finally {
        span.end();
      }
    });
  };

  const commit = async (tx: ClientBase, prepared: EmbedPrepared, fetched: EmbedFetched): Promise<void> => {
    const { payload } = prepared;
    const writeIds = prepared.writes.map((write) => write.id);
    // STORY-059: `analyseNodes` bulk-UPDATEs a scope's semantic_nodes while holding that scope's advisory lock. This UPDATE touches rows
    // of the same scope, so without the lock the two take row locks in different orders and can deadlock. Take it first, scope by scope in
    // a fixed order (the lock key's own hash, the order the locks are taken in), so two jobs spanning several scopes cannot lock against each other either.
    if (payload.table === "semantic_nodes") {
      const scopes = await tx.query<{ project_id: string; prompt_cluster_id: string | null }>(
        `SELECT project_id, prompt_cluster_id FROM (
           SELECT DISTINCT project_id, prompt_cluster_id FROM semantic_nodes
            WHERE workspace_id = app.current_workspace() AND id = ANY($1::uuid[])
         ) s
          ORDER BY hashtextextended(project_id::text || ':' || COALESCE(prompt_cluster_id::text, ''), 0), project_id, prompt_cluster_id NULLS LAST`,
        [writeIds],
      );
      for (const scope of scopes.rows) await lockNodeScope(tx, scope.project_id, scope.prompt_cluster_id);
    }
    const written = await tx.query(TABLE_SQL[payload.table].write, [
      writeIds,
      prepared.writes.map((write) => fetched.vectors[write.textIndex]!),
      prepared.model,
    ]);
    const count = written.rowCount ?? 0;
    await meterTokens(tx, payload.workspaceId, fetched.totalTokens);
    incrementCounter("nominara_embed_batches_total", { outcome: "embedded" });
    observeValue("nominara_embed_vectors_written", count, { table: payload.table });
    observeValue("nominara_embed_tokens_spent", fetched.totalTokens, { table: payload.table });
    logger.log({
      event: "embed.batch.committed",
      workspace_id: payload.workspaceId,
      table: payload.table,
      model: prepared.model,
      requested: payload.ids.length,
      embedded: count,
      reused: prepared.reused,
      provider_calls: fetched.calls,
      tokens: fetched.totalTokens,
    });
  };

  /**
   * AC7 - provider-reported tokens through the internal-cost path. NEVER gating: no ceiling is read, and a failure here is
   * contained in a savepoint so the vectors (already paid for) still commit.
   */
  async function meterTokens(tx: ClientBase, workspaceId: string, tokens: number): Promise<void> {
    if (!Number.isInteger(tokens) || tokens <= 0) return;
    await tx.query("SAVEPOINT embed_meter");
    try {
      const period = await resolveBillingPeriod(tx, workspaceId);
      await meterInternalUsage(tx, workspaceId, "embed_tokens", period.start, tokens);
      await tx.query(
        `INSERT INTO usage_ledger (workspace_id, metric, quantity, source, reference_type)
         VALUES ($1, 'embed_tokens', $2, 'system', 'embed.batch')`,
        [workspaceId, tokens],
      );
      await tx.query("RELEASE SAVEPOINT embed_meter");
      incrementCounter("nominara_embed_tokens_metered_total");
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT embed_meter");
      incrementCounter("nominara_embed_metering_failed_total");
      logger.warn({ event: "embed.batch.metering_failed", workspace_id: workspaceId, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  return phasedProcessor<EmbedPrepared, EmbedFetched>({
    prepare,
    run,
    commit,
    // A failed attempt discards its vectors but the provider already charged for the calls that succeeded. Meter that spend (the
    // retry will spend again, and that is truthful), then leave the original error to the queue's retry ladder: always false.
    async recover(tx, job, failure) {
      const failed = failure.error instanceof EmbedBatchFailedError || failure.error instanceof EmbedBatchPermanentError ? failure.error : undefined;
      const spent = failure.fetched !== undefined ? failure.fetched.totalTokens : (failed?.spentTokens ?? 0);
      const workspaceId = (job.data as { payload?: { workspaceId?: string } }).payload?.workspaceId;
      if (spent > 0 && workspaceId !== undefined) await meterTokens(tx, workspaceId, spent);
      const circuitOpen = failed?.cause instanceof CircuitOpenError;
      incrementCounter("nominara_embed_batches_total", { outcome: circuitOpen ? "circuit_open" : "failed" });
      logger.warn({ event: "embed.batch.failed", workspace_id: workspaceId ?? null, phase: failure.phase, permanent: failed?.retryable === false, error: failure.error instanceof Error ? failure.error.name : "unknown" });
      return false;
    },
  });
}

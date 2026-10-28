import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { embedBatchKey, splitIdsIntoJobs } from "../../embedding/embed-batch.js";
import type { EnqueueEmbedBatch } from "../../embedding/prompt-embedding-request.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { selectCandidates, type Candidate } from "./candidates.js";
import { chunkDocument, type TokenCounter } from "./chunker.js";
import { queryTermsOf, selectTopChunks } from "./lexical.js";
import type { PageFetcher } from "./page-fetcher.js";
import { extractReadable } from "./readable.js";
import { passageFromTextFragment } from "./text-fragment.js";
import { centroidWeight, expiresAtFrom } from "./weights.js";

// STORY-058 - build the corpus of passages engines actually cited, for ONE prompt cluster of ONE project (steps 1-7 of the
// retrieval-centroid construction; the centroid itself is centroid.ts).
//
// THREE PHASES, because nothing holds a transaction across network I/O (ADR-0003, NFR-ARCH-04):
//   1. read   (one short tenant transaction)  candidates, the cluster's prompt terms, which URLs already have live passages.
//   2. fetch  (NO transaction, NO pooled connection)  a directive citation is read directly; every other URL goes through the
//             guarded page fetcher; readable extraction, chunking and the lexical filter happen here, in memory.
//   3. write  (one short tenant transaction)  every passage of the build is upserted, weights of cached URLs refreshed, superseded
//             stale rows removed. The embed jobs are enqueued AFTER that commit.
//
// DEDUPE (AC13). content_hash = sha256 of the whitespace-normalised text, and ux_corpus_passages is (workspace, content_hash, model),
// so identical text is one row however many URLs carry it, and a rebuild of unchanged content only moves its expiry. Embedding is
// requested only for rows still at `embedding IS NULL`, so an unchanged passage is never re-embedded.
//
// CACHE AND EXPIRY (AC4/AC12). A URL with an unexpired passage under the pinned model is NOT fetched again (the 30-day cache is the
// table itself); an expired one is re-fetched and, once its fresh passages are written, its superseded expired rows are deleted.
//
// A URL that cannot be sourced (refused by the guard, failed, nothing relevant) is counted and the build carries on; any such URL
// makes the build `partial`, never a silent `complete`.
//
// The EMBEDDING MODEL is a parameter: this file never imports a provider (the embed.batch handler is the only caller of that port).
// The tokenizer is a parameter too - production binds the embedding model's own tokenizer (STORY-050's cl100k).

const tracer = trace.getTracer("nominara.geo-corpus");
const logger = new Logger("geo.corpus");

export interface CorpusBuildDeps {
  readonly workspaceId: string;
  /** Runs `fn` in one tenant-context transaction (BEGIN ... COMMIT). Called twice per build, never around the fetches. */
  readonly runInTx: <T>(fn: (tx: ClientBase) => Promise<T>) => Promise<T>;
  readonly fetchPage: PageFetcher;
  readonly tokenizer: TokenCounter;
  /** The pinned model the passages are stored under. */
  readonly embeddingModel: string;
  /** Absent = the process has no queue producer: rows are written and wait at `embedding IS NULL`. */
  readonly enqueueEmbed?: EnqueueEmbedBatch;
  readonly now?: () => Date;
}

export interface CorpusBuildResult {
  readonly status: "complete" | "partial";
  readonly candidates: number;
  /** Already had live passages: not fetched, weights refreshed. */
  readonly cached: number;
  /** Sourced directly from a text directive: no fetch. */
  readonly fromFragment: number;
  readonly fetched: number;
  /** The guard refused the URL (an internal address, a bad redirect...). */
  readonly refused: number;
  readonly failed: number;
  /** Fetched fine but no chunk shared a term with the cluster's prompts. */
  readonly empty: number;
  /**
   * The URL's passages are live under ANOTHER cluster or project of this workspace. ux_corpus_passages has neither in its key, so this
   * corpus cannot hold them (a schema decision is open - see the story report): the URL is not fetched again, and the build is partial.
   */
  readonly heldElsewhere: number;
  /** Passages fetched fine but not stored: identical text is already held by another cluster or project. Never silent: build is partial. */
  readonly passagesConflictSkipped: number;
  readonly passagesWritten: number;
  readonly passagesRefreshed: number;
  readonly embedJobs: number;
  readonly embedEnqueueFailures: number;
}

interface PassageDraft {
  readonly candidate: Candidate;
  readonly index: number;
  readonly text: string;
  readonly fromTextFragment: boolean;
  readonly tokenCount: number;
  readonly contentHashHex: string;
}

const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();
const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export async function buildCorpus(deps: CorpusBuildDeps, input: { readonly projectId: string; readonly clusterId: string }): Promise<CorpusBuildResult> {
  return tracer.startActiveSpan("geo.corpus.build", async (span) => {
    try {
      const result = await run(deps, input);
      span.setAttributes({
        "nominara.corpus.candidates": result.candidates,
        "nominara.corpus.passages_written": result.passagesWritten,
        "nominara.corpus.partial": result.status === "partial",
      });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function run(deps: CorpusBuildDeps, input: { readonly projectId: string; readonly clusterId: string }): Promise<CorpusBuildResult> {
  const { projectId, clusterId } = input;

  // ---- 1. read ---------------------------------------------------------------------------------------------------------
  const read = await deps.runInTx(async (tx) => {
    const candidates = await selectCandidates(tx, input);
    const prompts = await tx.query<{ text: string }>(
      `SELECT text FROM tracked_prompts WHERE workspace_id = app.current_workspace() AND project_id = $1 AND cluster_id = $2 AND deleted_at IS NULL`,
      [projectId, clusterId],
    );
    const live = await tx.query<{ h: string }>(
      `SELECT DISTINCT encode(citation_url_hash, 'hex') AS h
         FROM corpus_passages
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND embedding_model = $3 AND expires_at > now() AND encode(citation_url_hash, 'hex') = ANY($4::text[])`,
      [projectId, clusterId, deps.embeddingModel, candidates.map((candidate) => candidate.urlHashHex)],
    );
    // Live under some OTHER project/cluster of this workspace: this corpus can never store them (unique key), so do not fetch them.
    const elsewhere = await tx.query<{ h: string }>(
      `SELECT DISTINCT encode(citation_url_hash, 'hex') AS h
         FROM corpus_passages
        WHERE workspace_id = app.current_workspace() AND NOT (project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2)
          AND embedding_model = $3 AND expires_at > now() AND encode(citation_url_hash, 'hex') = ANY($4::text[])`,
      [projectId, clusterId, deps.embeddingModel, candidates.map((candidate) => candidate.urlHashHex)],
    );
    return {
      candidates,
      terms: queryTermsOf(prompts.rows.map((row) => row.text)),
      liveHashes: new Set(live.rows.map((row) => row.h)),
      elsewhereHashes: new Set(elsewhere.rows.map((row) => row.h)),
    };
  });

  // ---- 2. fetch and select (no transaction) ----------------------------------------------------------------------------
  const counts = { cached: 0, fromFragment: 0, fetched: 0, refused: 0, failed: 0, empty: 0, heldElsewhere: 0 };
  const drafts: PassageDraft[] = [];
  const processed: Candidate[] = [];
  const cachedCandidates: Candidate[] = [];

  for (const candidate of read.candidates) {
    if (read.liveHashes.has(candidate.urlHashHex)) {
      counts.cached += 1;
      cachedCandidates.push(candidate);
      continue;
    }
    if (read.elsewhereHashes.has(candidate.urlHashHex)) {
      counts.heldElsewhere += 1;
      continue;
    }
    const directive = candidate.textFragment === null ? null : passageFromTextFragment(candidate.textFragment);
    if (directive !== null) {
      counts.fromFragment += 1;
      processed.push(candidate);
      let index = 0;
      for (const chunk of chunkDocument(directive, deps.tokenizer)) {
        drafts.push(draftOf(candidate, index, chunk.text, chunk.tokenCount, true));
        index += 1;
      }
      continue;
    }
    const page = await deps.fetchPage(candidate.url);
    if (page.kind === "refused") {
      counts.refused += 1;
      continue;
    }
    if (page.kind === "failed") {
      counts.failed += 1;
      continue;
    }
    counts.fetched += 1;
    processed.push(candidate);
    const kept = selectTopChunks(chunkDocument(extractReadable(page.html), deps.tokenizer), read.terms);
    if (kept.length === 0) counts.empty += 1;
    for (const chunk of kept) drafts.push(draftOf(candidate, chunk.index, chunk.text, chunk.tokenCount, false));
  }

  // The same text under two URLs is ONE passage: the first (highest-scoring) URL keeps it.
  const seen = new Set<string>();
  const unique = drafts.filter((draft) => (seen.has(draft.contentHashHex) ? false : (seen.add(draft.contentHashHex), true)));

  // ---- 3. write (one transaction) --------------------------------------------------------------------------------------
  const fetchedAt = (deps.now ?? (() => new Date()))();
  const expiresAt = expiresAtFrom(fetchedAt);
  const written = await deps.runInTx(async (tx) => {
    let inserted = 0;
    let refreshed = 0;
    let conflictSkipped = 0;

    // The corpus is THIS build's selection (reference section 6: top K, owned excluded). A URL that fell out of the top set, or
    // became owned, must stop contributing now, not at its 30-day expiry. Done BEFORE the upsert so the text of a departed URL is
    // free for the URL that replaces it.
    await tx.query(
      `DELETE FROM corpus_passages
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND embedding_model = $3 AND NOT (encode(citation_url_hash, 'hex') = ANY($4::text[]))`,
      [projectId, clusterId, deps.embeddingModel, read.candidates.map((c) => c.urlHashHex)],
    );

    if (unique.length > 0) {
      const upsert = await tx.query<{ inserted: boolean }>(
        `INSERT INTO corpus_passages
           (workspace_id, project_id, citation_url_hash, url, domain, prompt_cluster_id, engine_keys, passage_index, text, from_text_fragment,
            token_count, content_hash, embedding_model, citation_frequency, avg_position_weight, centroid_weight, fetched_at, expires_at)
         SELECT app.current_workspace(), $1, decode(v.uh, 'hex'), v.url, v.domain, $2, string_to_array(v.ek, ','), v.idx, v.text, v.ff,
                v.tc, decode(v.ch, 'hex'), $3, v.freq, v.aw, v.cw, $4, $5
           FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::int[], $11::text[], $12::boolean[], $13::int[], $14::text[], $15::int[], $16::real[], $17::real[])
                AS v(uh, url, domain, ek, idx, text, ff, tc, ch, freq, aw, cw)
         ON CONFLICT (workspace_id, content_hash, embedding_model) DO UPDATE
            SET fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at, engine_keys = EXCLUDED.engine_keys,
                citation_frequency = EXCLUDED.citation_frequency, avg_position_weight = EXCLUDED.avg_position_weight,
                centroid_weight = EXCLUDED.centroid_weight
          -- Only this project's own row for this URL and cluster. The unique key has no project in it, so a hash held by another
          -- project or cluster is theirs: it is left alone, and the draft is COUNTED as conflict-skipped (never silent; the build is
          -- partial). The schema decision that would let both corpora hold it is open - see the story report.
          WHERE corpus_passages.project_id = EXCLUDED.project_id
            AND corpus_passages.prompt_cluster_id IS NOT DISTINCT FROM EXCLUDED.prompt_cluster_id
            AND corpus_passages.citation_url_hash = EXCLUDED.citation_url_hash
         RETURNING (xmax = 0) AS inserted`,
        [
          projectId, clusterId, deps.embeddingModel, fetchedAt.toISOString(), expiresAt.toISOString(),
          unique.map((d) => d.candidate.urlHashHex), unique.map((d) => d.candidate.url), unique.map((d) => d.candidate.domain),
          unique.map((d) => d.candidate.engineKeys.join(",")), unique.map((d) => d.index), unique.map((d) => d.text),
          unique.map((d) => d.fromTextFragment), unique.map((d) => d.tokenCount), unique.map((d) => d.contentHashHex),
          unique.map((d) => d.candidate.citationFrequency), unique.map((d) => d.candidate.avgPositionWeight),
          unique.map((d) => centroidWeight(d.candidate.citationFrequency, d.candidate.avgPositionWeight)),
        ],
      );
      for (const row of upsert.rows) {
        if (row.inserted) inserted += 1;
        else refreshed += 1;
      }
      conflictSkipped = unique.length - upsert.rows.length;
    }

    // A cached URL keeps its text but its citations moved on: refresh the weights the centroid reads.
    if (cachedCandidates.length > 0) {
      await tx.query(
        `UPDATE corpus_passages cp
            SET engine_keys = string_to_array(v.ek, ','), citation_frequency = v.freq, avg_position_weight = v.aw, centroid_weight = v.cw
           FROM unnest($4::text[], $5::text[], $6::int[], $7::real[], $8::real[]) AS v(uh, ek, freq, aw, cw)
          WHERE cp.workspace_id = app.current_workspace() AND cp.project_id = $1 AND cp.prompt_cluster_id IS NOT DISTINCT FROM $2
            AND cp.embedding_model = $3 AND cp.expires_at > now() AND cp.citation_url_hash = decode(v.uh, 'hex')`,
        [
          projectId, clusterId, deps.embeddingModel,
          cachedCandidates.map((c) => c.urlHashHex), cachedCandidates.map((c) => c.engineKeys.join(",")),
          cachedCandidates.map((c) => c.citationFrequency), cachedCandidates.map((c) => c.avgPositionWeight),
          cachedCandidates.map((c) => centroidWeight(c.citationFrequency, c.avgPositionWeight)),
        ],
      );
    }

    // Stale rows of the URLs just re-sourced: whatever was NOT refreshed above is superseded content (NFR-OPT-04).
    if (processed.length > 0) {
      await tx.query(
        `DELETE FROM corpus_passages
          WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
            AND embedding_model = $3 AND expires_at <= now() AND encode(citation_url_hash, 'hex') = ANY($4::text[])`,
        [projectId, clusterId, deps.embeddingModel, processed.map((c) => c.urlHashHex)],
      );
    }

    // Rows still waiting for a vector, under the pinned model (this build's new rows, and any left by an earlier failed enqueue).
    const pending = await tx.query<{ id: string }>(
      `SELECT id FROM corpus_passages
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND embedding_model = $3 AND embedding IS NULL AND expires_at > now()
        ORDER BY id`,
      [projectId, clusterId, deps.embeddingModel],
    );
    return { inserted, refreshed, conflictSkipped, pendingIds: pending.rows.map((row) => row.id) };
  });

  // ---- after commit: ask for the vectors -------------------------------------------------------------------------------
  let embedJobs = 0;
  let embedEnqueueFailures = 0;
  if (deps.enqueueEmbed !== undefined) {
    for (const ids of splitIdsIntoJobs(written.pendingIds)) {
      try {
        await deps.enqueueEmbed("embed.batch", deps.workspaceId, { table: "corpus_passages", ids }, embedBatchKey("corpus_passages", ids));
        embedJobs += 1;
        incrementCounter("nominara_embed_enqueued_total", { producer: "geo_corpus" });
      } catch {
        // FAIL OPEN (owner decision 7): the rows are committed and wait at `embedding IS NULL`; the next build re-requests them.
        embedEnqueueFailures += 1;
        incrementCounter("nominara_embed_enqueue_failed_total", { producer: "geo_corpus" });
      }
    }
  }

  const status = counts.refused + counts.failed + counts.heldElsewhere + written.conflictSkipped > 0 ? "partial" : "complete";
  const result: CorpusBuildResult = {
    status,
    candidates: read.candidates.length,
    ...counts,
    passagesWritten: written.inserted,
    passagesConflictSkipped: written.conflictSkipped,
    passagesRefreshed: written.refreshed,
    embedJobs,
    embedEnqueueFailures,
  };

  for (const [outcome, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) incrementCounter("nominara_geo_corpus_urls_total", { outcome });
  }
  for (let i = 0; i < written.conflictSkipped; i += 1) incrementCounter("nominara_geo_corpus_urls_total", { outcome: "passage_conflict_skipped" });
  observeValue("nominara_geo_corpus_passages_written", written.inserted, { status });
  // Workspace ID only; no URL, no passage text, no domain (competitor content is not ours to log).
  logger.log({
    event: "geo.corpus.built",
    workspace_id: deps.workspaceId,
    status,
    model: deps.embeddingModel,
    candidates: result.candidates,
    cached: counts.cached,
    from_fragment: counts.fromFragment,
    fetched: counts.fetched,
    refused: counts.refused,
    failed: counts.failed,
    empty: counts.empty,
    held_elsewhere: counts.heldElsewhere,
    passages_conflict_skipped: written.conflictSkipped,
    passages_written: written.inserted,
    embed_jobs: embedJobs,
  });
  return result;
}

function draftOf(candidate: Candidate, index: number, text: string, tokenCount: number, fromTextFragment: boolean): PassageDraft {
  return { candidate, index, text, tokenCount, fromTextFragment, contentHashHex: sha256Hex(normalise(text)) };
}

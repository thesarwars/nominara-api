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
// DEDUPE (AC13). content_hash = sha256 of the whitespace-normalised text, and the key (migration 0151, owner decision 11) is
// (workspace, project, cluster, content_hash, model), so identical text is one row PER CLUSTER however many URLs carry it, and a
// rebuild of unchanged content only moves its expiry. Two clusters or projects citing the same text each hold their own copy, at
// one embedding per (cluster, text): nothing a sibling holds can block or be adopted by this build. Embedding is requested only for
// rows still at `embedding IS NULL`, so an unchanged passage is never re-embedded.
//
// CACHE AND EXPIRY (AC4/AC12). A URL with an unexpired passage under the pinned model is NOT fetched again (the 30-day cache is the
// table itself); an expired one is re-fetched and, once its fresh passages are written, its superseded expired rows are deleted.
// A URL that was fetched and yielded no row of its own (every passage a copy of another URL's, or none relevant) is remembered in
// corpus_url_checks (migration 0214, STORY-058 AC4) for the same 30 days and not fetched again; a refused or failed URL is not remembered.
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
  /** Passages whose text this corpus already holds under another of its own URLs (syndicated copies). Dedupe working; NOT partial. */
  readonly passagesDeduplicated: number;
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
    // STORY-058 AC4 - URLs fetched earlier that produced no passage of their own (every passage a copy, or none relevant): the same
    // 30-day cache, remembered in corpus_url_checks because corpus_passages has no row to say so.
    const checked = await tx.query<{ h: string; outcome: string }>(
      `SELECT encode(citation_url_hash, 'hex') AS h, outcome
         FROM corpus_url_checks
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND embedding_model = $3 AND expires_at > now() AND encode(citation_url_hash, 'hex') = ANY($4::text[])`,
      [projectId, clusterId, deps.embeddingModel, candidates.map((candidate) => candidate.urlHashHex)],
    );
    // Whether any passage of this corpus belongs to a URL that is NOT a candidate of this build: the write phase deletes those rows, which
    // is exactly when a remembered `duplicate_only` stops being true (its twin's text is about to be freed). Decided HERE, before the
    // cache decision below, so such a URL is fetched in this build rather than skipped until the next.
    const departing = await tx.query(
      `SELECT 1 FROM corpus_passages
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND embedding_model = $3 AND NOT (encode(citation_url_hash, 'hex') = ANY($4::text[]))
        LIMIT 1`,
      [projectId, clusterId, deps.embeddingModel, candidates.map((candidate) => candidate.urlHashHex)],
    );
    return {
      candidates,
      someUrlDeparts: (departing.rowCount ?? 0) > 0,
      terms: queryTermsOf(prompts.rows.map((row) => row.text)),
      liveHashes: new Set(live.rows.map((row) => row.h)),
      checkedHashes: new Set(checked.rows.map((row) => row.h)),
      duplicateOnlyHashes: new Set(checked.rows.filter((row) => row.outcome === "duplicate_only").map((row) => row.h)),
    };
  });

  // ---- 2. fetch and select (no transaction) ----------------------------------------------------------------------------
  const counts = { cached: 0, fromFragment: 0, fetched: 0, refused: 0, failed: 0, empty: 0 };
  const drafts: PassageDraft[] = [];
  const cachedCandidates: Candidate[] = [];
  // STORY-058 AC4 - fetched URLs, split by whether they had anything to keep. Whether a URL WITH passages ends up owning a row is only
  // known after the write below (a text another URL of this corpus holds is dropped), so that half is decided there.
  const noRelevantChunk: Candidate[] = [];
  const fetchedWithPassages: Candidate[] = [];

  for (const candidate of read.candidates) {
    if (read.liveHashes.has(candidate.urlHashHex)) {
      counts.cached += 1;
      cachedCandidates.push(candidate);
      continue;
    }
    // A duplicate_only check whose twin departs this build is not trusted: the twin's text is freed in the write below, so the URL is
    // fetched now (falls through) and keeps the text in the corpus within this build.
    const duplicateOfDeparting = read.someUrlDeparts && read.duplicateOnlyHashes.has(candidate.urlHashHex);
    if (read.checkedHashes.has(candidate.urlHashHex) && !duplicateOfDeparting) {
      // Fetched within the cache period and found to add nothing of its own: counted as cached, not fetched again.
      counts.cached += 1;
      continue;
    }
    const directive = candidate.textFragment === null ? null : passageFromTextFragment(candidate.textFragment);
    if (directive !== null) {
      counts.fromFragment += 1;
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
    const kept = selectTopChunks(chunkDocument(extractReadable(page.html), deps.tokenizer), read.terms);
    if (kept.length === 0) {
      counts.empty += 1;
      noRelevantChunk.push(candidate);
    } else {
      fetchedWithPassages.push(candidate);
    }
    for (const chunk of kept) drafts.push(draftOf(candidate, chunk.index, chunk.text, chunk.tokenCount, false));
  }

  // The same text under two URLs is ONE passage: the first (highest-scoring) URL keeps it.
  const seen = new Set<string>();
  // Written in content-hash order: two concurrent builds of sibling clusters that share several texts then take the unique-index
  // entries in the same order and cannot deadlock on each other.
  const unique = drafts
    .filter((draft) => (seen.has(draft.contentHashHex) ? false : (seen.add(draft.contentHashHex), true)))
    .sort((a, b) => (a.contentHashHex < b.contentHashHex ? -1 : a.contentHashHex > b.contentHashHex ? 1 : 0));

  // ---- 3. write (one transaction) --------------------------------------------------------------------------------------
  const fetchedAt = (deps.now ?? (() => new Date()))();
  const expiresAt = expiresAtFrom(fetchedAt);
  const written = await deps.runInTx(async (tx) => {
    let inserted = 0;
    let refreshed = 0;
    let deduplicated = 0;

    // The corpus is THIS build's selection (reference section 6: top K, owned excluded). A URL that fell out of the top set, or
    // became owned, must stop contributing now, not at its 30-day expiry. Done BEFORE the upsert so the text of a departed URL is
    // free for the URL that replaces it.
    const departed = await tx.query(
      `DELETE FROM corpus_passages
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
          AND embedding_model = $3 AND NOT (encode(citation_url_hash, 'hex') = ANY($4::text[]))`,
      [projectId, clusterId, deps.embeddingModel, read.candidates.map((c) => c.urlHashHex)],
    );

    // STORY-058 AC4 - the remembered checks follow the corpus. An expired one, one for a URL no longer a candidate, and (when a URL left and
    // took its passages with it) every `duplicate_only` one go: that URL may have been the twin whose text made the others duplicates, so they
    // are judged afresh by the next build. A `no_relevant_chunk` check does not depend on any other URL and stays.
    await tx.query(
      `DELETE FROM corpus_url_checks
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2 AND embedding_model = $3
          AND (expires_at <= now() OR NOT (encode(citation_url_hash, 'hex') = ANY($4::text[])) OR ($5::boolean AND outcome = 'duplicate_only'))`,
      [projectId, clusterId, deps.embeddingModel, read.candidates.map((c) => c.urlHashHex), (departed.rowCount ?? 0) > 0],
    );

    if (unique.length > 0) {
      const upsert = await tx.query<{ inserted: boolean; ch: string }>(
        `INSERT INTO corpus_passages
           (workspace_id, project_id, citation_url_hash, url, domain, prompt_cluster_id, engine_keys, passage_index, text, from_text_fragment,
            token_count, content_hash, embedding_model, citation_frequency, avg_position_weight, centroid_weight, fetched_at, expires_at)
         SELECT app.current_workspace(), $1, decode(v.uh, 'hex'), v.url, v.domain, $2, string_to_array(v.ek, ','), v.idx, v.text, v.ff,
                v.tc, decode(v.ch, 'hex'), $3, v.freq, v.aw, v.cw, $4, $5
           FROM unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::int[], $11::text[], $12::boolean[], $13::int[], $14::text[], $15::int[], $16::real[], $17::real[])
                AS v(uh, url, domain, ek, idx, text, ff, tc, ch, freq, aw, cw)
         ON CONFLICT (workspace_id, project_id, prompt_cluster_id, content_hash, embedding_model) DO UPDATE
            SET citation_url_hash = EXCLUDED.citation_url_hash, url = EXCLUDED.url, domain = EXCLUDED.domain,
                passage_index = EXCLUDED.passage_index, from_text_fragment = EXCLUDED.from_text_fragment, token_count = EXCLUDED.token_count,
                fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at, engine_keys = EXCLUDED.engine_keys,
                citation_frequency = EXCLUDED.citation_frequency, avg_position_weight = EXCLUDED.avg_position_weight,
                centroid_weight = EXCLUDED.centroid_weight
          -- The key is this corpus's own (project, cluster), so the only row that can conflict is this corpus's. An EXPIRED row is
          -- refreshed by the URL that now carries the text (it no longer contributes to the centroid). A LIVE row is refreshed only
          -- when it is this corpus's row for the same URL; a live row of another URL of THIS corpus is the same text under a second
          -- URL: left alone and counted as deduplicated below. A sibling cluster's or project's row is never a conflict at all.
          WHERE corpus_passages.expires_at <= now()
             OR corpus_passages.citation_url_hash = EXCLUDED.citation_url_hash
         RETURNING (xmax = 0) AS inserted, encode(corpus_passages.content_hash, 'hex') AS ch`,
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
      // A rejected draft is a copy of text this corpus already holds under another of its URLs: deduplicated, not an error.
      const stored = new Set(upsert.rows.map((row) => row.ch));
      deduplicated = unique.filter((draft) => !stored.has(draft.contentHashHex)).length;
    }

    // STORY-058 AC4 - remember the URLs that were fetched and produced no passage of their own, so the next build does not fetch them
    // again inside the cache period: a URL with nothing relevant, and a URL whose every passage is a copy of one another URL of this corpus
    // holds (it owns no live row after the upsert above). A refused or failed URL is never recorded here: it is tried again.
    const fetchedHashes = fetchedWithPassages.map((c) => c.urlHashHex);
    const owning = new Set<string>();
    if (fetchedHashes.length > 0) {
      const owners = await tx.query<{ h: string }>(
        `SELECT DISTINCT encode(citation_url_hash, 'hex') AS h
           FROM corpus_passages
          WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
            AND embedding_model = $3 AND expires_at > now() AND encode(citation_url_hash, 'hex') = ANY($4::text[])`,
        [projectId, clusterId, deps.embeddingModel, fetchedHashes],
      );
      for (const row of owners.rows) owning.add(row.h);
    }
    const checks = [
      ...noRelevantChunk.map((c) => ({ hash: c.urlHashHex, outcome: "no_relevant_chunk" })),
      ...fetchedWithPassages.filter((c) => !owning.has(c.urlHashHex)).map((c) => ({ hash: c.urlHashHex, outcome: "duplicate_only" })),
    ];
    if (checks.length > 0) {
      await tx.query(
        `INSERT INTO corpus_url_checks (workspace_id, project_id, prompt_cluster_id, citation_url_hash, embedding_model, outcome, checked_at, expires_at)
         SELECT app.current_workspace(), $1, $2, decode(v.uh, 'hex'), $3, v.outcome, $4, $5
           FROM unnest($6::text[], $7::text[]) AS v(uh, outcome)
         ON CONFLICT (workspace_id, project_id, prompt_cluster_id, citation_url_hash, embedding_model)
         DO UPDATE SET outcome = EXCLUDED.outcome, checked_at = EXCLUDED.checked_at, expires_at = EXCLUDED.expires_at`,
        [projectId, clusterId, deps.embeddingModel, fetchedAt.toISOString(), expiresAt.toISOString(), checks.map((c) => c.hash), checks.map((c) => c.outcome)],
      );
      for (const check of checks) incrementCounter("nominara_geo_corpus_urls_total", { outcome: check.outcome === "duplicate_only" ? "url_duplicate_only" : "url_no_relevant_chunk" });
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

    // Expired rows of every candidate that was NOT served from cache: re-sourced URLs (whatever was NOT refreshed above is superseded
    // content, NFR-OPT-04) AND URLs the guard refused or that failed - their expired text can no longer be used, so it is not kept.
    // A cached URL is left out: its rows may have crossed expiry during the fetch phase and got no weight refresh above, but they
    // are not superseded by anything - the next build re-sources the URL.
    const uncachedHashes = read.candidates.filter((c) => !read.liveHashes.has(c.urlHashHex)).map((c) => c.urlHashHex);
    if (uncachedHashes.length > 0) {
      await tx.query(
        `DELETE FROM corpus_passages
          WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2
            AND embedding_model = $3 AND expires_at <= now() AND encode(citation_url_hash, 'hex') = ANY($4::text[])`,
        [projectId, clusterId, deps.embeddingModel, uncachedHashes],
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
    return { inserted, refreshed, deduplicated, pendingIds: pending.rows.map((row) => row.id) };
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

  const status = counts.refused + counts.failed > 0 ? "partial" : "complete";
  const result: CorpusBuildResult = {
    status,
    candidates: read.candidates.length,
    ...counts,
    passagesWritten: written.inserted,
    passagesDeduplicated: written.deduplicated,
    passagesRefreshed: written.refreshed,
    embedJobs,
    embedEnqueueFailures,
  };

  for (let i = 0; i < written.deduplicated; i += 1) incrementCounter("nominara_geo_corpus_urls_total", { outcome: "passage_deduplicated" });
  for (const [outcome, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) incrementCounter("nominara_geo_corpus_urls_total", { outcome });
  }
  observeValue("nominara_geo_corpus_passages_written_total", written.inserted, { status });
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
    passages_deduplicated: written.deduplicated,
    passages_written: written.inserted,
    embed_jobs: embedJobs,
  });
  return result;
}

function draftOf(candidate: Candidate, index: number, text: string, tokenCount: number, fromTextFragment: boolean): PassageDraft {
  return { candidate, index, text, tokenCount, fromTextFragment, contentHashHex: sha256Hex(normalise(text)) };
}

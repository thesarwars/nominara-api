import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { incrementCounter } from "../../telemetry/metrics.js";
import { ALIGNMENT } from "./constants.js";

// STORY-059 AC3 / AC4 - alignment and the empirical target band, IN SQL (aux-and-geo-analysis.md section 7).
//
//   alignment(chunk)     = 1 - (chunk.embedding <=> centroid)
//   alignment(page)      = sum_i token_count_i * alignment(chunk_i) / sum_i token_count_i
//   percentile_vs_corpus = the rank of alignment(page) among the K cited documents' own alignment
//   target_band          = [p50, p85] of the cited documents' alignment
//
// No embedding is read into the application: the cosine is pgvector's `<=>`, the weighting is `sum()`, the band is
// `percentile_cont`. The application sees only the scalar answers.
//
// WHAT A "CITED DOCUMENT" IS. The corpus keeps up to three passages per URL (STORY-058), not whole pages, so a document's alignment
// is the token-weighted alignment of ITS PASSAGES to the centroid, under exactly the filter the centroid itself is built from
// (this session's project, cluster and model; embedded; unexpired; positive weight). The band is therefore measured on the same
// material as the target it describes.
//
// PERCENTILE. The share of cited documents whose alignment is at or below the page's, as a whole number 0-100 ("the rank of the page
// among the cited documents"): 100 means the page is at least as aligned as every cited document. Both sides are compared at `real`
// precision (the precision chunk alignment is stored at), so a page that IS a cited document ties with it instead of losing to
// float rounding.
//
// NULL IS NOT 0. No centroid: nothing is measured and nothing is written. No embedded chunk: the page has no alignment and no
// percentile, and the band (a fact about the corpus) still stands. No cited document: no band and no percentile.
//
// `draft` selects which chunks are measured: the live page (`is_draft = false`, which also sets the baseline - ONCE: a later live
// recompute moves `current_alignment` and leaves the baseline) or the customer's draft (`is_draft = true`, which moves only
// `current_alignment`). A draft with no embedded chunk has NO current alignment (NULL): the live figure is never carried over as if it
// described the draft.
//
// A CHUNK'S VECTOR IS READ BY ITS HASH. `ux_content_chunks` is (workspace_id, content_hash, embedding_model, is_draft) and has no
// session, so when a second session (the same URL again, another cluster, a shared boilerplate chunk, or a block repeated inside one
// page) holds a hash an embedded row already holds, embed.batch embeds ONE row and leaves the others at NULL (L7 reuse). The vector is
// therefore taken from the embedded row of the same workspace, hash, model and kind, by a lateral lookup on that index, so every
// chunk of the session is measured and counts toward the token weighting. A chunk whose hash has no embedded row is still pending
// and is neither averaged nor counted.

const tracer = trace.getTracer("nominara.geo-alignment");
const logger = new Logger("geo.alignment");

export interface AlignmentFigures {
  /** False when the session does not exist (or is not this workspace's) or has no centroid: nothing was written. */
  readonly measured: boolean;
  readonly baselineAlignment: number | null;
  readonly currentAlignment: number | null;
  readonly bandLow: number | null;
  readonly bandHigh: number | null;
  readonly percentile: number | null;
  readonly chunks: number;
}

const NOT_MEASURED: AlignmentFigures = { measured: false, baselineAlignment: null, currentAlignment: null, bandLow: null, bandHigh: null, percentile: null, chunks: 0 };

export async function computeAlignment(tx: ClientBase, sessionId: string, options: { readonly draft?: boolean } = {}): Promise<AlignmentFigures> {
  return tracer.startActiveSpan("geo.alignment.compute", async (span) => {
    try {
      const figures = await run(tx, sessionId, options.draft === true);
      span.setAttributes({ "nominara.alignment.measured": figures.measured, "nominara.alignment.chunks": figures.chunks });
      incrementCounter("nominara_geo_alignment_computed_total", { measured: String(figures.measured), source: options.draft === true ? "draft" : "live" });
      return figures;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function run(tx: ClientBase, sessionId: string, draft: boolean): Promise<AlignmentFigures> {
  // 1. per chunk. Only chunks that are embedded, of THIS session, of the measured kind.
  const chunked = await tx.query<{ n: number }>(
    `WITH g AS (
       SELECT id, centroid, embedding_model FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace() AND centroid IS NOT NULL
     ), src AS (
       SELECT c.id, v.embedding, g.centroid
         FROM g
         JOIN content_chunks c ON c.session_id = g.id AND c.workspace_id = app.current_workspace() AND c.is_draft = $2
        CROSS JOIN LATERAL (
          SELECT x.embedding FROM content_chunks x
           WHERE x.workspace_id = app.current_workspace() AND x.content_hash = c.content_hash AND x.is_draft = c.is_draft
             AND x.embedding_model = g.embedding_model AND x.embedding IS NOT NULL
           LIMIT 1
        ) v
     ), done AS (
       UPDATE content_chunks c
          SET alignment = (1 - (src.embedding <=> src.centroid))::real
         FROM src
        WHERE c.id = src.id AND c.workspace_id = app.current_workspace()
       RETURNING c.id
     ) SELECT count(*)::int AS n FROM done`,
    [sessionId, draft],
  );
  const chunks = chunked.rows[0]?.n ?? 0;

  // 2. per page, the band and the percentile, and the write onto the session: one statement, so the figures cannot disagree.
  const result = await tx.query<{
    baseline_alignment: number | null;
    current_alignment: number | null;
    target_band_low: number | null;
    target_band_high: number | null;
    percentile_vs_corpus: number | null;
  }>(
    `WITH s AS (
       SELECT id, project_id, prompt_cluster_id, embedding_model, centroid
         FROM geo_alignments
        WHERE id = $1 AND workspace_id = app.current_workspace() AND centroid IS NOT NULL
     ), page AS (
       SELECT sum(c.token_count::double precision * c.alignment) / NULLIF(sum(c.token_count), 0) AS a
         FROM s JOIN content_chunks c
           ON c.session_id = s.id AND c.workspace_id = app.current_workspace() AND c.is_draft = $2 AND c.alignment IS NOT NULL
     ), docs AS (
       SELECT sum(cp.token_count::double precision * (1 - (cp.embedding <=> s.centroid))) / NULLIF(sum(cp.token_count), 0) AS a
         FROM s JOIN corpus_passages cp
           ON cp.workspace_id = app.current_workspace() AND cp.project_id = s.project_id
          AND cp.prompt_cluster_id IS NOT DISTINCT FROM s.prompt_cluster_id AND cp.embedding_model = s.embedding_model
          AND cp.embedding IS NOT NULL AND cp.centroid_weight > 0 AND cp.expires_at > now()
        GROUP BY cp.citation_url_hash
     ), band AS (
       SELECT percentile_cont($3::double precision) WITHIN GROUP (ORDER BY a) AS lo,
              percentile_cont($4::double precision) WITHIN GROUP (ORDER BY a) AS hi
         FROM docs WHERE a IS NOT NULL
     ), pct AS (
       SELECT round(100.0 * count(*) FILTER (WHERE docs.a::real <= page.a::real) / NULLIF(count(*), 0))::smallint AS p
         FROM docs CROSS JOIN page WHERE docs.a IS NOT NULL AND page.a IS NOT NULL
     )
     UPDATE geo_alignments g
        SET baseline_alignment = CASE WHEN $2 THEN g.baseline_alignment ELSE COALESCE(g.baseline_alignment, page.a) END,
            current_alignment = page.a,
            target_band_low = band.lo, target_band_high = band.hi,
            percentile_vs_corpus = pct.p,
            updated_at = now()
       FROM s, page, band, pct
      WHERE g.id = s.id AND g.workspace_id = app.current_workspace()
     RETURNING g.baseline_alignment, g.current_alignment, g.target_band_low, g.target_band_high, g.percentile_vs_corpus`,
    [sessionId, draft, ALIGNMENT.bandLowPercentile, ALIGNMENT.bandHighPercentile],
  );
  const row = result.rows[0];
  if (row === undefined) return { ...NOT_MEASURED, chunks };
  logger.log({ event: "geo.alignment.computed", workspace_id: await workspaceOf(tx), chunks, measured_page: row.current_alignment !== null, band: row.target_band_low !== null });
  return {
    measured: true,
    baselineAlignment: row.baseline_alignment,
    currentAlignment: row.current_alignment,
    bandLow: row.target_band_low,
    bandHigh: row.target_band_high,
    percentile: row.percentile_vs_corpus,
    chunks,
  };
}

async function workspaceOf(tx: ClientBase): Promise<string> {
  const result = await tx.query<{ w: string }>("SELECT app.current_workspace()::text AS w");
  return result.rows[0]!.w;
}

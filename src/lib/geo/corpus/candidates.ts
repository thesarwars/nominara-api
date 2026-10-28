import type { ClientBase } from "pg";
import { CORPUS } from "./constants.js";

// STORY-058 AC1 / AC2 - steps 1 and 2 of the retrieval-centroid construction: the candidate URLs, ranked, owned ones excluded.
//
//   score(u) = sum over u's citations c of  position_weight(c) * engine_weight(c)        (engine weight = project_engines.weight, 1.0 if unset)
//
// A "URL" is the page, NOT the citation string: `normalized_url` carries the `#:~:text=` directive, so the same page cited with two
// different quotes (or none) would otherwise be several candidates and the directive-less citations would split the page's score.
// The directive is cut at '#', and the page's score, frequency and average position weight are summed over every way it was cited.
//
// OWNED URLS ARE EXCLUDED HERE, at selection (the story's key decision): by the parser's `is_owned` on ANY citation of the page, and
// again by the project's own registrable domain, so a page the parser has not (yet) flagged but which lives on the brand's domain
// can still never enter the corpus. Excluding after the fact would let an owned page spend one of the 25 slots.
//
// The window and the cap are the reference's (CORPUS.windowDays, CORPUS.topUrls). RLS bounds every table read to the workspace; the
// explicit `workspace_id = app.current_workspace()` is defence in depth for a connection that bypasses it.

export interface Candidate {
  readonly url: string;
  /** sha256 of `url` (the page, without any directive) - hex. */
  readonly urlHashHex: string;
  readonly domain: string;
  readonly score: number;
  readonly citationFrequency: number;
  readonly avgPositionWeight: number;
  readonly engineKeys: readonly string[];
  /** The most recent text directive any citation of the page carried, raw (the part after `#:~:text=`). */
  readonly textFragment: string | null;
}

export async function selectCandidates(tx: ClientBase, input: { readonly projectId: string; readonly clusterId: string }): Promise<Candidate[]> {
  const result = await tx.query<{
    url: string;
    url_hash: string;
    domain: string;
    score: number;
    citation_frequency: number;
    avg_position_weight: number;
    engine_keys: string[];
    text_fragment: string | null;
  }>(
    `WITH cluster_prompts AS (
       SELECT id FROM tracked_prompts
        WHERE workspace_id = app.current_workspace() AND project_id = $1 AND cluster_id = $2 AND deleted_at IS NULL
     ), facts AS (
       SELECT split_part(cf.normalized_url, '#', 1) AS base_url, cf.domain, cf.engine_key, cf.is_owned,
              (cf.domain = pr.root_domain OR right(cf.domain, length(pr.root_domain) + 1) = '.' || pr.root_domain) AS on_brand_domain,
              cf.position_weight::double precision AS position_weight, cf.captured_at, cf.text_fragment,
              COALESCE(pe.weight, 1.0)::double precision AS engine_weight
         FROM citation_facts cf
         JOIN cluster_prompts cp ON cp.id = cf.prompt_id
         JOIN projects pr ON pr.id = cf.project_id
         LEFT JOIN project_engines pe ON pe.project_id = cf.project_id AND pe.engine_key = cf.engine_key
        WHERE cf.workspace_id = app.current_workspace() AND cf.project_id = $1
          AND cf.captured_at >= now() - make_interval(days => $3::int)
     )
     SELECT base_url AS url,
            encode(sha256(convert_to(base_url, 'UTF8')), 'hex') AS url_hash,
            min(domain) AS domain,
            sum(position_weight * engine_weight) AS score,
            count(*)::int AS citation_frequency,
            avg(position_weight)::real AS avg_position_weight,
            array_agg(DISTINCT engine_key ORDER BY engine_key) AS engine_keys,
            (array_agg(text_fragment ORDER BY captured_at DESC) FILTER (WHERE text_fragment IS NOT NULL))[1] AS text_fragment
       FROM facts
      GROUP BY base_url
     HAVING NOT bool_or(is_owned) AND NOT bool_or(on_brand_domain)
      ORDER BY score DESC, base_url
      LIMIT $4`,
    [input.projectId, input.clusterId, CORPUS.windowDays, CORPUS.topUrls],
  );
  return result.rows.map((row) => ({
    url: row.url,
    urlHashHex: row.url_hash,
    domain: row.domain,
    score: Number(row.score),
    citationFrequency: row.citation_frequency,
    avgPositionWeight: Number(row.avg_position_weight),
    engineKeys: row.engine_keys,
    textFragment: row.text_fragment,
  }));
}

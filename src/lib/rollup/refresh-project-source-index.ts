import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { classifyDomain } from "../parser/citation-url.js";
import { gapSeverity, isSeedableSourceClass, sourceContextWeights } from "../scoring/index.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { refreshProjectSourceCoverage } from "./refresh-project-source-coverage.js";

// NEW-C-4 / STORY-054 — computes `project_source_index` from `citation_facts`
// and `source_domains` classification, then `projects.source_coverage`.
//
// Scope, per (window, engine): the 7/30/90-day windows for every engine that
// cited something, plus an `engine_key='all'` row across engines. The brand's
// own citations (`is_owned`) and unresolved ones (`http_status IS NULL`, which
// §`citation_facts` excludes from every citation metric) are not sources.
//
// A recompute REPLACES the project's index: every row is deleted and
// re-inserted in the caller's transaction, so a domain that left the window
// disappears and nothing accumulates. Verified presence (`verified_at` set,
// written by the verification worker, NEW-C-15) is carried across; an
// unverified domain stays `brand_present_on_domain = NULL` and gets
// `gap_severity = NULL` — absence is never assumed.
//
// |P(T)| (breadth's denominator) is the number of distinct prompts that
// produced a usable citation in the same (window, engine) scope.

const logger = new Logger("refresh-project-source-index");

export const SOURCE_INDEX_WINDOWS = [7, 30, 90] as const;
const TOP_URLS_PER_DOMAIN = 5;

interface DomainAgg {
  scope: string;
  domain: string;
  citation_count: number;
  distinct_prompts: number;
  distinct_urls: number;
  raw_weight: number;
  avg_weight: number;
  is_competitor: boolean;
  source_class: string | null;
}

export async function refreshProjectSourceIndex(tx: ClientBase, projectId: string, today?: string): Promise<void> {
  const project = await tx.query<{ workspace_id: string; today: string }>(
    `SELECT workspace_id, COALESCE($2::text, to_char(CURRENT_DATE, 'YYYY-MM-DD')) AS today FROM projects WHERE id = $1`,
    [projectId, today ?? null],
  );
  const workspaceId = project.rows[0]?.workspace_id;
  if (workspaceId === undefined) return; // no such project visible to this tenant context
  const asOf = project.rows[0]!.today;

  // Verified presence survives a recompute; seeded/unverified values do not.
  const carried = new Map<string, { present: boolean; verifiedAt: string }>();
  for (const row of (
    await tx.query<{ domain: string; present: boolean; verified_at: string }>(
      `SELECT DISTINCT ON (sd.domain) sd.domain, psi.brand_present_on_domain AS present, psi.verified_at::text AS verified_at
         FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id
        WHERE psi.project_id = $1 AND psi.verified_at IS NOT NULL AND psi.brand_present_on_domain IS NOT NULL
        ORDER BY sd.domain, psi.verified_at DESC`,
      [projectId],
    )
  ).rows) {
    carried.set(row.domain, { present: row.present, verifiedAt: row.verified_at });
  }

  await tx.query(`DELETE FROM project_source_index WHERE project_id = $1`, [projectId]);

  let written = 0;
  for (const windowDays of SOURCE_INDEX_WINDOWS) {
    const windowStart = (await tx.query<{ d: string }>(`SELECT to_char($1::date - $2::int, 'YYYY-MM-DD') AS d`, [asOf, windowDays])).rows[0]!.d;
    const scoped = `
      FROM citation_facts
     WHERE project_id = $1 AND NOT is_owned AND http_status IS NOT NULL
       AND captured_at >= $2::date AND captured_at < ($3::date + 1)`;
    const aggs = (
      await tx.query<DomainAgg>(
        `SELECT scope, domain, count(*)::int AS citation_count, count(DISTINCT prompt_id)::int AS distinct_prompts,
                count(DISTINCT normalized_url)::int AS distinct_urls, sum(position_weight)::float8 AS raw_weight,
                avg(position_weight)::float8 AS avg_weight, bool_or(is_competitor) AS is_competitor,
                mode() WITHIN GROUP (ORDER BY source_class) FILTER (WHERE source_class IS NOT NULL) AS source_class
           FROM (SELECT engine_key AS scope, * ${scoped} UNION ALL SELECT 'all' AS scope, * ${scoped}) f
          GROUP BY scope, domain`,
        [projectId, windowStart, asOf],
      )
    ).rows;
    const promptTotals = new Map(
      (
        await tx.query<{ scope: string; total: number }>(
          `SELECT scope, count(DISTINCT prompt_id)::int AS total
             FROM (SELECT engine_key AS scope, prompt_id ${scoped} UNION ALL SELECT 'all', prompt_id ${scoped}) f GROUP BY scope`,
          [projectId, windowStart, asOf],
        )
      ).rows.map((r) => [r.scope, r.total]),
    );
    const urlRows = (
      await tx.query<{ scope: string; domain: string; url: string; n: number; last_seen: string }>(
        `SELECT scope, domain, normalized_url AS url, count(*)::int AS n, to_char(max(captured_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS last_seen
           FROM (SELECT engine_key AS scope, * ${scoped} UNION ALL SELECT 'all' AS scope, * ${scoped}) f
          GROUP BY scope, domain, normalized_url`,
        [projectId, windowStart, asOf],
      )
    ).rows;
    const topUrls = new Map<string, Array<{ url: string; count: number; last_seen: string }>>();
    for (const row of urlRows.sort((a, b) => b.n - a.n || a.url.localeCompare(b.url))) {
      const key = `${row.scope}\u0000${row.domain}`;
      const list = topUrls.get(key) ?? [];
      if (list.length < TOP_URLS_PER_DOMAIN) list.push({ url: row.url, count: row.n, last_seen: row.last_seen });
      topUrls.set(key, list);
    }

    // Classification is a property of the domain, not the scope — decide it once.
    const classByDomain = new Map<string, { sourceClass: string; seedable: boolean }>();
    for (const agg of aggs) {
      if (classByDomain.has(agg.domain)) continue;
      const sourceClass = agg.is_competitor ? "vendor_owned" : (agg.source_class ?? classifyDomain(agg.domain));
      classByDomain.set(agg.domain, { sourceClass, seedable: isSeedableSourceClass(sourceClass, agg.is_competitor) });
    }
    const domainIds = new Map<string, string>();
    for (const [domain, cls] of classByDomain) {
      const res = await tx.query<{ id: string }>(
        `INSERT INTO source_domains (workspace_id, domain, display_name, source_class, is_seedable)
         VALUES ($1,$2,$2,$3,$4)
         ON CONFLICT (workspace_id, domain) DO UPDATE
           SET source_class = EXCLUDED.source_class, is_seedable = EXCLUDED.is_seedable, last_seen_at = now(), updated_at = now()
         RETURNING id`,
        [workspaceId, domain, cls.sourceClass, cls.seedable],
      );
      domainIds.set(domain, res.rows[0]!.id);
    }

    for (const scope of new Set(aggs.map((a) => a.scope))) {
      const inScope = aggs.filter((a) => a.scope === scope);
      const weights = sourceContextWeights(
        inScope.map((a) => ({ rawWeight: a.raw_weight, distinctPrompts: a.distinct_prompts })),
        promptTotals.get(scope) ?? 0,
      );
      const ranked = inScope
        .map((agg, i) => ({ agg, weight: weights[i]! }))
        .sort((a, b) => b.weight - a.weight || a.agg.domain.localeCompare(b.agg.domain));
      for (const [index, { agg, weight }] of ranked.entries()) {
        const cls = classByDomain.get(agg.domain)!;
        const verified = carried.get(agg.domain);
        const severity = gapSeverity({ contextWeight: weight, brandPresent: verified?.present ?? null, isSeedable: cls.seedable });
        await tx.query(
          `INSERT INTO project_source_index
             (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, citation_count, distinct_prompts,
              distinct_urls, avg_position_weight, context_weight, rank_position, brand_present_on_domain, verified_at, gap_severity, top_urls)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
          [
            workspaceId, projectId, domainIds.get(agg.domain), scope, windowStart, windowDays, agg.citation_count, agg.distinct_prompts,
            agg.distinct_urls, agg.avg_weight, weight, index + 1, verified?.present ?? null, verified?.verifiedAt ?? null, severity,
            JSON.stringify(topUrls.get(`${scope}\u0000${agg.domain}`) ?? []),
          ],
        );
        written += 1;
      }
    }
  }

  await refreshProjectSourceCoverage(tx, projectId);
  incrementCounter("nominara_rollup_source_index_refresh_total", { outcome: "ok" });
  logger.log({ event: "source_index_refreshed", workspaceId, projectId, rows: written });
}

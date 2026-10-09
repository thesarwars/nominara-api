import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import {
  storedTopUrlsSchema,
  type PlaybookQuery,
  type PlaybookResponse,
  type SourceDomain,
  type SourceIndexQuery,
  type SourceIndexResponse,
} from "../../../contracts/analytics/index.js";
import { ConflictError, NotFoundError } from "../../api/errors/domain-errors.js";
import { playbookTemplateFor } from "../../lib/sources/playbook-templates.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// NEW-C-7 — STORY-054's read side and STORY-055's playbook gate. Reads what
// `refreshProjectSourceIndex` (NEW-C-4) wrote; computes nothing about
// influence or severity itself, so the endpoint cannot disagree with the job.
//
// Only the `engine_key = 'all'` rows are read: the cross-engine blend is the
// Source Citation Index; a per-engine view is not part of this contract.

const logger = new Logger("SourcesService");
const DAYS: Readonly<Record<SourceIndexQuery["timeframe"], number>> = Object.freeze({ "7d": 7, "30d": 30, "90d": 90 });

interface IndexRow {
  domain: string;
  source_class: SourceDomain["source_class"];
  is_seedable: boolean;
  context_weight: number;
  citation_count: number;
  distinct_prompts: number;
  brand_present_on_domain: boolean | null;
  verified_at: string | null;
  gap_severity: SourceDomain["gap_severity"];
  top_urls: unknown;
  window_start: string;
  window_end: string;
}

@Injectable()
export class SourcesService {
  async sourceIndex(projectId: string, query: SourceIndexQuery): Promise<SourceIndexResponse> {
    const { client: tx, workspaceId } = this.store();
    const days = DAYS[query.timeframe];
    const project = await this.project(tx, projectId, days);
    const rows = await this.rows(tx, projectId, days);

    const competitors = (
      await tx.query<{ name: string; root_domain: string }>(
        `SELECT name, lower(regexp_replace(root_domain, '^www\\.', '')) AS root_domain
           FROM competitors WHERE project_id = $1 AND root_domain IS NOT NULL ORDER BY name`,
        [projectId],
      )
    ).rows;

    const domains: SourceDomain[] = rows.map((row) => ({
      domain: row.domain,
      influence: Math.min(1, Math.max(0, row.context_weight)),
      citations: row.citation_count,
      prompts: row.distinct_prompts,
      source_class: row.source_class,
      brand_present: row.brand_present_on_domain,
      verified_at: row.verified_at,
      gap_severity: row.gap_severity,
      seedable: row.is_seedable,
      top_urls: storedTopUrlsSchema.parse(row.top_urls).map((u) => ({ url: u.url, citations: u.count, last_seen: u.last_seen })),
      competitors_present: competitors.filter((c) => c.root_domain === row.domain.replace(/^www\./, "")).map((c) => c.name),
    }));

    incrementCounter("nominara_sources_index_read_total", { timeframe: query.timeframe });
    logger.log({ event: "source_index_read", workspaceId: workspaceId, projectId, timeframe: query.timeframe, domains: domains.length });

    const first = rows[0];
    return {
      window: first === undefined ? { from: project.from, to: project.to } : { from: first.window_start, to: first.window_end },
      source_coverage: project.sourceCoverage,
      domains,
    };
  }

  async playbook(projectId: string, domain: string, query: PlaybookQuery): Promise<PlaybookResponse> {
    const { client: tx, workspaceId } = this.store();
    const days = DAYS[query.timeframe];
    await this.project(tx, projectId, days);
    const row = (await this.rows(tx, projectId, days)).find((r) => r.domain === domain);
    if (row === undefined) throw new NotFoundError({ message: "domain is not in this project's source index" });

    // FR-SR-03a — a playbook exists only for a critical or high gap on a
    // seedable domain. An unverified domain has no severity, so no playbook.
    const actionable = row.is_seedable && (row.gap_severity === "critical" || row.gap_severity === "high");
    const template = actionable ? playbookTemplateFor(row.source_class) : null;
    if (!actionable || template === null) {
      incrementCounter("nominara_sources_playbook_total", { outcome: "refused" });
      throw new ConflictError({ message: "playbooks exist only for critical and high gaps on seedable domains" });
    }

    const topUrls = storedTopUrlsSchema.parse(row.top_urls);
    incrementCounter("nominara_sources_playbook_total", { outcome: "served" });
    logger.log({ event: "playbook_served", workspaceId: workspaceId, projectId, slug: template.slug, version: template.version });
    return {
      domain: row.domain,
      target_url: topUrls[0]?.url ?? `https://${row.domain}`,
      why: `${row.domain} carries ${(row.context_weight * 100).toFixed(1)}% of citation influence across ${String(row.distinct_prompts)} prompts in the last ${String(days)} days, and Nominara's fetch did not find your brand there.`,
      rules: template.rules.map((r) => ({ quote: r.quote, url: r.url })),
      rules_unavailable_reason: template.rulesUnavailableReason,
      outline: [...template.outline],
      disclosure: template.disclosure,
      do_not: [...template.doNot],
      verification: template.verification,
      template_slug: template.slug,
      template_version: template.version,
    };
  }

  private store(): { client: ClientBase; workspaceId: string } {
    const current = currentTenantStore();
    if (current === undefined) throw new Error("SourcesService requires an active tenant context");
    return { client: current.client, workspaceId: current.context.workspaceId };
  }

  private async project(
    tx: ClientBase,
    projectId: string,
    days: number,
  ): Promise<{ from: string; to: string; sourceCoverage: number | null }> {
    const res = await tx.query<{ from: string; to: string; source_coverage: string | null }>(
      `SELECT to_char(today - $2::int, 'YYYY-MM-DD') AS from, to_char(today, 'YYYY-MM-DD') AS to, p.source_coverage::text
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id,
              LATERAL (SELECT (now() AT TIME ZONE w.timezone)::date AS today) t
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [projectId, days],
    );
    const row = res.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such project" });
    return { from: row.from, to: row.to, sourceCoverage: row.source_coverage === null ? null : Number(row.source_coverage) };
  }

  private async rows(tx: ClientBase, projectId: string, days: number): Promise<IndexRow[]> {
    return (
      await tx.query<IndexRow>(
        `SELECT sd.domain,
                CASE WHEN psi.is_competitor_owned THEN 'vendor_owned' ELSE sd.source_class END AS source_class,
                (sd.is_seedable AND NOT psi.is_competitor_owned) AS is_seedable, psi.context_weight::float8 AS context_weight, psi.citation_count,
                psi.distinct_prompts, psi.brand_present_on_domain, psi.gap_severity, psi.top_urls,
                to_char(psi.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS verified_at,
                to_char(psi.window_start, 'YYYY-MM-DD') AS window_start,
                to_char(psi.window_start + psi.window_days, 'YYYY-MM-DD') AS window_end
           FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id
          WHERE psi.project_id = $1 AND psi.engine_key = 'all' AND psi.window_days = $2
          ORDER BY psi.rank_position, sd.domain`,
        [projectId, days],
      )
    ).rows;
  }
}

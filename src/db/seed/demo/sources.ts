import type { ClientBase } from "pg";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS } from "../../../lib/rollup/refresh-project-task-counts.js";
import { refreshProjectSourceCoverage } from "../../../lib/rollup/refresh-project-source-coverage.js";
import type { DemoProjectRef } from "./facts.js";
import { type Rng, pick, rngFor, uniformInt } from "./rng.js";

// STORY-169 — `source_domains` and `project_source_index` for one project,
// then `refreshProjectSourceCoverage` (STORY-169's own real producer) to
// denormalise `projects.source_coverage`.
//
// ⚠ NO MARKER NEEDED ON EITHER TABLE, AND THAT IS A FACT ABOUT THE CODEBASE
// TODAY, NOT AN ASSUMPTION. `map.txt`'s own survey: "Nothing writes
// source_domains or project_source_index" outside a test fixture — there is
// no `crawl.audit`-equivalent producer for sources yet. So every row this
// query can find for a given project is, by construction, something this
// seed (or a prior run of it) put there. Reset-then-write is therefore a
// plain `DELETE ... WHERE project_id = $1` with no marker predicate needed —
// still scoped to the one project, never the whole workspace, so a workspace
// with other projects is untouched by this project's re-seed.

const DOMAIN_TEMPLATES: readonly { readonly suffix: string; readonly sourceClass: string; readonly seedable: boolean }[] = [
  { suffix: "community-forum.example", sourceClass: "community_forum", seedable: true },
  { suffix: "review-marketplace.example", sourceClass: "review_marketplace", seedable: true },
  { suffix: "industry-encyclopedia.example", sourceClass: "encyclopedic", seedable: false },
  { suffix: "trade-news.example", sourceClass: "news_media", seedable: false },
  { suffix: "dev-platform.example", sourceClass: "developer_platform", seedable: true },
];

const GAP_SEVERITIES: readonly ("critical" | "high" | "medium" | "low" | "none")[] = ["critical", "high", "medium", "low", "none"];

export async function deleteExistingDemoSources(tx: ClientBase, workspaceId: string, projectId: string): Promise<void> {
  await tx.query(`DELETE FROM project_source_index WHERE project_id = $1`, [projectId]);
  // Orphaned only AFTER the delete above — a domain another still-seeded
  // project in this workspace references stays, because `ux_source_domains`
  // is unique per (workspace_id, domain) and a shared domain must survive
  // one project's re-seed.
  await tx.query(
    `DELETE FROM source_domains sd
      WHERE sd.workspace_id = $1
        AND NOT EXISTS (SELECT 1 FROM project_source_index psi WHERE psi.source_domain_id = sd.id)`,
    [workspaceId],
  );
}

export interface SeededSourceDomain {
  readonly id: string;
  readonly domain: string;
  readonly gapSeverity: "critical" | "high" | "medium" | "low" | "none";
}

interface DomainSeed {
  readonly id: string;
  readonly contextWeight: number;
  readonly gapSeverity: "critical" | "high" | "medium" | "low" | "none";
}

export interface SeedSourcesResult {
  /** Every domain with a `critical` or `high` gap — what `tasks.ts` links `TG-SOURCE-ABSENCE` tasks to. */
  readonly criticalOrHighDomains: readonly SeededSourceDomain[];
}

export async function resetAndSeedProjectSources(tx: ClientBase, project: DemoProjectRef): Promise<SeedSourcesResult> {
  const rng = rngFor(project.id, "sources");
  await deleteExistingDemoSources(tx, project.workspaceId, project.id);

  const domains: DomainSeed[] = [];
  const domainNames: string[] = [];
  const rawWeights: number[] = [];
  for (const template of DOMAIN_TEMPLATES) {
    const domain = `${project.rootDomain.replace(/\./gu, "-")}.${template.suffix}`;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO source_domains (id, workspace_id, domain, display_name, source_class, authority_tier, is_seedable)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, domain) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [uuidV7(), project.workspaceId, domain, domain, template.sourceClass, uniformInt(rng, 1, 5), template.seedable],
    );
    // `RETURNING id` on a conflict yields the EXISTING row's id, never the
    // freshly generated one this call happened to mint — reading it back is
    // what keeps `project_source_index` pointing at the row that actually
    // exists rather than an id nothing references.
    rawWeights.push(uniformInt(rng, 5, 25));
    domains.push({ id: inserted.rows[0]!.id, contextWeight: 0, gapSeverity: "none" });
    domainNames.push(domain);
  }

  // Normalise to sum to 1 — `sourceCoverage()`'s own precondition.
  const weightTotal = rawWeights.reduce((total, weight) => total + weight, 0);
  const severities = assignSeverities(rng, domains.length);
  const windowStart = await currentWindowStart(tx);
  const criticalOrHighDomains: SeededSourceDomain[] = [];

  for (const [index, domain] of domains.entries()) {
    const contextWeight = rawWeights[index]! / weightTotal;
    const gapSeverity = severities[index]!;
    if (gapSeverity === "critical" || gapSeverity === "high") {
      criticalOrHighDomains.push({ id: domain.id, domain: domainNames[index]!, gapSeverity });
    }
    await tx.query(
      `INSERT INTO project_source_index
         (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days,
          citation_count, distinct_prompts, distinct_urls, avg_position_weight, context_weight,
          rank_position, brand_present_on_domain, gap_severity, top_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'[]'::jsonb)
       ON CONFLICT (project_id, source_domain_id, engine_key, window_start, window_days)
       DO UPDATE SET context_weight = EXCLUDED.context_weight, gap_severity = EXCLUDED.gap_severity`,
      [
        project.workspaceId,
        project.id,
        domain.id,
        SOURCE_INDEX_ENGINE_KEY,
        windowStart,
        SOURCE_INDEX_WINDOW_DAYS,
        uniformInt(rng, 0, 12),
        uniformInt(rng, 0, 6),
        uniformInt(rng, 0, 8),
        contextWeight,
        contextWeight,
        index + 1,
        gapSeverity === "none",
        gapSeverity,
      ],
    );
  }

  await refreshProjectSourceCoverage(tx, project.id);
  return { criticalOrHighDomains };
}

/** At least one critical and one high gap, always — "enough for the card to have something to show", per the story's own worked example. */
function assignSeverities(rng: Rng, count: number): ("critical" | "high" | "medium" | "low" | "none")[] {
  const severities: ("critical" | "high" | "medium" | "low" | "none")[] = ["critical", "high"];
  for (let i = severities.length; i < count; i += 1) {
    severities.push(pick(rng, GAP_SEVERITIES));
  }
  return severities;
}

async function currentWindowStart(tx: ClientBase): Promise<string> {
  const result = await tx.query<{ start: string }>(
    `SELECT to_char(CURRENT_DATE - $1::int, 'YYYY-MM-DD') AS start`,
    [SOURCE_INDEX_WINDOW_DAYS],
  );
  return result.rows[0]!.start;
}

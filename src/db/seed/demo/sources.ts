import type { ClientBase } from "pg";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS } from "../../../lib/rollup/refresh-project-task-counts.js";
import { refreshProjectSourceCoverage } from "../../../lib/rollup/refresh-project-source-coverage.js";
import type { DemoProjectRef } from "./facts.js";
import { chance, rngFor, uniform, uniformInt } from "./rng.js";

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
  readonly domain: string;
  readonly isSeedable: boolean;
  readonly contextWeight: number;
  readonly brandPresent: boolean;
}

export interface SeedSourcesResult {
  /** Every domain with a `critical` or `high` gap — what `tasks.ts` links `TG-SOURCE-ABSENCE` tasks to. */
  readonly criticalOrHighDomains: readonly SeededSourceDomain[];
}

/**
 * §5's own formula (scoring-models.md), applied verbatim — NOT a random
 * pick (STORY-169 review, PROBE: the seed used to draw `gap_severity`
 * independently of `context_weight`/`is_seedable`, which let a non-seedable
 * encyclopedic/news domain come back `critical` and generate a
 * `TG-SOURCE-ABSENCE` authority task for a domain the brand cannot
 * legitimately seed — §5's own words: "escalating a domain the brand
 * cannot legitimately contribute to... is noise", and "ONLY critical and
 * high gaps on SEEDABLE domains generate authority tasks").
 *
 * `is_seedable` gates ONLY the top two tiers — `medium`/`low` apply to any
 * domain, matching the formula exactly (no `is_seedable` term on those two
 * branches).
 */
export function deriveGapSeverity(contextWeight: number, isSeedable: boolean, brandPresent: boolean): "critical" | "high" | "medium" | "low" | "none" {
  if (brandPresent) return "none";
  if (contextWeight >= 0.15 && isSeedable) return "critical";
  if (contextWeight >= 0.08 && isSeedable) return "high";
  if (contextWeight >= 0.03) return "medium";
  if (contextWeight > 0) return "low";
  return "none";
}

export async function resetAndSeedProjectSources(tx: ClientBase, project: DemoProjectRef): Promise<SeedSourcesResult> {
  const rng = rngFor(project.id, "sources");
  await deleteExistingDemoSources(tx, project.workspaceId, project.id);

  const inserted: { id: string; domain: string; isSeedable: boolean }[] = [];
  for (const template of DOMAIN_TEMPLATES) {
    const domain = `${project.rootDomain.replace(/\./gu, "-")}.${template.suffix}`;
    const row = await tx.query<{ id: string }>(
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
    inserted.push({ id: row.rows[0]!.id, domain, isSeedable: template.seedable });
  }

  // ⚠ TWO DOMAINS ARE FORCED TO A GAP, NOT TWO SEVERITIES CHOSEN DIRECTLY —
  // "at least one critical and one high, always" (the story's own worked
  // example, "enough for the card to have something to show") now has to be
  // engineered THROUGH `context_weight` and `brand_present`, since severity
  // is derived from them rather than picked. `DOMAIN_TEMPLATES[0]`
  // (community-forum) and `[1]` (review-marketplace) are both `is_seedable`,
  // forced NOT brand-present, and given target shares of the normalised
  // total comfortably inside the critical (>= 0.15) and high ([0.08, 0.15))
  // bands respectively — exact target shares, not a raw-weight draw
  // normalised afterward, so the OTHER three domains' random weights can
  // never push either share across a band boundary.
  const forcedCriticalShare = uniform(rng, 0.2, 0.32);
  const forcedHighShare = uniform(rng, 0.09, 0.13);
  const remainingShare = 1 - forcedCriticalShare - forcedHighShare;

  const otherRawWeights = inserted.slice(2).map(() => uniformInt(rng, 5, 25));
  const otherRawTotal = otherRawWeights.reduce((total, weight) => total + weight, 0);

  const domains: DomainSeed[] = inserted.map((row, index) => {
    if (index === 0) return { ...row, contextWeight: forcedCriticalShare, brandPresent: false };
    if (index === 1) return { ...row, contextWeight: forcedHighShare, brandPresent: false };
    const share = (otherRawWeights[index - 2]! / otherRawTotal) * remainingShare;
    // Non-forced domains: presence is a coin flip, independent of weight —
    // a heavily-cited domain can still already carry the brand.
    return { ...row, contextWeight: share, brandPresent: chance(rng, 0.5) };
  });

  const windowStart = await currentWindowStart(tx);
  const criticalOrHighDomains: SeededSourceDomain[] = [];

  for (const [index, domain] of domains.entries()) {
    const gapSeverity = deriveGapSeverity(domain.contextWeight, domain.isSeedable, domain.brandPresent);
    // Belt and suspenders (matching `tasks.service.ts`'s own
    // `normalizeSeverity` posture): `criticalOrHighDomains` feeds
    // `TG-SOURCE-ABSENCE` authority-task generation directly, and §5 is
    // explicit that only a SEEDABLE domain's critical/high gap may — a
    // structurally redundant check today (`deriveGapSeverity` cannot return
    // critical/high for a non-seedable domain), kept so a future edit to
    // the formula cannot silently reopen this without also touching here.
    if ((gapSeverity === "critical" || gapSeverity === "high") && domain.isSeedable) {
      criticalOrHighDomains.push({ id: domain.id, domain: domain.domain, gapSeverity });
    }
    await tx.query(
      `INSERT INTO project_source_index
         (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days,
          citation_count, distinct_prompts, distinct_urls, avg_position_weight, context_weight,
          rank_position, brand_present_on_domain, gap_severity, top_urls)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'[]'::jsonb)
       ON CONFLICT (project_id, source_domain_id, engine_key, window_start, window_days)
       DO UPDATE SET context_weight = EXCLUDED.context_weight, gap_severity = EXCLUDED.gap_severity,
                      brand_present_on_domain = EXCLUDED.brand_present_on_domain`,
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
        domain.contextWeight,
        domain.contextWeight,
        index + 1,
        domain.brandPresent,
        gapSeverity,
      ],
    );
  }

  await refreshProjectSourceCoverage(tx, project.id);
  return { criticalOrHighDomains };
}

async function currentWindowStart(tx: ClientBase): Promise<string> {
  const result = await tx.query<{ start: string }>(
    `SELECT to_char(CURRENT_DATE - $1::int, 'YYYY-MM-DD') AS start`,
    [SOURCE_INDEX_WINDOW_DAYS],
  );
  return result.rows[0]!.start;
}

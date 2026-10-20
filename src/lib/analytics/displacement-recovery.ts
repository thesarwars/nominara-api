import { createHash } from "node:crypto";
import type { ClientBase } from "pg";
import type { CitationGapEntry, ConceptGapEntry } from "../../../contracts/analytics/index.js";

// NEW-C-5 AC1 — how many tasks a recovery plan would create for a displacement.
// STORY-057 AC6/AC8: one content task per concept gap, one authority task per
// citation gap on a SEEDABLE domain, and none for a non-seedable one (it is
// recorded and visible, not actionable). The feed shows this count BEFORE the
// click; the plan generator (NEW-C-6) must use this same function so the two
// can never disagree.
//
// `seedableDomains` holds LOWER-CASED domains of the caller's workspace.

export function recoveryTaskCount(
  citationGap: readonly Pick<CitationGapEntry, "domain">[],
  conceptGap: readonly Pick<ConceptGapEntry, "concept">[],
  seedableDomains: ReadonlySet<string>,
): number {
  return authorityTargets(citationGap, seedableDomains).length + conceptGap.length;
}

/**
 * NEW-C-6 — the authority tasks a plan makes: the FIRST gap entry of each seedable domain, in gap order.
 * The task fingerprint is per project + domain (owner decision 2026-10-08), so two URLs on one domain are
 * one task; counting them as two would make the feed's count promise a task the plan cannot create. The plan
 * and `recoveryTaskCount` both go through this function, so they cannot disagree.
 */
export function authorityTargets<T extends Pick<CitationGapEntry, "domain">>(
  citationGap: readonly T[],
  seedableDomains: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>();
  const targets: T[] = [];
  for (const entry of citationGap) {
    const domain = entry.domain.toLowerCase();
    if (!seedableDomains.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    targets.push(entry);
  }
  return targets;
}

/** NEW-C-6 — `sha256('authority:{project_id}:{domain}')`, the domain lower-cased (owner decision 2026-10-08). */
export function authorityTaskFingerprint(projectId: string, domain: string): Buffer {
  return createHash("sha256").update(`authority:${projectId}:${domain.toLowerCase()}`).digest();
}

/**
 * STORY-054 AC10 (owner decision 2026-10-13) — the domains an authority task may be made for: SEEDABLE in the workspace AND
 * at a critical or high gap severity on the project's `project_source_index` row at engine 'all', over `windowDays` (the
 * widest window), on its LATEST row. No row, no task. Returns lower-cased domain to `source_domains.id`.
 *
 * ONE definition for every path that makes an authority task: the on-demand recovery plan (DisplacementService) and the
 * rule-driven generator (STORY-063) both read it, so they cannot disagree about which domains are actionable. The caller's
 * transaction supplies RLS; `workspaceId` is the value of the equality, not the isolation.
 */
export async function actionableAuthorityDomains(
  client: ClientBase,
  workspaceId: string,
  projectId: string,
  domains: readonly string[] | null,
  windowDays: number,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (domains !== null && domains.length === 0) return found;
  // The LATEST row per domain, then the severity filter: an older critical row superseded by a newer lower one is not a gap.
  const rows = await client.query<{ id: string; domain: string }>(
    `WITH latest AS (
       SELECT DISTINCT ON (psi.source_domain_id) psi.source_domain_id, psi.gap_severity
         FROM project_source_index psi
        WHERE psi.workspace_id = $1 AND psi.project_id = $2 AND psi.engine_key = 'all' AND psi.window_days = $4
        ORDER BY psi.source_domain_id, psi.window_start DESC
     )
     SELECT sd.id, lower(sd.domain) AS domain
       FROM latest l
       JOIN source_domains sd ON sd.id = l.source_domain_id
      WHERE sd.workspace_id = $1 AND sd.is_seedable AND ($3::text[] IS NULL OR lower(sd.domain) = ANY($3::text[]))
        AND l.gap_severity IN ('critical', 'high')`,
    [workspaceId, projectId, domains === null ? null : [...domains], windowDays],
  );
  for (const row of rows.rows) found.set(row.domain, row.id);
  return found;
}

/**
 * The displacement points at its task, so the same event is never planned twice. Set once and never replaced: the first
 * task wins. Both the on-demand recovery plan and the rule-driven generator call this one statement.
 */
export async function linkDisplacementToTask(client: ClientBase, workspaceId: string, displacementId: string, taskId: string): Promise<void> {
  // `workspace_id` is defence in depth: RLS is the guarantee, the equality is not.
  await client.query("UPDATE displacement_events SET task_id = $3 WHERE id = $1 AND workspace_id = $2 AND task_id IS NULL", [
    displacementId, workspaceId, taskId,
  ]);
}

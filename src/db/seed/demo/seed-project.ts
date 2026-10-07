import type { ClientBase } from "pg";
import { denormalizeProject } from "../../../lib/rollup/denormalize.js";
import { refreshProjectGeoWindows } from "../../../lib/rollup/refresh-project-geo.js";
import { rollUpDay } from "../../../lib/rollup/roll-up-day.js";
import { withProjectQueueLock } from "../../../lib/queue/locks.js";
import { resetAndSeedProjectAux } from "./aux.js";
import { resetAndSeedProjectFacts, type SeedFactsOptions } from "./facts.js";
import { resetAndSeedProjectSources } from "./sources.js";
import { resetAndSeedProjectTasks } from "./tasks.js";
import type { TargetProject } from "./projects.js";

// STORY-169 — one project, seeded end to end: facts → the REAL rollup
// (`rollUpDay` + `denormalizeProject`, under the SAME advisory lock
// `rollup.metric_daily`'s real handler takes) → AUX → sources → tasks →
// the `demo_seeded_at` marker. All inside the caller's ambient tenant
// transaction (`nominara_app`, `withTenantContext`) — this file opens
// nothing of its own.

export interface SeedProjectSummary {
  readonly projectId: string;
  readonly days: number;
  readonly engines: number;
  readonly findings: number;
  readonly criticalOrHighSources: number;
}

export async function seedOneProject(
  tx: ClientBase,
  project: TargetProject,
  timezone: string,
  options: SeedFactsOptions = {},
): Promise<SeedProjectSummary> {
  const facts = await resetAndSeedProjectFacts(tx, project, timezone, options);

  await withProjectQueueLock(tx, "rollup.metric_daily", project.id, async () => {
    for (const date of facts.days) {
      await rollUpDay(tx, project.workspaceId, project.id, date, timezone);
    }
    await denormalizeProject(tx, project.id, timezone);
    // STORY-060 — A3 over the seeded facts (demo engines are marked by the seed's normalizer_version).
    await refreshProjectGeoWindows(tx, project.id);
  });

  const auxResult = await resetAndSeedProjectAux(tx, project);
  const sourcesResult = await resetAndSeedProjectSources(tx, project);
  await resetAndSeedProjectTasks(tx, project, auxResult.findings, sourcesResult.criticalOrHighDomains, facts.engineKeys);

  await tx.query(`UPDATE projects SET demo_seeded_at = now() WHERE id = $1`, [project.id]);

  return {
    projectId: project.id,
    days: facts.days.length,
    engines: facts.engineKeys.length,
    findings: auxResult.findings.length,
    criticalOrHighSources: sourcesResult.criticalOrHighDomains.length,
  };
}

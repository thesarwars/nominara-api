import type { ClientBase } from "pg";
import { uuidV7 } from "../../../lib/ids/uuidv7.js";
import { refreshProjectTaskCounts } from "../../../lib/rollup/refresh-project-task-counts.js";
import { DEMO_SEED_MARKER, DEMO_TASK_MARKER_KEY, DEMO_TASK_RULES } from "./constants.js";
import type { DemoProjectRef } from "./facts.js";
import type { SeededFinding } from "./aux.js";
import type { SeededSourceDomain } from "./sources.js";
import { chance, pick, rngFor, uniformInt } from "./rng.js";

// STORY-169 — 5-12 tasks per project, linked to the findings and source gaps
// this same run just seeded (or, once the pool of those runs out, to a
// generic content/technical task), then `refreshProjectTaskCounts` — the
// real STORY-169 producer — to denormalise `projects.open_task_count` and
// `open_tasks_by_severity`.
//
// ⚠ `task_generation_rules` NEEDS ITS TWO CODES INSERTED FIRST, same
// `ON CONFLICT (code) DO NOTHING` posture as the AUX catalog — global,
// shared, never overwritten.

type TaskKind = "content" | "technical" | "authority" | "monitoring";

const CATEGORY_TO_KIND: Readonly<Record<string, TaskKind>> = {
  crawler_access: "technical",
  structured_data: "technical",
  render_mode: "technical",
  context_fitness: "content",
  entity_clarity: "content",
  freshness: "content",
};

const EFFORT_BANDS: readonly ("xs" | "s" | "m" | "l" | "xl")[] = ["xs", "s", "m", "l", "xl"];

interface TaskCandidate {
  readonly kind: TaskKind;
  readonly ruleCode: string | null;
  readonly title: string;
  readonly description: string;
  readonly sourceFindingId: string | null;
  readonly sourceDomainId: string | null;
  readonly severityHint: "critical" | "high" | "medium" | "low" | null;
  readonly playbookSlug: string | null;
}

async function ensureTaskRules(tx: ClientBase): Promise<void> {
  for (const rule of DEMO_TASK_RULES) {
    // Migration 0129 seeds these codes and revokes INSERT on the catalog from the runtime role this seeder connects as, so the row is
    // only ever READ here; the insert below is the fallback for a database that predates 0129.
    const existing = await tx.query("SELECT 1 FROM task_generation_rules WHERE code = $1", [rule.code]);
    if (existing.rows.length > 0) continue;
    await tx.query(
      `INSERT INTO task_generation_rules
         (code, category, title_template, description_template, trigger_kind, condition,
          default_priority, impact_weight, effort_band, rule_version)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8,$9)
       ON CONFLICT (code) DO NOTHING`,
      [
        rule.code,
        rule.category,
        rule.titleTemplate,
        rule.descriptionTemplate,
        rule.triggerKind,
        rule.defaultPriority,
        rule.impactWeight,
        rule.effortBand,
        "1.0.0",
      ],
    );
  }
}

export async function deleteExistingDemoTasks(tx: ClientBase, projectId: string): Promise<void> {
  await tx.query(`DELETE FROM tasks WHERE project_id = $1 AND playbook_payload ->> $2 = $3`, [
    projectId,
    DEMO_TASK_MARKER_KEY,
    DEMO_SEED_MARKER,
  ]);
}

function sha1(value: string): Buffer {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h1 ^= value.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  const buffer = Buffer.alloc(20);
  buffer.writeUInt32BE(h1 >>> 0, 0);
  buffer.write(value.slice(0, 16), 4, "utf8");
  return buffer;
}

/** The prefix `ref_counters` tracks for this project — the first 3 letters of its name, uppercased, alpha-only. */
function shortRefPrefix(projectName: string): string {
  const letters = projectName.toUpperCase().replace(/[^A-Z]/gu, "");
  return (letters.slice(0, 3) || "DEM").padEnd(3, "X");
}

async function nextShortRef(tx: ClientBase, workspaceId: string, prefix: string): Promise<string> {
  const updated = await tx.query<{ used: number }>(
    `UPDATE ref_counters SET next_value = next_value + 1 WHERE workspace_id = $1 AND prefix = $2
     RETURNING next_value - 1 AS used`,
    [workspaceId, prefix],
  );
  if (updated.rows[0] !== undefined) return `${prefix}-${String(updated.rows[0].used)}`;

  await tx.query(
    `INSERT INTO ref_counters (workspace_id, prefix, next_value) VALUES ($1,$2,2) ON CONFLICT (workspace_id, prefix) DO NOTHING`,
    [workspaceId, prefix],
  );
  const retried = await tx.query<{ used: number }>(
    `UPDATE ref_counters SET next_value = next_value + 1 WHERE workspace_id = $1 AND prefix = $2
     RETURNING next_value - 1 AS used`,
    [workspaceId, prefix],
  );
  return `${prefix}-${String(retried.rows[0]?.used ?? 1)}`;
}

function buildCandidates(
  project: DemoProjectRef,
  findings: readonly SeededFinding[],
  domains: readonly SeededSourceDomain[],
  engineKeys: readonly string[],
): TaskCandidate[] {
  const candidates: TaskCandidate[] = [];

  for (const finding of findings) {
    candidates.push({
      kind: CATEGORY_TO_KIND[finding.category] ?? "technical",
      ruleCode: null, // COALESCE(af.rule_code, t.rule_code) reads the FINDING's own code at read time.
      title: `Fix ${finding.ruleCode} on ${project.name}`,
      description: `An AUX audit opened a ${finding.severity} finding (${finding.ruleCode}) for ${project.name}. Resolve it and it clears on the next audit.`,
      sourceFindingId: finding.id,
      sourceDomainId: null,
      severityHint: finding.severity === "info" ? null : finding.severity,
      // STORY-169 review — NO playbook_slug here. `derivePrimaryAction`
      // (tasks.service.ts) checks `playbook_slug` before `source_finding_id`
      // ON PURPOSE, for a task that legitimately carries both (an authority
      // task an AUX finding recommended). A fabricated slug like
      // `fix-aux-r-001` is not that case — playbooks are source-seeding/
      // authority actions (sources-and-rollups.md, `is_seedable`), and an
      // AUX finding's own guided fix is its `suggested_fix` PATCH
      // (`FR-AX-04`), which is exactly what leaving this `null` reaches:
      // `copy_patch`, keyed to `source_finding_id` below. Setting a slug no
      // real playbook ever has made every demo AUX item — including the
      // critical AUX-R-001 robots.txt row — resolve to `open_playbook` and
      // route a client to a Sources-page playbook that does not exist.
      playbookSlug: null,
    });
  }

  const sourceRule = DEMO_TASK_RULES.find((rule) => rule.code === "TG-SOURCE-ABSENCE")!;
  for (const domain of domains) {
    candidates.push({
      kind: "authority",
      ruleCode: sourceRule.code,
      title: sourceRule.titleTemplate.replace("{domain}", domain.domain),
      description: sourceRule.descriptionTemplate.replace("{domain}", domain.domain),
      sourceFindingId: null,
      sourceDomainId: domain.id,
      severityHint: domain.gapSeverity === "none" ? null : domain.gapSeverity,
      // STORY-169 review — `source_domains.seeding_playbook_slug`, never a
      // fabricated literal. `domains` here is exactly `resetAndSeedProject
      // Sources`'s `criticalOrHighDomains`, which only ever contains
      // `is_seedable` domains (sources.ts's own belt-and-suspenders check),
      // so this is never null in practice today — but reading it off the
      // seeded row rather than inventing a string keeps this task's
      // `open_playbook` target meaning what the contract says it means: a
      // REAL `source_domains`-scoped playbook slug, not a string no
      // playbook catalog will ever recognise.
      playbookSlug: domain.seedingPlaybookSlug,
    });
  }

  const sovRule = DEMO_TASK_RULES.find((rule) => rule.code === "TG-SOV-DROP-ENGINE")!;
  for (const engineKey of engineKeys.slice(0, 2)) {
    candidates.push({
      kind: "monitoring",
      ruleCode: sovRule.code,
      title: sovRule.titleTemplate.replace("{engine}", engineKey),
      description: sovRule.descriptionTemplate.replace("{engine}", engineKey),
      sourceFindingId: null,
      sourceDomainId: null,
      severityHint: null,
      playbookSlug: null,
    });
  }

  // Filler — generic tasks with no derivable severity, so `open_task_count`
  // legitimately exceeds the sum of the severity buckets (STORY-169's own
  // rule: "a task deriving neither counts only in the total").
  const genericKinds: readonly TaskKind[] = ["content", "technical"];
  for (let i = 0; i < 6; i += 1) {
    candidates.push({
      kind: genericKinds[i % genericKinds.length]!,
      ruleCode: null,
      title: `Review ${project.name}'s answer coverage (${String(i + 1)})`,
      description: `Manually review a sample of ${project.name}'s recent answers for accuracy.`,
      sourceFindingId: null,
      sourceDomainId: null,
      severityHint: null,
      playbookSlug: null,
    });
  }

  return candidates;
}

export async function resetAndSeedProjectTasks(
  tx: ClientBase,
  project: DemoProjectRef,
  findings: readonly SeededFinding[],
  domains: readonly SeededSourceDomain[],
  engineKeys: readonly string[],
): Promise<void> {
  await ensureTaskRules(tx);
  await deleteExistingDemoTasks(tx, project.id);

  const rng = rngFor(project.id, "tasks");
  const count = uniformInt(rng, 5, 12);
  const candidates = buildCandidates(project, findings, domains, engineKeys).slice(0, count);
  const prefix = shortRefPrefix(project.name);

  for (const [index, candidate] of candidates.entries()) {
    const id = uuidV7();
    const shortRef = await nextShortRef(tx, project.workspaceId, prefix);
    const impactBase = candidate.severityHint === "critical" ? 75 : candidate.severityHint === "high" ? 55 : 30;
    const impactScore = Math.min(100, impactBase + uniformInt(rng, 0, 25));
    const effortBand =
      candidate.ruleCode !== null
        ? (DEMO_TASK_RULES.find((rule) => rule.code === candidate.ruleCode)?.effortBand ?? pick(rng, EFFORT_BANDS))
        : pick(rng, EFFORT_BANDS);
    const status = chance(rng, 0.2) ? "in_progress" : "todo";
    // `Array.join(":")`, not a colon-joined template literal — see the
    // matching note in `aux.ts`'s own fingerprint construction.
    const fingerprint = sha1(
      [project.id, candidate.ruleCode ?? "generic", candidate.sourceFindingId ?? candidate.sourceDomainId ?? String(index)].join(":"),
    );

    await tx.query(
      `INSERT INTO tasks
         (id, workspace_id, project_id, short_ref, kind, origin, rule_code, dedupe_fingerprint,
          title, description, status, priority, impact_score, effort_band,
          source_finding_id, source_domain_id, playbook_slug, playbook_payload)
       VALUES ($1,$2,$3,$4,$5,'auto',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      [
        id,
        project.workspaceId,
        project.id,
        shortRef,
        candidate.kind,
        candidate.ruleCode,
        fingerprint,
        candidate.title,
        candidate.description,
        status,
        uniformInt(rng, 1, 5),
        impactScore,
        effortBand,
        candidate.sourceFindingId,
        candidate.sourceDomainId,
        candidate.playbookSlug,
        JSON.stringify({ [DEMO_TASK_MARKER_KEY]: DEMO_SEED_MARKER }),
      ],
    );
  }

  await refreshProjectTaskCounts(tx, project.id);
}

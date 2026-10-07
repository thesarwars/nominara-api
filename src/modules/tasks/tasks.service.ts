import { Injectable } from "@nestjs/common";
import type { ActionItem, ActionItemEffort, ActionItemPrimaryActionKind, ActionItemSource } from "../../../contracts/tasks/index.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import { SOURCE_INDEX_ENGINE_KEY, SOURCE_INDEX_WINDOW_DAYS } from "../../lib/rollup/refresh-project-task-counts.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-169 (API step 2/3) — `GET /v1/workspaces/{id}/action-items`. Owns
// `tasks` (coding-standards.md §1 "one table, one owning service") — this
// is why `WorkspacesController` calls IN to this service rather than
// querying `tasks` itself.
@Injectable()
export class TasksService {
  /**
   * The cross-project action queue. api-specification.md §3:
   * "GET /workspaces/{id}/summary · /action-items — project:read /
   * task:read — Command Center matrix; cross-project queue."
   * product-spec.md `FR-GD-02`: "one prioritized queue merging tasks
   * across every readable project, ranked by impact score then severity
   * then age".
   *
   * TWO THINGS DO THE SCOPING, AND ONLY ONE OF THEM IS RLS — the exact shape
   * `ProjectsService.list` documents at length. RLS's `ws_isolation_tasks`
   * (and `..._projects`) scope by `app.current_workspace()`, which is why
   * there is no `workspace_id` predicate below. The PROJECT scope is not
   * RLS's job for `nominara_app` — only `portal_scope_*` binds
   * `nominara_portal` — so a manager or viewer restricted to fewer than
   * every project (FR-DASH-04, ISO-08) is scoped by THIS query, via
   * `app.current_scope_projects()`, copied verbatim from
   * `ProjectsService.list` so the two can never disagree about who is
   * in scope.
   *
   * FIXED (STORY-169 review): this predicate can only narrow rows that
   * reach it, and until `@ScopedByQuery()` existed, NO scoped manager or
   * viewer ever did. `RbacGuard.assertInScope` refuses a "scoped"
   * permission on any route with no `@ProjectParam()` by default —
   * `WorkspacesController.listActionItems`'s URL names a WORKSPACE, not a
   * project, so it has none, and the guard threw `ProjectOutOfScopeException`
   * for EVERY project-scoped manager/viewer, including one scoped to many
   * projects, not zero. `GET /v1/projects` had the identical gap. Both
   * routes now carry `@ScopedByQuery()`, which lets a NON-EMPTY scope
   * through so this predicate is the thing that actually narrows the rows
   * — and still refuses a scope of zero projects outright, because an empty
   * scope never reaches `set_config` (`tenant-context.ts`) and would
   * otherwise read as "unrestricted" here. `rbac.guard.spec.ts`'s "STORY-169
   * review" scenarios and `test/integration/action-items.spec.ts`'s scope
   * tests cover both routes.
   *
   * ORDERING CONFLICT, RESOLVED TOWARD THE REFERENCE (spec-navigation: a
   * reference beats a story). product-spec.md `FR-GD-02` ranks "impact
   * score then severity then age" — impact first. `STORY-089`'s AC reads
   * "impact within severity", i.e. severity first, and the client's own
   * fixture sorts that way too. `ix_tasks_open (workspace_id, impact_score
   * DESC, priority DESC)` is impact-first, which is the tell that FR-GD-02
   * is the intended behaviour and STORY-089's prose is the one that is
   * wrong. This implements FR-GD-02's order; STORY-089 needs a matching
   * fix, carried to the docs repo by hand (no `.git` in the snapshot here).
   *
   * DEDUP IS DEFERRED. FR-GD-02's second sentence — "deduplicated across
   * projects when the same rule code and affected URL recur, collapsing
   * into one row with a project-count badge" — is NOT implemented here.
   * There is no `task.generate` handler yet (STORY-063/064 are Backlog per
   * the story snapshot), so no two real tasks can currently share a rule
   * code and `affected_url` across projects to prove a dedup query against;
   * building it now would be exercised by nothing. Each task is its own row.
   *
   * SEVERITY has no column on `tasks` (`priority` is a 1-5 ranking, not a
   * severity — schemas/tasks-and-goals.md). The only two derivations the
   * spec names are on `tasks` itself: `aux_findings.severity` via
   * `source_finding_id`, and `project_source_index.gap_severity` via
   * `source_domain_id` — the finding taking precedence, and the SAME
   * "current" reading (`engine_key='all'`, `window_days=30`, most recent
   * `window_start`) `refreshProjectTaskCounts` already uses for
   * `projects.open_tasks_by_severity`, imported from there rather than
   * re-declared so the two constants cannot drift apart. A task deriving
   * neither, or whose only signal is `gap_severity = 'none'` ("no gap",
   * not "no data"), gets a null severity.
   *
   * `severity` IS WHITELISTED, not merely `NULLIF(..., 'none')`.
   * `aux_findings.severity`'s own CHECK allows `'info'` (schemas/aux-and-
   * geo-analysis.md — a real, low-priority finding, not a data gap), which
   * `NULLIF(..., 'none')` would pass straight through onto the wire. The
   * contract's `actionItemSeveritySchema` is `critical|high|medium|low` —
   * four members, not five — so an 'info'-severity finding's task would
   * publish a value the enum does not carry, failing every strict client
   * parse of the whole page. The `CASE WHEN ... IN (...)` below only ever
   * emits one of the four contract members or SQL NULL, matching
   * `refreshProjectTaskCounts`'s own `FILTER (WHERE severity = ...)` counts,
   * which already put `'info'` in no bucket the same way.
   */
  async listActionItems(pagination: PaginationRequest): Promise<Page<ActionItem>> {
    const client = currentTenantStore()!.client;
    const after = pagination.cursor === undefined ? undefined : decodeCursor(pagination.cursor, 4);

    const result = await client.query<ActionItemRow>(
      `WITH items AS (
         SELECT
           t.id,
           t.short_ref,
           t.project_id,
           p.name AS project_name,
           p.slug::text AS project_slug,
           COALESCE(af.rule_code, t.rule_code) AS code,
           t.title,
           CASE WHEN COALESCE(af.severity, psi.gap_severity) IN ('critical', 'high', 'medium', 'low')
                THEN COALESCE(af.severity, psi.gap_severity)
           END AS severity,
           CASE COALESCE(af.severity, psi.gap_severity)
             WHEN 'critical' THEN 0
             WHEN 'high'     THEN 1
             WHEN 'medium'   THEN 2
             WHEN 'low'      THEN 3
             ELSE 4
           END AS severity_rank,
           t.kind,
           t.impact_score,
           t.impact_score::text AS impact_key,
           t.effort_band,
           t.playbook_slug,
           t.source_finding_id,
           t.source_domain_id,
           t.source_displacement_id,
           t.created_at,
           t.created_at::text AS created_at_key
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         LEFT JOIN aux_findings af ON af.id = t.source_finding_id
         LEFT JOIN LATERAL (
           SELECT gap_severity
             FROM project_source_index
            WHERE source_domain_id = t.source_domain_id
              AND project_id = t.project_id
              AND engine_key = $1
              AND window_days = $2
            ORDER BY window_start DESC
            LIMIT 1
         ) psi ON t.source_domain_id IS NOT NULL
         WHERE t.status IN ('todo', 'in_progress')
           AND t.deleted_at IS NULL
           AND p.deleted_at IS NULL
           AND (cardinality(app.current_scope_projects()) = 0
                OR p.id = ANY(app.current_scope_projects()))
       )
       SELECT *
         FROM items
        WHERE ($3::real IS NULL
               OR impact_score < $3::real
               OR (impact_score = $3::real AND severity_rank > $4::int)
               OR (impact_score = $3::real AND severity_rank = $4::int AND created_at > $5::timestamptz)
               OR (impact_score = $3::real AND severity_rank = $4::int AND created_at = $5::timestamptz AND id > $6::uuid))
        ORDER BY impact_score DESC, severity_rank ASC, created_at ASC, id ASC
        LIMIT $7`,
      [
        SOURCE_INDEX_ENGINE_KEY,
        SOURCE_INDEX_WINDOW_DAYS,
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        after?.[3] ?? null,
        pagination.limit + 1,
      ],
    );

    return pageFrom(result.rows, pagination.limit, toActionItem, (row) => [
      row.impact_key,
      row.severity_rank,
      row.created_at_key,
      row.id,
    ]);
  }
}

interface ActionItemRow {
  id: string;
  short_ref: string | null;
  project_id: string;
  project_name: string;
  project_slug: string;
  code: string | null;
  title: string;
  severity: string | null;
  severity_rank: number;
  kind: string;
  impact_score: number | null;
  impact_key: string;
  effort_band: string | null;
  playbook_slug: string | null;
  source_finding_id: string | null;
  source_domain_id: string | null;
  source_displacement_id: string | null;
  created_at: Date;
  created_at_key: string;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high", "medium", "low"]);

/**
 * Second, defensive check on top of the SQL whitelist (the `CASE WHEN ...
 * IN (...)` above) — `aux_findings.severity`'s CHECK constraint allows
 * `'info'`, one value outside the contract's four-member enum. Belt and
 * suspenders: an unchecked `row.severity as ActionItem["severity"]` cast
 * would silently start publishing a fifth value again the moment the SQL
 * and this mapper drift, with no compiler or runtime error either side of
 * the wire — exactly the failure mode this whole finding was.
 */
function normalizeSeverity(raw: string | null): ActionItem["severity"] {
  if (raw === null) return null;
  return VALID_SEVERITIES.has(raw) ? (raw as ActionItem["severity"]) : null;
}

const VALID_EFFORT_BANDS: ReadonlySet<string> = new Set(["xs", "s", "m", "l", "xl"]);

/**
 * `tasks.effort_band` carries no CHECK constraint (schemas/tasks-and-
 * goals.md — see refreshProjectTaskCounts's own note on `tasks` columns
 * with no enforcement). A value that is not exactly one of the five bands,
 * once lowercased, is honestly null rather than guessed at or passed
 * through unlowercased.
 */
function normalizeEffort(raw: string | null): ActionItemEffort | null {
  if (raw === null) return null;
  const lowered = raw.toLowerCase();
  return VALID_EFFORT_BANDS.has(lowered) ? (lowered as ActionItemEffort) : null;
}

/** Which evidence table a task traces back to — `tasks.source_*`, aux > source > displacement > content. */
function deriveSource(row: ActionItemRow): ActionItemSource {
  if (row.source_finding_id !== null) return "aux";
  if (row.source_domain_id !== null) return "source";
  if (row.source_displacement_id !== null) return "displacement";
  return "content";
}

/**
 * DOCUMENTED JUDGEMENT CALL — the spec (api-specification.md §3's action-
 * items entry, page-inventory.md's wireframe, FR-GD-02) names the inputs
 * ("source columns / playbook_slug") but not the mapping to the 4-member
 * `primary_action.kind` enum, so this is a design decision, not a spec
 * transcription:
 *
 *   1. `playbook_slug` set           -> `open_playbook`, target the slug.
 *      `source_domains.is_seedable` gates a playbook (sources-and-
 *      rollups.md); source-seeding/authority tasks carry one on `tasks`
 *      directly. Checked FIRST because it is the most concrete next step
 *      available — a guided fix — and a task can carry a playbook alongside
 *      a displacement or a finding id (e.g. an authority task an AUX
 *      finding recommended); the playbook wins when one exists.
 *   2. `source_displacement_id` set  -> `diagnose`, target the displacement.
 *      Matches ui-ux-guidelines.md's own "Diagnose displacement" action and
 *      page-inventory.md's wireframe ("Diagnose →" on a share-of-voice row).
 *      A displacement has no guided fix of its own — diagnosis is the most
 *      concrete action available once there is no playbook to jump to.
 *   3. `source_finding_id` set       -> `copy_patch`, target the finding.
 *      AUX findings carry copy-ready patches (`FR-AX-04`,
 *      `aux_findings.suggested_fix`). This is the one visible mismatch
 *      against page-inventory.md's wireframe, which labels an AUX-R-001
 *      (robots.txt) row "Fix now" — a label this 4-member enum has no exact
 *      match for; `copy_patch` is the nearest of the four.
 *   4. otherwise                     -> `open_task`, target the task itself.
 *      Manual/command_bar-origin tasks, and any task with no more specific
 *      evidence link.
 */
function derivePrimaryAction(row: ActionItemRow): { kind: ActionItemPrimaryActionKind; target: string } {
  if (row.playbook_slug !== null) return { kind: "open_playbook", target: row.playbook_slug };
  if (row.source_displacement_id !== null) return { kind: "diagnose", target: row.source_displacement_id };
  if (row.source_finding_id !== null) return { kind: "copy_patch", target: row.source_finding_id };
  return { kind: "open_task", target: row.id };
}

function toActionItem(row: ActionItemRow): ActionItem {
  return {
    id: row.id,
    short_ref: row.short_ref,
    project_id: row.project_id,
    project_name: row.project_name,
    project_slug: row.project_slug,
    code: row.code,
    title: row.title,
    severity: normalizeSeverity(row.severity),
    source: deriveSource(row),
    kind: row.kind as ActionItem["kind"],
    impact: row.impact_score,
    effort: normalizeEffort(row.effort_band),
    primary_action: derivePrimaryAction(row),
    created_at: row.created_at.toISOString(),
  };
}

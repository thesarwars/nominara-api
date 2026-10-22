import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import type {
  ConfirmDiscoveryRequest,
  ConfirmableField,
  LastScan,
  ProjectListItem,
  CreateProjectRequest,
  CreateProjectResponse,
  DiscoveredField,
  DiscoveryResponse,
  OptionalProjectField,
} from "../../../contracts/projects/index.js";
import { COLUMN_FOR_FIELD, LIST_VALUED_FIELDS } from "../../../contracts/projects/index.js";
import { OPTIONAL_PROJECT_FIELDS } from "../../../contracts/projects/index.js";
import { openTasksBySeveritySchema, visibilityByEngineSchema } from "../../../contracts/projects/index.js";
import { ConflictError, EntitlementExceededError, NotFoundError, UnsafeTargetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { GuardedFetchRefusal } from "../../lib/net/guarded-fetch.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { UnparsableHostError } from "../../lib/net/registrable-domain.js";
import { lockProjectCompetitors } from "./competitor-cap-lock.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { insertPromptStatement, manualPromptRow, type PromptRow } from "../../lib/promptgen/persist.js";
import { assertActiveWithinLimits, lockWorkspaceForActivation } from "../prompts/active-limit.js";
import { afterCommit, currentTenantStore } from "../../tenancy/tenant-context.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import type { PortalProjectEngines } from "../../lib/portal/portal-facts.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { FREE_PROMPT_ALLOWANCE } from "../../lib/discovery/discover.js";
import { handlerFor } from "../../lib/queue/handlers.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { nextRunAfter } from "../../lib/capture/scheduler.js";
import { startingCadenceFor } from "../../lib/capture/starting-cadence.js";
import { confidenceFor, sentimentBand } from "../../lib/scoring/index.js";

// STORY-043 — URL-only project creation. api-specification.md §4.
//
// THE ORDER IN `create` IS THE STORY. AC8: "the project row is inserted, and
// the prompt cap resolved from entitlements, BEFORE the crawl is enqueued".
// The reverse — crawl, then insert — makes the customer wait on a network
// fetch of a site we do not control, and a slow site becomes a failed signup.
// Inserting first makes discovery an enrichment that can fail without costing
// the activation, which is what AC9's "renderable the moment the request
// returns" means in practice.
//
// The enqueue is also deliberately AFTER COMMIT. Enqueueing inside the
// transaction races the worker: BullMQ hands the job to a consumer the instant
// it lands, and that consumer opens its OWN connection — so it can select the
// project row before this transaction commits and see nothing, then fail a job
// that should have succeeded. afterCommit() exists for exactly this.

const DISCOVERY_EXPECTED_MS = 20_000;

// The matrix row's columns. Shared by `list` and `listForSummary` so the two
// readers of the denormalised columns cannot drift apart.
// STORY-175 AC1 - the project's latest capture run, in the SAME statement as the rows (no per-project
// query). `ix_runs_ws_project_time (workspace_id, project_id, created_at DESC)` serves the LIMIT 1 per
// project, so no new index. Only `ls_`-prefixed columns leave the subquery, so the list query's unqualified
// `id` / `status` / `created_at` still mean the project's. There is deliberately no workspace predicate
// (STORY-132 scenario 4): RLS scopes capture_runs to the caller's workspace, so a run stamped with another
// workspace never joins, even one cross-wired onto this workspace's project.
//
// `rolled_up` is derived from bookkeeping that already exists, with no new column: `rollUpDay` upserts the
// project's cross-engine brand row in `metric_daily` (engine_key 'all', entity_type 'brand') with
// `computed_at = now()`, and `denormalizeProject` rewrites the card's block in the SAME transaction. So a
// row computed at or after the run's `finished_at` means the block reflects this run; a rollup that ran
// earlier (the scheduled day pass) predates it. A run still in flight has nothing to be reflected yet,
// and a terminal run that captured nothing requests no rollup - it has nothing to wait for.
const LAST_SCAN_JOIN = `LEFT JOIN LATERAL (
           SELECT r.id AS ls_run_id, r.status AS ls_status, r.trigger AS ls_trigger,
                  r.planned_cells AS ls_planned_cells, r.skipped_cells AS ls_skipped_cells,
                  r.captured_cells AS ls_captured_cells, r.failed_cells AS ls_failed_cells,
                  r.started_at AS ls_started_at, r.finished_at AS ls_finished_at,
                  CASE
                    WHEN r.status IN ('queued', 'running') THEN false
                    WHEN r.captured_cells = 0 THEN true
                    ELSE EXISTS (SELECT 1 FROM metric_daily md
                                  WHERE md.project_id = r.project_id
                                    AND md.engine_key = 'all' AND md.entity_type = 'brand'
                                    AND md.computed_at >= r.finished_at)
                  END AS ls_rolled_up
             FROM capture_runs r
            WHERE r.project_id = projects.id
            ORDER BY r.created_at DESC
            LIMIT 1
         ) ls ON true`;

const PROJECT_LIST_SELECT = `SELECT id, name, slug::text AS slug, root_domain, kind, status, paused_by_downgrade_at, discovery_status,
              prompts_active, prompts_cap, open_task_count, open_tasks_by_severity,
              domain_verified_at, created_at,
              visibility_blended, visibility_delta_30d, rendering_quality, rendering_delta_30d,
              source_coverage, aux_score_current, sentiment_score, sentiment_delta_30d, cells_30d,
              visibility_by_engine, sparkline_30d, demo_seeded_at,
              ls.ls_run_id, ls.ls_status, ls.ls_trigger, ls.ls_planned_cells, ls.ls_skipped_cells,
              ls.ls_captured_cells, ls.ls_failed_cells, ls.ls_started_at, ls.ls_finished_at, ls.ls_rolled_up,
              created_at::text AS created_at_key
         FROM projects
         ${LAST_SCAN_JOIN}`;

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly queues: QueueProducer,
    private readonly entitlements: EntitlementResolver,
    private readonly urls: UrlGuard,
  ) {}

  async create(
    workspaceId: string,
    actorId: string,
    input: CreateProjectRequest,
    entitlementVersion: number | undefined,
  ): Promise<CreateProjectResponse> {
    const client = currentTenantStore()!.client;

    // AC7 — the guarded fetcher's validation, before anything is written. This
    // resolves DNS but opens no socket: the crawl itself is the queue
    // handler's job, never the request path's (NFR-ARCH-01).
    let rootDomain: string;
    try {
      ({ rootDomain } = await this.urls.validateAndNormalize(input.root_url));
    } catch (error) {
      if (error instanceof GuardedFetchRefusal) {
        throw new UnsafeTargetError({ message: "this URL cannot be fetched", details: { reason: error.reason } });
      }
      if (error instanceof UnparsableHostError) {
        throw new ValidationFailedError({
          message: "root_url has no registrable domain",
          details: { issues: [{ path: ["root_url"], message: "not a domain anyone can own" }] },
        });
      }
      throw error;
    }

    const resolved =
      entitlementVersion === undefined
        ? await this.entitlements.resolveForWorkspace(workspaceId)
        : await this.entitlements.resolve(workspaceId, entitlementVersion);

    const promptsCap = resolveCap(resolved.entitlements["prompts.max_per_project"]?.value);
    const competitorsCap = resolveCap(resolved.entitlements["competitors.max_per_project"]?.value);

    // AC5 — "exceeding a cap refuses the whole request and creates no
    // project". Checked BEFORE the insert, not after, so there is nothing to
    // roll back and no window in which a half-created project is visible to a
    // concurrent read.
    assertWithinCap("prompts.max_per_project", input.prompts?.length ?? 0, promptsCap);
    assertWithinCap("competitors.max_per_project", input.competitors?.length ?? 0, competitorsCap);

    if (input.kind === "product_line") {
      await assertParentExists(client, input.parent_project_id!);
    }

    // Owner decision 2026-10-09 pm #2: the starting cadence is the plan's
    // scan.cadence entitlement (cadence is still not accepted at creation,
    // STORY-043 AC2), mapped onto what projects.cadence allows.
    const startingCadence = startingCadenceFor(resolved.entitlements["scan.cadence"]?.value);

    const projectId = uuidV7();

    // STORY-077 review round 4 — SUPPLIED PROMPTS ARE INSERTED `active`, so a creation that carries them is a door into
    // `active` and is held to the rule a resume is (active-limit.ts): after a cut-over that paused prompts for
    // `prompts.max_total`, a new project's prompts would otherwise put the workspace back above its plan. Counted after
    // the same hash dedupe the insert applies, so a repeated prompt is not refused for a slot it never takes. The
    // workspace lock is taken first, as on every other door, and only when there is something to count: a creation
    // without prompts waits on nothing.
    const supplied = distinctSuppliedPrompts(workspaceId, projectId, input);
    if (supplied.length > 0) {
      await lockWorkspaceForActivation(client as ClientBase, workspaceId);
      await assertActiveWithinLimits(client, { workspaceId, projectId, becomingActive: supplied.length, entitlements: resolved.entitlements });
    }

    const slug = await nextFreeSlug(client, rootDomain);
    await client.query(
      `INSERT INTO projects
         (id, workspace_id, name, slug, kind, parent_project_id, root_url, root_domain,
          owned_domains, brand_aliases, negative_aliases, category_slug, verticals, locale,
          description, prompts_cap, discovery_status, status, created_by, cadence, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending','initializing',$17,$18,$19)`,
      [
        projectId,
        workspaceId,
        // Named from the discovered brand name when omitted (§4.1). Until
        // discovery runs, the domain is the only honest placeholder — a blank
        // name would render as an empty row in the sidebar.
        input.name ?? rootDomain,
        slug,
        input.kind ?? "brand",
        input.parent_project_id ?? null,
        input.root_url,
        rootDomain,
        input.owned_domains ?? [],
        input.brand_aliases ?? [],
        input.negative_aliases ?? [],
        input.category_slug ?? null,
        input.verticals ?? [],
        input.locale ?? "en-US",
        input.description ?? null,
        promptsCap,
        actorId,
        startingCadence,
        // Owner decision 2026-10-09 #2: a non-manual cadence seeds next_run_at
        // with the NEXT cadence slot (never "now"), so the sweep has something
        // to claim once the project is active. `manual` would store NULL.
        nextRunAfter(startingCadence, new Date()),
      ],
    ).catch((error: unknown) => {
      // `nextFreeSlug` picked a free one a moment ago, so reaching here means
      // a CONCURRENT create took it in between. The unique index is the real
      // guarantee and this is the honest report of it — a 409 the caller can
      // retry, rather than the 500 this used to be.
      if (isUniqueViolation(error, "ux_projects_ws_slug")) {
        // `current_state` is the only key §2 gives a conflict's details, and
        // widening the schema to carry a prettier shape would be changing the
        // contract to suit one call site.
        throw new ConflictError({
          message: "a project for this domain was just created — try again",
          details: { current_state: `slug_taken:${slug}` },
        });
      }
      throw error;
    });

    await this.insertSuppliedSeeds(client, workspaceId, projectId, input, supplied);

    const fieldsSupplied = suppliedFields(input);

    // AC8's second half. Deferred past COMMIT — see the header comment.
    afterCommit(() => {
      void this.queues
        .enqueueTenantJob("crawl.discover", workspaceId, { projectId, rootUrl: input.root_url, fieldsSupplied }, {
          // topology.ts's own pattern for this queue: `disc:{project}`. One
          // discovery per project, so a retried creation cannot start a second.
          idempotencyKey: `disc:${projectId}`,
        })
        .catch((error: unknown) => {
          // The project EXISTS and is usable; only its enrichment failed to
          // start. Failing the response here would tell the customer their
          // creation failed when it did not, and they would create a second.
          this.logger.error(`failed to enqueue discovery for project ${projectId}: ${String(error)}`);
        });
    });

    return {
      project_id: projectId,
      root_url: input.root_url,
      root_domain: rootDomain,
      status: "initializing",
      discovery_status: "pending",
      prompts_cap: promptsCap,
      fields_supplied: fieldsSupplied,
      poll: { discovery: `/v1/projects/${projectId}/discovery`, expected_ms: DISCOVERY_EXPECTED_MS },
    };
  }

  /**
   * `GET /v1/projects` — the workspace matrix. STORY-132.
   *
   * TWO THINGS DO THE SCOPING, AND ONLY ONE OF THEM IS RLS.
   *
   * The tenant boundary is RLS's: `ws_isolation_projects` filters by
   * `app.current_workspace()`, which is why there is no `workspace_id`
   * predicate below (NFR-SEC-01 — a filter in application SQL implies the
   * boundary lives there).
   *
   * The PROJECT scope is not. For `nominara_app` the only policy on this
   * table is that workspace one; `portal_scope_projects` binds
   * `nominara_portal` alone. So an analyst restricted to two of five projects
   * is NOT restricted by RLS here, and the query has to do it. STORY-089 is
   * explicit that this is a tenancy assertion rather than a filter: counts
   * that include out-of-scope projects leak the existence of work the caller
   * may not know about, often a competitor managed by the same agency.
   *
   * `app.current_scope_projects()` is read in SQL rather than threaded from
   * the request, because it is the same source the portal policy reads and a
   * second copy of the tenant's scope can disagree with the first. An empty
   * array means UNSCOPED, which is safe because tenant-context.ts sets the
   * GUC only when the member's scope is non-empty — a scoped member always
   * has one. Worth saying out loud: the expression reads fail-open at a
   * glance and is not.
   */
  async list(pagination: PaginationRequest): Promise<Page<ProjectListItem>> {
    const client = currentTenantStore()!.client;
    const after = pagination.cursor === undefined ? undefined : decodeCursor(pagination.cursor, "projects.projects", 2);

    const result = await client.query<ProjectRow>(
      `${PROJECT_LIST_SELECT}
        WHERE deleted_at IS NULL
          AND (cardinality(app.current_scope_projects()) = 0
               OR id = ANY(app.current_scope_projects()))
          AND ($1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid))
        ORDER BY created_at ASC, id ASC
        LIMIT $3`,
      [after?.[0] ?? null, after?.[1] ?? null, pagination.limit + 1],
    );

    recordLastScanStates(result.rows.slice(0, pagination.limit));
    return pageFrom(result.rows, pagination.limit, "projects.projects", toProjectListItem, (row) => [row.created_at_key, row.id]);
  }

  /** NEW-E-099a — display names for a set of project ids, on the ambient transaction (RLS and the portal scope narrow it). */
  async namesFor(ids: readonly string[]): Promise<Map<string, string>> {
    const client = currentTenantStore()!.client;
    const result = await client.query<{ id: string; name: string }>("SELECT id, name FROM projects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [ids]);
    return new Map(result.rows.map((row) => [row.id, row.name]));
  }

  /**
   * NEW-E-099a — the engine rows a portal read needs per project: the entitled, enabled rows of
   * `project_entitled_engines` and the `project_engines` overrides. Read on the APP pool, because `nominara_portal` has
   * no grant on the view and no policy on the override table; the portal interceptor hands them to the services as data.
   */
  async portalEngines(ids: readonly string[]): Promise<Map<string, PortalProjectEngines>> {
    const client = currentTenantStore()!.client;
    const [entitled, overrides] = await Promise.all([
      client.query<{ project_id: string; engine_key: string; display_name: string | null; runs_per_cycle: number | null; weight: string }>(
        `SELECT project_id, engine_key, display_name, (cadence ->> 'full')::int AS runs_per_cycle, weight::text AS weight
           FROM project_entitled_engines WHERE project_id = ANY($1::uuid[]) AND enabled = true ORDER BY engine_key`,
        [ids],
      ),
      client.query<{ project_id: string; engine_key: string; weight: string }>(
        "SELECT project_id, engine_key, weight::text AS weight FROM project_engines WHERE project_id = ANY($1::uuid[]) ORDER BY engine_key",
        [ids],
      ),
    ]);
    const out = new Map<string, { entitled: PortalProjectEngines["entitled"][number][]; overrides: PortalProjectEngines["overrides"][number][] }>();
    const slot = (id: string) => out.get(id) ?? out.set(id, { entitled: [], overrides: [] }).get(id)!;
    for (const row of entitled.rows) slot(row.project_id).entitled.push({ engine_key: row.engine_key, display_name: row.display_name, runs_per_cycle: row.runs_per_cycle, weight: row.weight });
    for (const row of overrides.rows) slot(row.project_id).overrides.push({ engine_key: row.engine_key, weight: row.weight });
    return out;
  }

  /**
   * NEW-B-2 — the Command Center's matrix, whole, for `GET /workspaces/{id}/
   * summary`. FR-DASH-01: one request, no per-project query — this is TWO
   * statements however many projects there are.
   *
   * Scoped exactly as `list` is (see its comment): RLS gives the workspace,
   * `app.current_scope_projects()` gives the project scope, and the second
   * statement re-uses the SAME scoped set so the engine filter cannot name an
   * engine only an out-of-scope project is entitled to. Not paginated — the
   * matrix is bounded by the plan's `projects.max`.
   */
  async listForSummary(): Promise<{ projects: ProjectListItem[]; engineKeys: string[] }> {
    const client = currentTenantStore()!.client;

    const result = await client.query<ProjectRow>(
      `${PROJECT_LIST_SELECT}
        WHERE deleted_at IS NULL
          AND (cardinality(app.current_scope_projects()) = 0
               OR id = ANY(app.current_scope_projects()))
        ORDER BY created_at ASC, id ASC`,
    );

    // The entitled set is DERIVED (STORY-152), never stored. `enabled` honours
    // a project's own narrowing; the view is security_invoker, so RLS applies.
    const engines = await client.query<{ engine_key: string }>(
      `SELECT DISTINCT engine_key
         FROM project_entitled_engines
        WHERE enabled
          AND (cardinality(app.current_scope_projects()) = 0
               OR project_id = ANY(app.current_scope_projects()))
        ORDER BY engine_key`,
    );

    recordLastScanStates(result.rows);
    return { projects: result.rows.map(toProjectListItem), engineKeys: engines.rows.map((row) => row.engine_key) };
  }

  /**
   * `GET /v1/projects/{id}/discovery` — api-specification.md §4.5.
   *
   * Scenario 2: readable the moment creation returns, and BEFORE discovery
   * finishes. Until the handler writes anything, `projects.discovery` is its
   * `{}` default and `discovery_status` is `pending` — so this synthesises the
   * empty-but-honest payload rather than 404ing. A 404 here would be wrong
   * twice over: the project exists, and the client is polling exactly because
   * it expects the answer to arrive later.
   */
  async discoveryFor(projectId: string): Promise<DiscoveryResponse> {
    const client = currentTenantStore()!.client;
    const result = await client.query<{ discovery: unknown; discovery_status: string }>(
      "SELECT discovery, discovery_status FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [projectId],
    );
    // No workspace predicate: RLS scopes the transaction, so another tenant's
    // project is simply not here (NFR-SEC-01).
    if (result.rows.length === 0) throw new NotFoundError({ message: "no such project" });

    const row = result.rows[0]!;
    const stored = row.discovery;
    // A written payload carries its own status; an unwritten one is the `{}`
    // default and takes the column's.
    if (isDiscoveryPayload(stored)) return stored;

    return emptyDiscovery(row.discovery_status as DiscoveryResponse["discovery_status"]);
  }

  /**
   * `POST /v1/projects/{id}/discovery/confirm` — STORY-044.
   *
   * THE `user_edited` FLAG IS THE DURABLE PART OF THIS STORY. Without it a
   * re-discovery — a re-crawl, a schema change on the customer's site, a
   * manual refresh — silently reverts the customer's correction and they have
   * no way to tell it happened. Recording the human decision makes discovery
   * permanently deferential to it (AC4, scenario 5).
   *
   * Idempotent by construction (AC7): every write is an assignment, not an
   * increment or an append, so confirming twice lands the same state. The
   * competitor insert is the one exception and is deduped explicitly.
   */
  async confirmDiscovery(
    workspaceId: string,
    projectId: string,
    input: ConfirmDiscoveryRequest,
    entitlementVersion: number | undefined,
  ): Promise<DiscoveryResponse> {
    const client = currentTenantStore()!.client;

    const existing = await client.query<{ discovery: unknown; category_slug: string | null }>(
      "SELECT discovery, category_slug FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [projectId],
    );
    if (existing.rows.length === 0) throw new NotFoundError({ message: "no such project" });

    const stored = existing.rows[0]!.discovery;
    const payload: DiscoveryResponse = isDiscoveryPayload(stored) ? stored : emptyDiscovery("pending");
    const fields: Record<string, DiscoveredField> = { ...payload.fields };

    const assignments: string[] = [];
    const params: unknown[] = [projectId];
    let categoryChanged = false;

    for (const [name, decision] of Object.entries(input.fields ?? {})) {
      const field = name as ConfirmableField;
      const discovered = fields[field];

      // Accepting a field nothing discovered has no value to apply. Refused
      // rather than ignored: a client that thinks it accepted something should
      // hear that it did not.
      if (decision.decision === "accept" && discovered === undefined) {
        throw new ValidationFailedError({
          message: `nothing was discovered for ${field}`,
          details: { issues: [{ path: ["fields", field], message: "no discovered value to accept" }] },
        });
      }

      const value = decision.decision === "accept" ? discovered!.value : decision.value;
      assertShape(field, value);

      assignments.push(`${COLUMN_FOR_FIELD[field]} = $${String(params.length + 1)}`);
      params.push(value);

      if (field === "category" && value !== existing.rows[0]!.category_slug) categoryChanged = true;

      // AC3/AC4 — accepting records that it was applied; overriding also
      // records that a HUMAN decided, which is what re-discovery reads.
      fields[field] = {
        value,
        confidence: decision.decision === "override" ? 1 : (discovered?.confidence ?? 1),
        ...(discovered?.source !== undefined ? { source: discovered.source } : {}),
        user_edited: decision.decision === "override",
      };
    }

    if (input.competitors !== undefined) {
      await this.confirmCompetitors(client, workspaceId, projectId, input.competitors, entitlementVersion);
    }

    const nextPayload: DiscoveryResponse = {
      ...payload,
      fields,
      // A confirmed field is no longer awaiting confirmation, however
      // uncertain the machine was about it.
      low_confidence_fields: payload.low_confidence_fields.filter((name) => !(name in (input.fields ?? {}))),
    };

    assignments.push(`discovery = $${String(params.length + 1)}`);
    params.push(JSON.stringify(nextPayload));

    await client.query(
      `UPDATE projects SET ${assignments.join(", ")}, updated_at = now() WHERE id = $1`,
      params,
    );

    // AC9 — overriding the category must not leave everything derived from it
    // stale. `rollup.metric_daily` is the job that recomputes it.
    if (categoryChanged) this.requestRecompute(workspaceId, projectId);

    return nextPayload;
  }

  /**
   * AC5 — "confirming competitors creates the tracked rows up to the
   * entitlement, refusing beyond it with the structural-limit failure".
   *
   * The cap is checked against the count AFTER this confirmation, including
   * rows already present, so confirming five twice cannot creep past a cap of
   * five.
   */
  private async confirmCompetitors(
    client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { name: string }[] }> },
    workspaceId: string,
    projectId: string,
    competitors: NonNullable<ConfirmDiscoveryRequest["competitors"]>,
    entitlementVersion: number | undefined,
  ): Promise<void> {
    // Serialise with `CompetitorTrackingService.track` BEFORE counting.
    await lockProjectCompetitors(client, projectId);

    const resolved =
      entitlementVersion === undefined
        ? await this.entitlements.resolveForWorkspace(workspaceId)
        : await this.entitlements.resolve(workspaceId, entitlementVersion);
    const cap = resolveCap(resolved.entitlements["competitors.max_per_project"]?.value);

    const existing = await client.query(
      "SELECT name FROM competitors WHERE project_id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
      [projectId, workspaceId],
    );
    const present = new Set(existing.rows.map((row) => row.name.toLowerCase()));
    // AC7 — re-confirming a competitor already tracked is a no-op, not a
    // duplicate row and not a cap violation.
    const toInsert = competitors.filter((c) => !present.has(c.name.toLowerCase()));

    assertWithinCap("competitors.max_per_project", present.size + toInsert.length, cap);

    for (const competitor of toInsert) {
      await client.query(
        `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
         VALUES ($1,$2,$3,$4,$5,$6,'user')`,
        [uuidV7(), workspaceId, projectId, competitor.name, competitor.root_domain ?? null, competitor.aliases ?? []],
      );
    }
  }

  /**
   * Asks for the category-relative rollups to be recomputed.
   *
   * Guarded on the queue actually having a handler. `rollup.metric_daily` is
   * still inert (STORY-124's registry lists it among the unwired), and
   * enqueueing into a queue nothing consumes would pile jobs into Redis for
   * as long as it stays that way. Checking `handlerFor` means this starts
   * working the day that handler lands, with no edit here — and says out loud,
   * in the log, that the recomputation was skipped rather than silently
   * dropping the requirement.
   */
  private requestRecompute(workspaceId: string, projectId: string): void {
    if (handlerFor("rollup.metric_daily") === undefined) {
      this.logger.warn(
        `project ${projectId}: category changed but rollup.metric_daily has no handler yet — ` +
          "category-relative values will be correct from the first rollup after it is wired (STORY-044 AC9)",
      );
      return;
    }
    afterCommit(() => {
      void this.queues
        .enqueueTenantJob("rollup.metric_daily", workspaceId, { projectId, reason: "category_override" }, {
          idempotencyKey: `rollup:${projectId}:category-override`,
        })
        .catch((error: unknown) => {
          this.logger.error(`failed to enqueue recompute for project ${projectId}: ${String(error)}`);
        });
    });
  }

  /**
   * AC5 — supplied competitors are user-authored, supplied prompts `manual`,
   * and neither charges anything. There is no wallet call anywhere in this
   * method, which is what makes scenario 15's "wallet unchanged" true by
   * construction rather than by a test that happens to pass.
   *
   * *** BOTH INSERTS HERE HAVE NOW SHIPPED BROKEN, FOR THE SAME REASON. ***
   *
   * The prompts one omitted three NOT NULL columns (fixed with STORY-045).
   * The competitors one named a column that does not exist — `origin`, where
   * the table has `source` — and a value its CHECK forbids: `'user_authored'`
   * against `CHECK (source IN ('user','auto_detected'))`. So supplying ANY
   * competitor at creation answered 500 with `column "origin" of relation
   * "competitors" does not exist`, from the day it shipped, on the onboarding
   * step that offers "Up to 10".
   *
   * `user_authored` came from AC5's prose. `schemas/projects-and-prompts.md`
   * is the authority on a table and says `'user'` — a schema beats prose
   * about a table, and this is what that rule is for.
   *
   * WHY NEITHER SUITE CAUGHT EITHER. The unit test asserts
   * `c.sql.includes("user_authored")` against a STUBBED client: a statement
   * that can never execute satisfies a substring check perfectly, and the
   * substring it checked for was itself the bug. The integration test writes
   * its own correct insert rather than calling this method. Both statements
   * are now executed against real migrations by
   * `test/integration/project-seeds.spec.ts`, and the assertions here check
   * bound PARAMETERS rather than SQL text.
   */
  private async insertSuppliedSeeds(
    client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    workspaceId: string,
    projectId: string,
    input: CreateProjectRequest,
    prompts: readonly PromptRow[],
  ): Promise<void> {
    // DEDUPED BY LOWERCASED NAME FIRST, for the reason the prompts loop below
    // records about hashes: `ux_competitors_project_name` is unique on
    // `(project_id, lower(name))`, so "Google" and "google" in the same
    // submission would collide and fail the whole creation.
    const seenCompetitors = new Set<string>();
    for (const competitor of input.competitors ?? []) {
      const key = competitor.name.toLowerCase();
      if (seenCompetitors.has(key)) continue;
      seenCompetitors.add(key);
      await client.query(
        `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [uuidV7(), workspaceId, projectId, competitor.name, competitor.root_domain ?? null, competitor.aliases ?? [], "user"],
      );
    }
    // *** THIS LOOP COULD NOT RUN BEFORE STORY-045. ***
    //
    // The statement here supplied `text`, `generation_source` and `status`
    // and nothing else, while `tracked_prompts` has three more NOT NULL
    // columns with no default — `text_hash`, `intent_archetype`,
    // `funnel_stage`. So `POST /v1/projects` with any `prompts` in the body
    // answered 500 on `null value in column "text_hash" violates not-null
    // constraint`, from the day it shipped, reachable from onboarding's
    // project step.
    //
    // Two suites covered it and neither could catch it: this file's own unit
    // test asserts the SQL STRING contains `'manual'` against a stubbed
    // client, and the integration test writes its own correct insert rather
    // than calling this method. A statement that can never execute satisfies
    // both. `test/integration/promptgen-persist.spec.ts` now EXECUTES it.
    //
    // The row is built by src/lib/promptgen/persist.ts, which is the single
    // place that knows the column set — so the generation path and this one
    // cannot drift, and neither can omit a column again.
    //
    // DEDUPED BY HASH FIRST. `ux_prompts_project_hash` is unique on
    // (project_id, text_hash), so two supplied prompts differing only in
    // casing or spacing would collide and fail the whole creation. The
    // project is brand new here, so there is nothing else to collide with and
    // an in-memory dedupe is complete — no ON CONFLICT needed.
    // (`prompts` is that deduped list: `distinctSuppliedPrompts`, computed once so the active-cap check counts exactly
    // the rows inserted here.)
    for (const row of prompts) {
      const { sql, params } = insertPromptStatement(row);
      await client.query(sql, [...params]);
    }
  }
}

/** The supplied prompts as rows, DEDUPED BY HASH (see `insertSuppliedSeeds`): the rows a creation inserts, in order. */
function distinctSuppliedPrompts(workspaceId: string, projectId: string, input: CreateProjectRequest): PromptRow[] {
  const seen = new Set<string>();
  const rows: PromptRow[] = [];
  for (const prompt of input.prompts ?? []) {
    const row = manualPromptRow({ workspaceId, projectId, text: prompt.text });
    const key = row.textHash.toString("hex");
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/** The lateral join's columns (LAST_SCAN_JOIN); every one is null when the project has no run. */
export interface LastScanRow {
  ls_run_id: string | null;
  ls_status: string | null;
  ls_trigger: string | null;
  ls_planned_cells: number | null;
  ls_skipped_cells: number | null;
  ls_captured_cells: number | null;
  ls_failed_cells: number | null;
  ls_started_at: Date | null;
  ls_finished_at: Date | null;
  ls_rolled_up: boolean | null;
}

/** STORY-175 - one count per row served, by the latest run's status ("none" = never scanned). Counts only: no IDs, no names. */
function recordLastScanStates(rows: readonly LastScanRow[]): void {
  for (const row of rows) incrementCounter("nominara_projects_last_scan_rows_total", { state: row.ls_status ?? "none" });
}

/** STORY-175 AC1 - `null` when the project has no capture run; otherwise the run's progress. */
export function toLastScan(row: LastScanRow): LastScan | null {
  if (row.ls_run_id === null) return null;
  const captured = row.ls_captured_cells ?? 0;
  return {
    run_id: row.ls_run_id,
    status: row.ls_status as LastScan["status"],
    trigger: row.ls_trigger as LastScan["trigger"],
    planned_cells: row.ls_planned_cells ?? 0,
    settled_cells: captured + (row.ls_failed_cells ?? 0) + (row.ls_skipped_cells ?? 0),
    captured_cells: captured,
    started_at: row.ls_started_at?.toISOString() ?? null,
    completed_at: row.ls_finished_at?.toISOString() ?? null,
    rolled_up: row.ls_rolled_up ?? false,
  };
}

interface ProjectRow extends LastScanRow {
  id: string;
  name: string;
  slug: string;
  root_domain: string;
  kind: string;
  status: string;
  /** STORY-077 — set when a downgrade's cut-over paused this project. */
  paused_by_downgrade_at: Date | null;
  discovery_status: string;
  prompts_active: number;
  prompts_cap: number;
  open_task_count: number;
  /**
   * STORY-169 review — `unknown`, not a hand-written interface: this is a
   * jsonb column, and `coding-standards.md` requires a zod schema for every
   * one, parsed at read time (`toProjectListItem` does, via
   * `openTasksBySeveritySchema` — the SAME schema the wire contract already
   * declares, since the stored and wire shapes are identical here).
   */
  open_tasks_by_severity: unknown;
  domain_verified_at: Date | null;
  created_at: Date;
  visibility_blended: string | null;
  visibility_delta_30d: string | null;
  rendering_quality: string | null;
  rendering_delta_30d: string | null;
  source_coverage: string | null;
  aux_score_current: string | null;
  sentiment_score: string | null;
  sentiment_delta_30d: string | null;
  cells_30d: number | null;
  /** STORY-169 review — jsonb; parsed via `visibilityByEngineSchema` (its STORED shape, `toEngineScores` converts to the wire's sorted array). */
  visibility_by_engine: unknown;
  sparkline_30d: unknown;
  demo_seeded_at: Date | null;
  created_at_key: string;
}

/**
 * `numeric` arrives from pg as a STRING, not a number — the driver refuses to
 * narrow it because a numeric can exceed what a double represents exactly.
 * Parsing here rather than letting it reach the wire as `"88.200"`, which the
 * response schema would reject and a client would render verbatim.
 *
 * Null stays null. A project with no rollup has no score, which is not a score
 * of zero.
 */
function numericOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toProjectListItem(row: ProjectRow): ProjectListItem {
  const sentimentScore = numericOrNull(row.sentiment_score);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    root_domain: row.root_domain,
    kind: row.kind as ProjectListItem["kind"],
    status: row.status,
    paused_by_downgrade_at: row.paused_by_downgrade_at?.toISOString() ?? null,
    discovery_status: row.discovery_status as ProjectListItem["discovery_status"],
    prompts_active: row.prompts_active,
    prompts_cap: row.prompts_cap,
    open_task_count: row.open_task_count,
    open_tasks_by_severity: openTasksBySeveritySchema.parse(row.open_tasks_by_severity),
    domain_verified_at: row.domain_verified_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    visibility_blended: numericOrNull(row.visibility_blended),
    visibility_delta_30d: numericOrNull(row.visibility_delta_30d),
    rendering_quality: numericOrNull(row.rendering_quality),
    rendering_delta_30d: numericOrNull(row.rendering_delta_30d),
    source_coverage: numericOrNull(row.source_coverage),
    aux_score_current: numericOrNull(row.aux_score_current),
    sentiment_score: sentimentScore,
    sentiment_delta_30d: numericOrNull(row.sentiment_delta_30d),
    // Read-time classification, not stored: the band is a rendering of the
    // score, and storing it would let the two disagree after a rounding
    // change. Null exactly when the score itself is — never "positive" for
    // no data, matching how the score's own null already refuses 50.
    sentiment_band: sentimentBand(sentimentScore),
    // Read-time, from the cell count denormalizeProject already wrote — no
    // second query over metric_daily. Null when cells_30d is null: nothing
    // has been measured at all, which is a different fact from "low".
    confidence: row.cells_30d === null ? null : confidenceFor(row.cells_30d),
    engine_scores: toEngineScores(row.visibility_by_engine),
    sparkline_30d: row.sparkline_30d ?? null,
    demo_seeded: row.demo_seeded_at !== null,
    last_scan: toLastScan(row),
  };
}

/**
 * `projects.visibility_by_engine`'s stored object, as the sorted array the
 * wire contract wants. Parses through `visibilityByEngineSchema` FIRST
 * (STORY-169 review — a jsonb column read with no runtime check at all
 * before this) — `null` is the honest "no per-engine data" case and is
 * never itself a validation failure.
 */
function toEngineScores(byEngine: unknown): ProjectListItem["engine_scores"] {
  if (byEngine === null) return null;
  const parsed = visibilityByEngineSchema.parse(byEngine);
  return Object.entries(parsed)
    .map(([engineKey, value]) => ({ engine_key: engineKey, score: value.score, delta_30d: value.delta_30d }))
    .sort((a, b) => b.score - a.score);
}

/** The honest empty payload for a project whose discovery has written nothing yet. */
function emptyDiscovery(status: DiscoveryResponse["discovery_status"]): DiscoveryResponse {
  return {
    discovery_status: status,
    duration_ms: null,
    fields: {},
    competitors_proposed: [],
    prompts_generated: [],
    prompts_free_remaining: FREE_PROMPT_ALLOWANCE,
    credits_charged: 0,
    low_confidence_fields: [],
  };
}

/**
 * A list-valued field must be given a list, and a scalar one a string.
 *
 * The request schema accepts either shape for any field, because a union
 * keyed on the field NAME would need one branch per field and would drift
 * from CONFIRMABLE_FIELDS the moment one was added. The pairing is checked
 * here instead, against the same list the columns are derived from.
 */
function assertShape(field: ConfirmableField, value: unknown): void {
  const wantsList = LIST_VALUED_FIELDS.includes(field);
  if (wantsList !== Array.isArray(value)) {
    throw new ValidationFailedError({
      message: `${field} takes ${wantsList ? "a list of strings" : "a string"}`,
      details: { issues: [{ path: ["fields", field, "value"], message: wantsList ? "expected an array" : "expected a string" }] },
    });
  }
}

/**
 * A workspace-unique slug for this domain.
 *
 * `ux_projects_ws_slug` is UNIQUE on (workspace_id, slug) where not deleted,
 * and the slug was the bare registrable domain — so a SECOND project on the
 * same site collided and the request answered 500 from a raw Postgres 23505,
 * after the row had already been attempted. Two projects on one domain is not
 * a mistake: `kind='product_line'` exists precisely so a brand and its product
 * lines can share a site (§4.1), and they necessarily share a root_domain.
 *
 * Suffixes rather than refuses, because the caller supplied no slug and has
 * nothing to correct — the field is server-derived by design.
 *
 * No workspace predicate: RLS scopes the read (NFR-SEC-01), and the index it
 * has to agree with is per-workspace for the same reason.
 */
async function nextFreeSlug(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { slug: string }[] }> },
  base: string,
): Promise<string> {
  const taken = await client.query(
    "SELECT slug FROM projects WHERE deleted_at IS NULL AND (slug = $1 OR slug LIKE $2)",
    [base, `${base}-%`],
  );
  const used = new Set(taken.rows.map((row) => row.slug));
  if (!used.has(base)) return base;
  // Bounded: a workspace with 999 projects on one domain has a different
  // problem, and an unbounded loop here would be a denial-of-service on
  // ourselves rather than a feature.
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new ConflictError({
    message: "too many projects already use this domain",
    details: { current_state: `slug_exhausted:${base}` },
  });
}

/** A Postgres 23505 on one named constraint. */
function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === "23505" && pgError.constraint === constraint;
}

/** A `discovery` column that the handler has actually written. */
function isDiscoveryPayload(value: unknown): value is DiscoveryResponse {
  return typeof value === "object" && value !== null && "discovery_status" in value && "fields" in value;
}

/** AC4 — exactly the optional keys the caller sent, in the order §4.1 documents them. */
function suppliedFields(input: CreateProjectRequest): OptionalProjectField[] {
  return OPTIONAL_PROJECT_FIELDS.filter((field) => input[field] !== undefined);
}

/**
 * `projects.prompts_cap` is a `smallint`, so 32767 is the largest value it can
 * hold. An unlimited entitlement is stored as that maximum: no project will
 * ever carry 32k prompts, so "as many as the column can express" and "no cap"
 * are the same thing in practice.
 *
 * This is NOT the sentinel that caused the bug below. MAX_SAFE_INTEGER was
 * unrepresentable in the column; this is the column's own ceiling.
 *
 * The properly-typed fix is a nullable column with NULL meaning unlimited —
 * the convention `structuralLimitFrom` already uses for the entitlement, and
 * the one the client's own pass arithmetic draws deliberately. That is a
 * migration plus a contract change (`prompts_cap` is `z.number()` on the
 * wire), so it belongs in its own story rather than in a crash fix.
 */
const PROMPTS_CAP_COLUMN_MAX = 32767;

/**
 * Resolves an entitlement value to the numeric cap this request must enforce.
 *
 * Delegates to `structuralLimitFrom`, which is the ONE place that knows what
 * a resolved entitlement value means. The hand-rolled version this replaces
 * got two of its four cases wrong, and both were live:
 *
 *   `"custom"` (enterprise, every structural key) — returned
 *   MAX_SAFE_INTEGER, which was then bound into `prompts_cap`, a `smallint`.
 *   Postgres refused it with 22003 numeric-value-out-of-range AFTER the URL
 *   guard and the cap checks had passed, so **every project creation on an
 *   enterprise plan answered 500** on an otherwise valid request. Enterprise
 *   reaches the service because `structuralLimitFrom` resolves "custom" to
 *   unlimited, so `projects.max` does not refuse it at the guard.
 *
 *   `null` — returned MAX_SAFE_INTEGER, i.e. UNLIMITED, when
 *   plans-and-entitlements.md means the opposite: "no allowance at all"
 *   (classification.ts's own comment says so, naming this exact key). Not
 *   currently reachable, because the only plan carrying null for a prompt cap
 *   is `free`, whose `projects.max` is 0 and is refused at the guard — but it
 *   was one plan-table edit away from silently granting an unlimited cap to
 *   the tier that is meant to have none.
 *
 * An unrecognised value fails closed at 0 rather than open at unlimited: a
 * value nobody classified is a configuration defect, and the safe reading of
 * a defect is "grant nothing", not "grant everything".
 */
function resolveCap(value: unknown): number {
  const limit = structuralLimitFrom(value as EntitlementValue);
  if (limit === undefined) return 0;
  return limit.kind === "unlimited" ? PROMPTS_CAP_COLUMN_MAX : limit.limit;
}

function assertWithinCap(key: string, requested: number, limit: number): void {
  if (requested > limit) {
    throw new EntitlementExceededError({
      message: `this plan allows ${String(limit)} for ${key}`,
      details: { key, limit, current: requested },
    });
  }
}

async function assertParentExists(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  parentProjectId: string,
): Promise<void> {
  // No workspace_id predicate: RLS already scopes this to the tenant, and
  // adding one here would imply the filter lives in application code
  // (NFR-SEC-01). A parent in another tenant is simply not visible.
  const result = await client.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [parentProjectId]);
  if (result.rows.length === 0) {
    throw new ValidationFailedError({
      message: "parent_project_id does not name a project",
      details: { issues: [{ path: ["parent_project_id"], message: "no such project" }] },
    });
  }
}

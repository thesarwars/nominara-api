import { Injectable, Logger } from "@nestjs/common";
import type {
  ConfirmDiscoveryRequest,
  ConfirmableField,
  CreateProjectRequest,
  CreateProjectResponse,
  DiscoveredField,
  DiscoveryResponse,
  OptionalProjectField,
} from "../../../contracts/projects/index.js";
import { COLUMN_FOR_FIELD, LIST_VALUED_FIELDS } from "../../../contracts/projects/index.js";
import { OPTIONAL_PROJECT_FIELDS } from "../../../contracts/projects/index.js";
import { EntitlementExceededError, NotFoundError, UnsafeTargetError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { GuardedFetchRefusal } from "../../lib/net/guarded-fetch.js";
import { UrlGuard } from "../../lib/net/url-guard.service.js";
import { UnparsableHostError } from "../../lib/net/registrable-domain.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { afterCommit, currentTenantStore } from "../../tenancy/tenant-context.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { FREE_PROMPT_ALLOWANCE } from "../../lib/discovery/discover.js";
import { handlerFor } from "../../lib/queue/handlers.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";

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

    const projectId = uuidV7();
    await client.query(
      `INSERT INTO projects
         (id, workspace_id, name, slug, kind, parent_project_id, root_url, root_domain,
          owned_domains, brand_aliases, negative_aliases, category_slug, verticals, locale,
          description, prompts_cap, discovery_status, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending','initializing',$17)`,
      [
        projectId,
        workspaceId,
        // Named from the discovered brand name when omitted (§4.1). Until
        // discovery runs, the domain is the only honest placeholder — a blank
        // name would render as an empty row in the sidebar.
        input.name ?? rootDomain,
        rootDomain,
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
      ],
    );

    await this.insertSuppliedSeeds(client, workspaceId, projectId, input);

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
    const resolved =
      entitlementVersion === undefined
        ? await this.entitlements.resolveForWorkspace(workspaceId)
        : await this.entitlements.resolve(workspaceId, entitlementVersion);
    const cap = resolveCap(resolved.entitlements["competitors.max_per_project"]?.value);

    const existing = await client.query(
      "SELECT name FROM competitors WHERE project_id = $1 AND deleted_at IS NULL",
      [projectId],
    );
    const present = new Set(existing.rows.map((row) => row.name.toLowerCase()));
    // AC7 — re-confirming a competitor already tracked is a no-op, not a
    // duplicate row and not a cap violation.
    const toInsert = competitors.filter((c) => !present.has(c.name.toLowerCase()));

    assertWithinCap("competitors.max_per_project", present.size + toInsert.length, cap);

    for (const competitor of toInsert) {
      await client.query(
        `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, origin)
         VALUES ($1,$2,$3,$4,$5,$6,'user_authored')`,
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
   * AC5 — supplied competitors are `user_authored`, supplied prompts `manual`,
   * and neither charges anything. There is no wallet call anywhere in this
   * method, which is what makes scenario 15's "wallet unchanged" true by
   * construction rather than by a test that happens to pass.
   */
  private async insertSuppliedSeeds(
    client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    workspaceId: string,
    projectId: string,
    input: CreateProjectRequest,
  ): Promise<void> {
    for (const competitor of input.competitors ?? []) {
      await client.query(
        `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, origin)
         VALUES ($1,$2,$3,$4,$5,$6,'user_authored')`,
        [uuidV7(), workspaceId, projectId, competitor.name, competitor.root_domain ?? null, competitor.aliases ?? []],
      );
    }
    for (const prompt of input.prompts ?? []) {
      await client.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, text, generation_source, status)
         VALUES ($1,$2,$3,$4,'manual','active')`,
        [uuidV7(), workspaceId, projectId, prompt.text],
      );
    }
  }
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

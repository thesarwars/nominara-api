import { Injectable, Logger } from "@nestjs/common";
import type { CreateProjectRequest, CreateProjectResponse, DiscoveryResponse, OptionalProjectField } from "../../../contracts/projects/index.js";
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

    const promptsCap = numericEntitlement(resolved.entitlements["prompts.max_per_project"]?.value);
    const competitorsCap = numericEntitlement(resolved.entitlements["competitors.max_per_project"]?.value);

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

    return {
      discovery_status: row.discovery_status as DiscoveryResponse["discovery_status"],
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

/** A `discovery` column that the handler has actually written. */
function isDiscoveryPayload(value: unknown): value is DiscoveryResponse {
  return typeof value === "object" && value !== null && "discovery_status" in value && "fields" in value;
}

/** AC4 — exactly the optional keys the caller sent, in the order §4.1 documents them. */
function suppliedFields(input: CreateProjectRequest): OptionalProjectField[] {
  return OPTIONAL_PROJECT_FIELDS.filter((field) => input[field] !== undefined);
}

/** `null` means unlimited (plans-and-entitlements.md); a number is a hard cap. */
function numericEntitlement(value: unknown): number {
  return typeof value === "number" ? value : Number.MAX_SAFE_INTEGER;
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

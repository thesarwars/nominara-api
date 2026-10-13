import { Injectable } from "@nestjs/common";
import { decodeTimestampIdCursor, MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type {
  CreatePromptRequest,
  PromptListItem,
  PromptListQuery,
  PromptListResponse,
} from "../../../contracts/prompts/index.js";
import { ConflictError, EntitlementExceededError, NotFoundError } from "../../api/errors/domain-errors.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";
import { structuralLimitFrom } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { insertPromptStatement, manualPromptRow } from "../../lib/promptgen/persist.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-134 — `GET /projects/{id}/prompts` and `POST /projects/{id}/prompts`.
// api-specification.md §3, page-inventory.md §6. Closes `G9`.
//
// Both endpoints are normative in §3 and were built by nobody, which is why
// generation could write fifteen rows, activation could turn them on, and
// nothing could read them back — `/p/{project}/prompts` rendered a heading
// over a project with fifteen tracked prompts.
//
// TWO PREDICATES, AND THEY DO DIFFERENT JOBS. `project_id = $1` is here
// because RLS scopes the TENANT and not the project, and this route's path
// names one: without it a sibling project's prompts appear in this project's
// matrix. There is deliberately NO `workspace_id` predicate — that boundary
// is RLS's (`NFR-SEC-01`), and one here would imply it lives in application
// code.

/** `PROMPT_OCCUPIES_SLOT`, verbatim from src/lib/entitlements/structural-usage.ts. */
const OCCUPIES_SLOT = "status <> 'archived' AND deleted_at IS NULL";

const PROMPTS_CAP_COLUMN_MAX = 32_767;

interface PromptRow {
  id: string;
  text: string;
  text_hash: Buffer;
  intent_archetype: string;
  funnel_stage: string;
  status: string;
  is_priority: boolean;
  generation_source: string;
  generation_batch_id: string | null;
  cluster_id: string | null;
  stability_score: number | null;
  last_captured_at: string | null;
  created_at: string;
  /** Full (microsecond) precision — the keyset half the cursor carries. */
  created_at_key: string;
}

type TenantClient = { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> };

@Injectable()
export class PromptListService {
  constructor(private readonly entitlements: EntitlementResolver) {}

  async list(projectId: string, query: PromptListQuery): Promise<Page<PromptListItem, PromptListResponse>> {
    const { client, workspaceId } = this.tenant();
    // Decoded BEFORE any statement runs: a cursor this list did not issue is a 400, never a silent first page.
    const after = query.cursor === undefined ? undefined : decodeTimestampIdCursor(query.cursor, "prompts.prompts");
    await this.assertProjectExists(client, projectId);

    // FILTERS AS PARAMETERS, never interpolated. The values come from a
    // `.strict()` enum so they cannot be hostile today — but a filter built
    // by string concatenation is a pattern that outlives the enum that made
    // it safe, and the next person adds a free-text one to it.
    const params: unknown[] = [projectId];
    const conditions: string[] = [];
    for (const [column, value] of [
      ["status", query.status],
      ["intent_archetype", query.intent_archetype],
      ["funnel_stage", query.funnel_stage],
    ] as const) {
      if (value === undefined) continue;
      params.push(value);
      conditions.push(`AND ${column} = $${String(params.length)}`);
    }

    // KEYSET on (created_at, id) — the same total order as the ORDER BY, so a page boundary inside a run of equal
    // created_at (a generation pass inserts its fifteen rows in one statement) can neither skip nor repeat a row.
    // Both halves bind as parameters; `after` is null on the first page and the predicate collapses to true.
    params.push(after?.[0] ?? null, after?.[1] ?? null);
    const afterAt = `$${String(params.length - 1)}`;
    const afterId = `$${String(params.length)}`;
    conditions.push(`AND (${afterAt}::timestamptz IS NULL OR (created_at, id) > (${afterAt}::timestamptz, ${afterId}::uuid))`);

    // One row more than asked: that is how `has_more` is known without a COUNT.
    params.push(query.limit + 1);
    const limitPlaceholder = `$${String(params.length)}`;

    const result = await client.query<PromptRow>(
      `SELECT id, text, text_hash, intent_archetype, funnel_stage, status, is_priority,
              generation_source, generation_batch_id, cluster_id, stability_score,
              last_captured_at::text AS last_captured_at, created_at::text AS created_at,
              to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_at_key
         FROM tracked_prompts
        WHERE project_id = $1
          AND deleted_at IS NULL
          ${conditions.join("\n          ")}
        ORDER BY created_at ASC, id ASC
        LIMIT ${limitPlaceholder}`,
      params,
    );

    const page = pageFrom(result.rows, query.limit, "prompts.prompts", toPromptListItem, (row) => [row.created_at_key, row.id]);
    const summary = await this.summaryFor(client, workspaceId, projectId);
    // Labels are booleans only — no workspace, project or cursor content.
    incrementCounter("nominara_prompts_list_pages_total", {
      has_more: String(page.pagination.has_more),
      continued: String(after !== undefined),
    });
    return new Page(page.items, page.pagination, { prompts: [...page.items], summary });
  }

  /**
   * `POST /projects/{id}/prompts` — manual creation, 0 credits.
   *
   * STILL SUBJECT TO THE CAP (STORY-046 AC7: "Manual prompt entry is always
   * free and still subject to the cap"). Without that check, typing prompts
   * is an unbounded way past a limit that generation respects — and it is the
   * cheapest possible way to find it.
   *
   * The row comes from `manualPromptRow`, the same builder project creation
   * uses. A third copy of the column list is exactly how the STORY-043 defect
   * happened: an insert that omitted three NOT NULL columns and could never
   * execute.
   */
  async create(projectId: string, request: CreatePromptRequest): Promise<PromptListItem> {
    const { client, workspaceId } = this.tenant();
    await this.assertProjectExists(client, projectId);

    const cap = await this.resolveCap(workspaceId);
    const occupying = await this.countOccupying(client, projectId);

    // BEFORE the insert, so a capped project writes nothing.
    if (occupying + 1 > cap) {
      throw new EntitlementExceededError({
        message: `this plan allows ${String(cap)} active prompts per project`,
        details: { key: "prompts.max_per_project", limit: cap, current: occupying },
        remediation: { kind: "increase_limit", url: "/settings/billing" },
      });
    }

    const row = manualPromptRow({ workspaceId, projectId, text: request.text });
    const { sql, params } = insertPromptStatement(row);
    try {
      await client.query(sql, [...params]);
    } catch (error: unknown) {
      // `ux_prompts_project_hash` is unique on (project_id, text_hash).
      // Typing a prompt the project already tracks is something the customer
      // can act on, not an unhandled database error.
      if (isUniqueViolation(error)) {
        throw new ConflictError({ message: "this project already tracks that prompt" });
      }
      throw error;
    }

    // Same transaction as the insert (STORY-046 AC10), recomputed rather than
    // incremented so it cannot drift under a concurrent archive.
    await client.query(
      `UPDATE projects
          SET prompts_active = (SELECT count(*) FROM tracked_prompts
                                 WHERE project_id = $1 AND ${OCCUPIES_SLOT}),
              updated_at = now()
        WHERE id = $1`,
      [projectId],
    );

    return {
      id: row.id,
      text: row.text,
      text_hash: `sha256:${row.textHash.toString("hex")}`,
      intent_archetype: row.intentArchetype,
      funnel_stage: row.funnelStage,
      status: row.status,
      is_priority: row.isPriority,
      generation_source: row.generationSource,
      generation_batch_id: row.generationBatchId,
      // Null by construction on a new manual prompt: no clustering has run,
      // no capture has touched it, no stability window exists.
      cluster_id: null,
      stability_score: null,
      last_captured_at: null,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * `FR-PA-03a`'s header — `active / cap` and the archived count.
   *
   * PAUSED IS COUNTED SEPARATELY, because `PROMPT_OCCUPIES_SLOT` is
   * `status <> 'archived'`: a header showing only active/cap would tell a
   * customer with 40 active and 8 paused that they have 10 slots free on a
   * cap of 50, when they have 2.
   *
   * Computed server-side rather than derived from the page, because the page
   * is ONE CURSOR PAGE — a 50-row page of a 200-prompt project would make the
   * client's own tally wrong, and quietly.
   */
  private async summaryFor(
    client: TenantClient,
    workspaceId: string,
    projectId: string,
  ): Promise<PromptListResponse["summary"]> {
    const result = await client.query<{ active: number; paused: number; archived: number }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::int   AS active,
              count(*) FILTER (WHERE status = 'paused')::int   AS paused,
              count(*) FILTER (WHERE status = 'archived')::int AS archived
         FROM tracked_prompts
        WHERE project_id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    const counts = result.rows[0] ?? { active: 0, paused: 0, archived: 0 };
    return { ...counts, cap: await this.resolveCap(workspaceId) };
  }

  private tenant(): { client: TenantClient; workspaceId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("PromptListService requires an active tenant context");
    return { client: store.client as TenantClient, workspaceId: store.context.workspaceId };
  }

  private async assertProjectExists(client: TenantClient, projectId: string): Promise<void> {
    // No `workspace_id` predicate — RLS scopes the tenant (`NFR-SEC-01`).
    const result = await client.query<{ prompts_cap: number }>(
      "SELECT prompts_cap FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [projectId],
    );
    if (result.rows.length === 0) throw new NotFoundError({ message: "no such project" });
  }

  private async countOccupying(client: TenantClient, projectId: string): Promise<number> {
    const result = await client.query<{ active: number; paused: number }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
              count(*) FILTER (WHERE status = 'paused')::int AS paused
         FROM tracked_prompts
        WHERE project_id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    const counts = result.rows[0] ?? { active: 0, paused: 0 };
    // Both occupy. The same occupancy rule as everywhere else: 45 active plus
    // 5 paused on a cap of 50 is full, even though only 45 are capturing.
    return counts.active + counts.paused;
  }

  /**
   * The cap from the ENTITLEMENT, not from `projects.prompts_cap`.
   *
   * The column is a creation-time snapshot; reading it would mean an upgrade
   * did not raise the header's cap until the project was recreated. Same
   * reasoning, and the same source, as the activation service.
   */
  private async resolveCap(workspaceId: string): Promise<number> {
    const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
    const value = resolved.entitlements["prompts.max_per_project"]?.value;
    if (value === undefined) return 0;
    const limit = structuralLimitFrom(value as EntitlementValue);
    if (limit === undefined) return 0;
    return limit.kind === "unlimited" ? PROMPTS_CAP_COLUMN_MAX : limit.limit;
  }
}

function toPromptListItem(row: PromptRow): PromptListItem {
  return {
    id: row.id,
    text: row.text,
    text_hash: `sha256:${row.text_hash.toString("hex")}`,
    intent_archetype: row.intent_archetype as PromptListItem["intent_archetype"],
    funnel_stage: row.funnel_stage as PromptListItem["funnel_stage"],
    status: row.status as PromptListItem["status"],
    is_priority: row.is_priority,
    generation_source: row.generation_source as PromptListItem["generation_source"],
    generation_batch_id: row.generation_batch_id,
    // PASSED THROUGH, never coalesced. `stability_score: 0` would assert
    // perfect instability and `FR-PA-07` warns below 0.5, so a coalesce would
    // put an "unstable" warning on every prompt in the product;
    // `last_captured_at` defaulted to now would claim a capture that never
    // happened.
    cluster_id: row.cluster_id,
    stability_score: row.stability_score,
    last_captured_at: row.last_captured_at,
    created_at: row.created_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

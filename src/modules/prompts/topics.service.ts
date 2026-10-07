import { Injectable, Logger } from "@nestjs/common";
import type { RenameTopicRequest, Topic, TopicListResponse } from "../../../contracts/projects/index.js";
import { ConflictError, NotFoundError } from "../../api/errors/domain-errors.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { ProjectOutOfScopeException } from "../../tenancy/errors.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// NEW-B-3 — `GET /projects/{id}/topics` and `PATCH /topics/{id}`.
// api-specification.md §3; schemas/projects-and-prompts.md `topic_clusters`.
//
// READ AND RENAME ONLY. Nothing here clusters: `topic_clusters` is written by
// STORY-047's recomputation, which waits on STORY-133's embedding client. Until
// then a real project's list is `[]`, and that is the truthful answer.
//
// THE RENAME SETS `label_source = 'user'`, the value the table's CHECK allows
// (the story prose says "human"; the reference wins). That is what lets a
// recomputation preserve the label.
//
// No `workspace_id` predicate anywhere: RLS scopes the tenant (NFR-SEC-01).
// `project_id = $1` is the route's own narrowing, which RLS does not provide.

const COLUMNS = `id AS topic_id, project_id, label, label_source, prompt_count, commercial_intent,
       visibility_score, authority_rank, leader_entity_id, gap_priority, achievability,
       computed_at`;

interface TopicRow {
  topic_id: string;
  project_id: string;
  label: string;
  label_source: "auto" | "user";
  prompt_count: number;
  commercial_intent: number;
  visibility_score: string | number | null;
  authority_rank: number | null;
  leader_entity_id: string | null;
  gap_priority: number | null;
  achievability: number | null;
  computed_at: Date | string | null;
}

type TenantClient = { query: <R>(sql: string, params: unknown[]) => Promise<{ rows: R[] }> };

@Injectable()
export class TopicsService {
  private readonly logger = new Logger(TopicsService.name);

  async list(projectId: string): Promise<TopicListResponse> {
    const { client } = this.tenant();

    // 404 for a project that does not exist, so an unknown id is not
    // indistinguishable from a real project with nothing clustered yet.
    const project = await client.query<{ id: string }>(
      "SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [projectId],
    );
    if (project.rows.length === 0) throw new NotFoundError({ message: "no such project" });

    // Biggest opportunity first; NULL priority (not yet computed) last.
    const result = await client.query<TopicRow>(
      `SELECT ${COLUMNS}
         FROM topic_clusters
        WHERE project_id = $1
        ORDER BY gap_priority DESC NULLS LAST, label ASC, id ASC`,
      [projectId],
    );
    incrementCounter("nominara_topics_list_total", { empty: String(result.rows.length === 0) });
    return { topics: result.rows.map(toTopic) };
  }

  async rename(topicId: string, request: RenameTopicRequest): Promise<Topic> {
    const { client, scopeProjectIds } = this.tenant();

    const found = await client.query<{ project_id: string }>(
      "SELECT project_id FROM topic_clusters WHERE id = $1",
      [topicId],
    );
    const existing = found.rows[0];
    if (existing === undefined) throw new NotFoundError({ message: "no such topic" });

    // A scoped member may rename only topics of projects they are assigned to.
    // A denial is a 403, never a 404 (security-and-tenancy.md). An empty scope
    // array is "scoped to nothing" and refuses everything; only an absent
    // scope is unrestricted.
    if (scopeProjectIds !== undefined && !scopeProjectIds.includes(existing.project_id)) {
      throw new ProjectOutOfScopeException();
    }

    try {
      const updated = await client.query<TopicRow>(
        `UPDATE topic_clusters
            SET label = $2, label_source = 'user', updated_at = now()
          WHERE id = $1
        RETURNING ${COLUMNS}`,
        [topicId, request.label],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new NotFoundError({ message: "no such topic" });
      incrementCounter("nominara_topics_renamed_total");
      // The topic id only; never the label, which is customer text.
      this.logger.log({ event: "topic.renamed", topic_id: topicId });
      return toTopic(row);
    } catch (error: unknown) {
      // `ux_topic_clusters` is unique on (project_id, lower(label)).
      if (isUniqueViolation(error)) {
        throw new ConflictError({ message: "another topic in this project already has that label" });
      }
      throw error;
    }
  }

  private tenant(): { client: TenantClient; scopeProjectIds: readonly string[] | undefined } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("TopicsService requires an active tenant context");
    return { client: store.client as TenantClient, scopeProjectIds: store.context.scopeProjectIds };
  }
}

/** `null` and `0` stay distinct: an unmeasured topic must not read as a score of zero. */
function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function toTopic(row: TopicRow): Topic {
  return {
    topic_id: row.topic_id,
    project_id: row.project_id,
    label: row.label,
    label_source: row.label_source,
    prompt_count: row.prompt_count,
    commercial_intent: row.commercial_intent,
    visibility_score: numberOrNull(row.visibility_score),
    authority_rank: row.authority_rank,
    leader_entity_id: row.leader_entity_id,
    gap_priority: row.gap_priority,
    achievability: row.achievability,
    computed_at: row.computed_at === null ? null : new Date(row.computed_at).toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

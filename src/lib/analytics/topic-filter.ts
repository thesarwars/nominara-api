import type { ClientBase } from "pg";
import { parseTopicFilter } from "../../../contracts/analytics/topics-filter.schema.js";
import { ValidationFailedError } from "../../api/errors/domain-errors.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-090 AC8 - the `topics` query on the scorecards and the Growth Map: topic-cluster ids of THIS project.
//
// AN ID THE PROJECT DOES NOT HAVE IS A 400 NAMING `topics`, never dropped. Dropping it would widen the figure to more prompts than the customer chose while the
// filter bar still shows the chip selected. A cluster of another project (or workspace - RLS hides those rows, so they read as unknown) is refused the same way
// as a made-up id, so the response does not confirm that an id exists elsewhere.

/** `null` is "no narrowing" (absent). Otherwise the de-duplicated ids, every one verified to belong to `projectId`. */
export async function resolveTopicFilter(tx: ClientBase, projectId: string, raw: string | undefined): Promise<string[] | null> {
  const requested = parseTopicFilter(raw);
  if (requested === null) return null;
  const found = await tx.query<{ id: string }>("SELECT id::text FROM topic_clusters WHERE project_id = $1 AND id = ANY($2::uuid[])", [projectId, requested]);
  const known = new Set(found.rows.map((row) => row.id));
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length === 0) {
    incrementCounter("nominara_analytics_topic_filter_reads_total", { outcome: "served" });
    return requested;
  }
  incrementCounter("nominara_analytics_topic_filter_reads_total", { outcome: "unknown_topic" });
  const message = `topics names ${unknown.length === 1 ? "a topic cluster" : "topic clusters"} this project does not have: ${unknown.join(", ")}`;
  throw new ValidationFailedError({ message, details: { issues: [{ path: ["topics"], message }] } });
}

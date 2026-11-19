import { z } from "zod";

// STORY-090 AC8 - the Overview filter bar's topic-cluster multi-select: `topics=<id>,<id>` on the scorecards and the Growth Map. A comma list of topic-cluster
// ids (`GET /projects/{id}/topics`). NARROWING ONLY: the figures are computed over the member prompts of those clusters, with the engine filter and the
// timeframe (preset or custom) applied as before. Absent means no narrowing.
//
// WHAT THE CONTRACT REFUSES: a malformed id, a duplicate-only/empty list, and more ids than a project can plausibly have. WHAT IT CANNOT KNOW is whether an id
// belongs to THIS project, so an unknown or foreign id is the service's 400, naming `topics`, never a silent drop (a dropped id would widen the figure the
// customer believes is narrowed).

/** A project has at most a few dozen clusters (schemas/projects-and-prompts.md); this bounds the `ANY($n)` list. PROVISIONAL, not in the references. */
export const TOPIC_FILTER_MAX = 50;

export const topicsFilterSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      const ids = value.split(",").map((id) => id.trim());
      return ids.length <= TOPIC_FILTER_MAX && ids.every((id) => z.uuid().safeParse(id).success);
    },
    { message: `topics must be 1 to ${TOPIC_FILTER_MAX} comma-separated topic cluster ids` },
  );

/** The ids, de-duplicated and in request order. `null` means "no narrowing" - the parameter was absent. */
export function parseTopicFilter(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  return [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0))];
}

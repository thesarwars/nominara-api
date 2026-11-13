import { createHash } from "node:crypto";
import { z } from "zod";

// STORY-133 - the shape of an `embed.batch` job, shared by the handler (consumer) and the producers.
//
// The payload names ROWS, not texts: the text is read inside the job's own tenant transaction, so it never rides through Valkey
// and a row edited between enqueue and run is embedded as it is now.

/** system-architecture.md section 4: "concurrency 4 (batch of 96 texts)". */
export const EMBED_PROVIDER_BATCH_SIZE = 96;

/** A job carries at most ten provider batches. Producers split at 96, so a job is normally one call. */
export const EMBED_JOB_MAX_IDS = EMBED_PROVIDER_BATCH_SIZE * 10;

/** The tables `embed.batch` writes a vector to. Anything else is refused at the payload. */
export const EMBED_TABLES = ["tracked_prompts", "content_chunks", "corpus_passages", "semantic_nodes"] as const;
export type EmbedTable = (typeof EMBED_TABLES)[number];

export const embedBatchPayloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    table: z.enum(EMBED_TABLES),
    ids: z.array(z.string().uuid()).min(1).max(EMBED_JOB_MAX_IDS),
    // STORY-186 - a re-embed job: write the vector to `embedding_next` beside the served one instead of replacing it (migration 0211).
    // Only the two tables whose vector is replaced in place carry a staging column.
    stage: z.literal(true).optional(),
  })
  .strict()
  .refine((payload) => payload.stage !== true || payload.table === "tracked_prompts" || payload.table === "semantic_nodes", {
    message: "stage is only defined for tracked_prompts and semantic_nodes",
    path: ["stage"],
  });

export type EmbedBatchPayload = z.infer<typeof embedBatchPayloadSchema>;

/** Consecutive slices of at most 96, in order. Empty in, empty out: never one empty provider call. */
export function splitIntoProviderBatches<T>(items: readonly T[]): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += EMBED_PROVIDER_BATCH_SIZE) {
    batches.push(items.slice(start, start + EMBED_PROVIDER_BATCH_SIZE));
  }
  return batches;
}

/** How a producer splits ids into jobs. Same size as a provider call, so a job is one call. */
export function splitIdsIntoJobs(ids: readonly string[]): string[][] {
  return splitIntoProviderBatches(ids);
}

/**
 * `emb:{sha256(batch)}` (section 4). The key is a CONTENT hash, so the batch's composition decides it: the ids are lower-cased,
 * de-duplicated and SORTED before hashing. Without that, the same 96 rows in another order would be a second key and a second
 * spend, and replay-safety would be a coin flip.
 */
export function embedBatchKey(table: EmbedTable, ids: readonly string[], stage = false): string {
  const canonical = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  // A stage job for the same rows is a different job from a direct one (it writes elsewhere), so it keys differently. A direct key is unchanged.
  return `emb:${createHash("sha256").update([stage ? `${table}:stage` : table, ...canonical].join("\n")).digest("hex")}`;
}

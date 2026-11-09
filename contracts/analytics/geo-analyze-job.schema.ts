import { z } from "zod";

// STORY-192 - the `geo.analyze` job payload for the alignment session. The producer (the API route, or the job itself re-queueing) adds
// `workspaceId` and `kid` and signs the whole; the worker verifies the signature BEFORE it parses or sets any tenant context.
//
//   alignment_session  one STEP of opening a session: fetch, corpus, vectors, centroid, alignment, concepts, analysis
//   alignment_draft    the debounced recompute of the customer's draft
//
// `attempt` counts the job's own re-queues (it waits for vectors by queueing itself again, delayed): it is part of the idempotency key, so a
// redelivery of one step is one job and the next step is another. Strict: an unknown key is a failed job, never a silent drop.

const common = {
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
  attempt: z.number().int().min(0).default(0),
  workspaceId: z.string().uuid(),
  kid: z.string().min(1),
};

export const geoAnalyzeJobPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("alignment_session"), ...common }).strict(),
  // `dueAt` is the draft's due time exactly as the database holds it, so every SAVE of a draft is a different job. Without it every save of a
  // session would share one idempotency key, and the queue's deduplication window would drop the job of every save after the first.
  z.object({ kind: z.literal("alignment_draft"), ...common, dueAt: z.string().min(1) }).strict(),
]);
export type GeoAnalyzeJobPayload = z.infer<typeof geoAnalyzeJobPayloadSchema>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** What a producer hands the queue: the payload before it adds `workspaceId` and `kid` and signs it. */
export type GeoAnalyzeJobInput = DistributiveOmit<GeoAnalyzeJobPayload, "workspaceId" | "kid">;

/**
 * The idempotency key of one step: `geo:{project}:{analysis}:{window}` (system-architecture.md section 4), the window being the session, the kind,
 * (for a draft) the save it belongs to, and the attempt: a redelivery of one step shares a key, and nothing else does.
 */
export function geoAnalyzeKey(payload: Pick<GeoAnalyzeJobPayload, "projectId" | "sessionId" | "kind" | "attempt"> & { readonly dueAt?: string }): string {
  const save = payload.kind === "alignment_draft" && payload.dueAt !== undefined ? `.${payload.dueAt.replace(/[^0-9]/g, "")}` : "";
  return `geo:${payload.projectId}:alignment:${payload.sessionId}.${payload.kind}${save}.${String(payload.attempt)}`;
}

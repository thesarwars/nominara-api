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
  z.object({ kind: z.literal("alignment_draft"), ...common }).strict(),
]);
export type GeoAnalyzeJobPayload = z.infer<typeof geoAnalyzeJobPayloadSchema>;

/** The idempotency key of one step: `geo:{project}:{analysis}:{window}` (system-architecture.md section 4), the window being the session, kind and attempt. */
export function geoAnalyzeKey(payload: Pick<GeoAnalyzeJobPayload, "projectId" | "sessionId" | "kind" | "attempt">): string {
  return `geo:${payload.projectId}:alignment:${payload.sessionId}.${payload.kind}.${String(payload.attempt)}`;
}

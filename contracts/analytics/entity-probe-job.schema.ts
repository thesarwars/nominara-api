import { z } from "zod";

// STORY-060 E1/E3 (owner decision 99b) - the `geo.analyze` job payload that probes a project's Wikidata and Wikipedia profiles and reads the brand's own
// `sameAs` links off its home page. The producer (the daily rollup, after its commit) adds `workspaceId` and `kid` and signs the whole; the worker verifies
// the signature BEFORE it parses or sets any tenant context. Not a member of `geoAnalyzeJobPayloadSchema` (that union is the alignment session's).
// Strict: an unknown key is a failed job, never a silent drop.

export const entityProbeJobPayloadSchema = z
  .object({
    kind: z.literal("entity_probe"),
    projectId: z.string().uuid(),
    /** The UTC day the job was queued for: one job per project and day (the job itself skips a project probed within the last week). */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    workspaceId: z.string().uuid(),
    kid: z.string().min(1),
  })
  .strict();
export type EntityProbeJobPayload = z.infer<typeof entityProbeJobPayloadSchema>;
/** What a producer hands the queue: the payload before it adds `workspaceId` and `kid` and signs it. */
export type EntityProbeJobInput = Omit<EntityProbeJobPayload, "workspaceId" | "kid">;

/** `geo:{project}:{analysis}:{window}` (system-architecture.md section 4): one job per project and UTC day; a redelivery shares it. */
export function entityProbeKey(payload: Pick<EntityProbeJobPayload, "projectId" | "day">): string {
  return `geo:${payload.projectId}:entity-probe:${payload.day}`;
}

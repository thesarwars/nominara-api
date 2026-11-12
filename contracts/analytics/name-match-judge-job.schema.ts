import { z } from "zod";

// STORY-191 (owner decision 99c) - the `geo.analyze` job payload that judges a project's ambiguous brand-name matches with a model. The producer (the daily
// rollup, after its commit) adds `workspaceId` and `kid` and signs the whole; the worker verifies the signature BEFORE it parses or sets any tenant context.
//
// Not a member of `geoAnalyzeJobPayloadSchema`: that union is the alignment session's, and every one of its members names a session. This job names a
// project and the judge version it was queued for (so a change of judge is a different job), and nothing else. Strict: an unknown key is a failed job,
// never a silent drop.

export const nameMatchJudgeJobPayloadSchema = z
  .object({
    kind: z.literal("name_match_judge"),
    projectId: z.string().uuid(),
    /** The judge version in force when this was queued (`<model>:name-match-vN`). The job judges under ITS OWN configured judge; a mismatch is a no-op. */
    judgeVersion: z.string().min(1),
    /** The UTC day the job was queued for: one job per project, judge and day. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    workspaceId: z.string().uuid(),
    kid: z.string().min(1),
  })
  .strict();
export type NameMatchJudgeJobPayload = z.infer<typeof nameMatchJudgeJobPayloadSchema>;
/** What a producer hands the queue: the payload before it adds `workspaceId` and `kid` and signs it. */
export type NameMatchJudgeJobInput = Omit<NameMatchJudgeJobPayload, "workspaceId" | "kid">;

/** `geo:{project}:{analysis}:{window}` (system-architecture.md section 4): one job per project, judge version and UTC day; a redelivery shares it. */
export function nameMatchJudgeKey(payload: Pick<NameMatchJudgeJobPayload, "projectId" | "judgeVersion" | "day">): string {
  return `geo:${payload.projectId}:name-match:${payload.judgeVersion}.${payload.day}`;
}

import { z } from "zod";

// NEW-A-10 — the payload of a signed `capture.plan` job.
//
// One job plans ONE project's scheduled run. `workspaceId` and `kid` are put
// there by the producer when it signs the envelope (the same shape every
// tenant-scoped payload has); the handler never trusts `workspaceId` for
// anything but the context the worker already set from the verified envelope.
//
// `trigger` discriminates the two producers: `scheduled` (the sweep) and `verification` (STORY-067). A manual run is planned on the
// request path inside the trigger's own transaction, and a drift sample is a different story. A job claiming any other trigger is refused
// rather than quietly planned as a scheduled one.
//
// `.strict()` so an unknown key (a `credits`, an `engines` list) is refused,
// not dropped: this job must not be a way to choose what a run costs or covers.
export const capturePlanScheduledJobSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string().min(1),
    projectId: z.string().uuid(),
    trigger: z.literal("scheduled"),
  })
  .strict();

// STORY-067 - a verification run. The job names the verification row it serves and NOTHING about what it covers or costs: the
// handler re-reads the row, so its cluster, its engines and its (zero) price are never the payload's to choose.
export const capturePlanVerificationJobSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string().min(1),
    projectId: z.string().uuid(),
    trigger: z.literal("verification"),
    verificationId: z.string().uuid(),
  })
  .strict();

export const capturePlanJobSchema = z.discriminatedUnion("trigger", [capturePlanScheduledJobSchema, capturePlanVerificationJobSchema]);

export type CapturePlanJob = z.infer<typeof capturePlanJobSchema>;
export type CapturePlanVerificationJob = z.infer<typeof capturePlanVerificationJobSchema>;

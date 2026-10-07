import { z } from "zod";

// NEW-A-10 — the payload of a signed `capture.plan` job.
//
// One job plans ONE project's scheduled run. `workspaceId` and `kid` are put
// there by the producer when it signs the envelope (the same shape every
// tenant-scoped payload has); the handler never trusts `workspaceId` for
// anything but the context the worker already set from the verified envelope.
//
// `trigger` is a literal, not an enum: a manual run is planned on the request
// path inside the trigger's own transaction, and a verification or drift
// sample is a different story. A job claiming any other trigger is refused
// rather than quietly planned as a scheduled one.
//
// `.strict()` so an unknown key (a `credits`, an `engines` list) is refused,
// not dropped: this job must not be a way to choose what a run costs or covers.
export const capturePlanJobSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string().min(1),
    projectId: z.string().uuid(),
    trigger: z.literal("scheduled"),
  })
  .strict();

export type CapturePlanJob = z.infer<typeof capturePlanJobSchema>;

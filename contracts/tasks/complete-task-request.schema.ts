import { z } from "zod";

// Owner decision 30 / STORY-055 AC5 — POST /v1/tasks/{id}/complete takes an OPTIONAL body.
//
// `url` is the contribution the customer made (a comment, a profile, a post on the target platform). It is REQUIRED for a
// seeding task (one with a playbook or a source class) and refused with `400 validation_failed` when absent - except that a seeding
// task with no source domain is refused outright (`409 no_source_domain`), which is why the served task's `seeding` flag is
// "has a source domain"; every other task
// completes with no body, exactly as before. The URL is checked here only by shape (http/https) and, in the service, by the pure
// host rules (`422 unsafe_target`); it is FETCHED later by the verification job, never by the request.
export const COMPLETE_TASK_URL_MAX = 2048;

export const completeTaskRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(COMPLETE_TASK_URL_MAX).optional(),
  })
  .strict();

export type CompleteTaskRequest = z.infer<typeof completeTaskRequestSchema>;

import { z } from "zod";
import { taskVerificationReasonSchema } from "./task-response.schema.js";

// Owner decision 30 / STORY-055 — the `task_events.payload` jsonb of the two verification events (migration 0155 holds the URL
// and the reason in the timeline rather than in new columns: a customer may resubmit after a failure, so they are a history).
//
//   verification_submitted  { url }                       — written by POST /tasks/{id}/complete, in the request's transaction.
//   verification_failed     { submission_id, reason }     — written by the `source.verify_presence` job; `submission_id` is the
//                                                           id of the `verification_submitted` event it answers (so a redelivery
//                                                           finds its own answer and writes nothing twice).
//
// A success has no event of its own: it is the `completed` event (in_review -> done) carrying `{ submission_id }`.
export const taskVerificationSubmittedPayloadSchema = z.object({ url: z.string().min(1) }).strict();
export const taskVerificationFailedPayloadSchema = z
  .object({ submission_id: z.string().uuid(), reason: taskVerificationReasonSchema })
  .strict();
export const taskVerificationCompletedPayloadSchema = z.object({ submission_id: z.string().uuid() }).strict();

export type TaskVerificationSubmittedPayload = z.infer<typeof taskVerificationSubmittedPayloadSchema>;
export type TaskVerificationFailedPayload = z.infer<typeof taskVerificationFailedPayloadSchema>;
export type TaskVerificationCompletedPayload = z.infer<typeof taskVerificationCompletedPayloadSchema>;

import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";
import { generatePromptsResponseSchema } from "./generate-prompts-response.schema.js";

// STORY-045, owner decision 95(a) (2026-11-10) - prompt generation is a background job.
//
// `POST /v1/projects/{id}/prompts/generate` validates, records a PENDING generation and answers `202` at once. The naturaliser (a model call)
// and vector dedupe (an embedding call) run in a signed job outside any transaction (KAD-06, ADR-0003); the pass is read back with
// `GET /v1/projects/{id}/prompts/generations/{generation_batch_id}`, which is the same `generation_batch_id` every stored prompt carries.
//
// THE RESULT IS THE OLD RESPONSE, UNCHANGED. `result` is `generatePromptsResponseSchema` verbatim, so `rejected[]`, `coverage[]`, `summary`
// and `novelty` keep the meaning they had when the route was synchronous. It is null until the job succeeds and is NEVER a partial pass: a
// generation that could not finish is `failed` with a `failure_code`, not `succeeded` with fewer variants.
//
// GENERATION STILL CHARGES NOTHING (FR-FAN-01g), failed or not: nothing in the job reaches the wallet or the ledger.

export const promptGenerationStatusSchema = z.enum(["pending", "running", "succeeded", "failed"]);
export type PromptGenerationStatus = z.infer<typeof promptGenerationStatusSchema>;

/**
 * Why a generation did not finish. A closed set, so a client can branch on it; the reason is never the text of an error or of a model answer.
 *   dispatch_failed    the job could not be queued after the request committed.
 *   project_not_found  the project was deleted before the job ran.
 *   generation_failed  the job ran out of attempts (a database failure while comparing or writing; a naturaliser or embedder outage is NOT
 *                      this - both fall back, to the template text and to exact-hash dedupe).
 */
export const promptGenerationFailureCodeSchema = z.enum(["dispatch_failed", "project_not_found", "generation_failed"]);
export type PromptGenerationFailureCode = z.infer<typeof promptGenerationFailureCodeSchema>;

/** `202` body of `POST /v1/projects/{id}/prompts/generate`. */
export const generatePromptsAcceptedResponseSchema = z
  .object({
    generation_batch_id: z.string().uuid(),
    status: z.literal("pending"),
    poll_url: z.string().min(1),
  })
  .strict();
export type GeneratePromptsAcceptedResponse = z.infer<typeof generatePromptsAcceptedResponseSchema>;

export const promptGenerationIdParamSchema = lowercaseUuidSchema;

/** `GET /v1/projects/{id}/prompts/generations/{generation_batch_id}`. */
export const promptGenerationSchema = z
  .object({
    generation_batch_id: z.string().uuid(),
    project_id: z.string().uuid(),
    status: promptGenerationStatusSchema,
    /** Null until `succeeded`; exactly the synchronous route's old response. */
    result: generatePromptsResponseSchema.nullable(),
    /** Non-null exactly when `failed`. */
    failure_code: promptGenerationFailureCodeSchema.nullable(),
    requested_at: z.string().datetime(),
    /** Null while `pending` or `running`. */
    completed_at: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === "succeeded") !== (value.result !== null)) {
      ctx.addIssue({ code: "custom", path: ["result"], message: "result is present exactly when status is succeeded" });
    }
    if ((value.status === "failed") !== (value.failure_code !== null)) {
      ctx.addIssue({ code: "custom", path: ["failure_code"], message: "failure_code is present exactly when status is failed" });
    }
    const terminal = value.status === "succeeded" || value.status === "failed";
    if (terminal !== (value.completed_at !== null)) {
      ctx.addIssue({ code: "custom", path: ["completed_at"], message: "completed_at is present exactly when the generation is settled" });
    }
  });
export type PromptGeneration = z.infer<typeof promptGenerationSchema>;

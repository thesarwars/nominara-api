import { z } from "zod";

// STORY-022 — system-architecture.md NFR-ARCH-05/06, §5 (HealthModule).
// Liveness is separate from readiness (Test scenario 1/2): liveness answers
// only "is the process up", readiness additionally answers "is it safe to
// route traffic to" (schema version match, dependency health). `.strict()`
// on both per coding-standards.md §2 — an unknown key is a bug, not a
// silently-ignored extra field, even on a response schema used internally
// by the deploy gate.

export const livenessResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();

export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

// One entry per external dependency behind a circuit breaker (NFR-ARCH-05).
// `state` mirrors the breaker's own three states so /health can be read
// directly against the breaker without translation.
export const dependencyHealthSchema = z
  .object({
    name: z.string().min(1),
    state: z.enum(["closed", "open", "half_open"]),
    healthy: z.boolean(),
  })
  .strict();

export type DependencyHealth = z.infer<typeof dependencyHealthSchema>;

// STORY-022-E-5 — queues is a RESERVED, always-empty array until STORY-030
// wires BullMQ; populating it with real depth is that story's job, not this
// one's. Kept as its own array (rather than omitted) so the response shape
// is stable across that later change.
export const queueDepthSchema = z
  .object({
    name: z.string().min(1),
    depth: z.number().int().nonnegative(),
  })
  .strict();

export type QueueDepth = z.infer<typeof queueDepthSchema>;

export const readinessResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    migrationVersion: z.object({
      applied: z.string().nullable(),
      expected: z.string().nullable(),
      matches: z.boolean(),
    }).strict(),
    dependencies: z.array(dependencyHealthSchema),
    queues: z.array(queueDepthSchema),
  })
  .strict();

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

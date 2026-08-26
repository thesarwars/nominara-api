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

// STORY-031 D16 — AC10's "per-engine status surface" so a customer can
// distinguish a platform problem from a vendor problem. `status` mirrors
// `engines.status`'s own DB CHECK (0003_projects_prompts_captures.up.sql);
// `circuitState` mirrors the per-engine breaker's three states (same set
// dependencyHealthSchema.state already uses for Postgres). `engineKey` is a
// plain string here (not the capture domain's EngineKey enum) — same
// generic-string precedent as dependencyHealthSchema.name above.
export const engineHealthSummarySchema = z
  .object({
    engineKey: z.string().min(1),
    status: z.enum(["active", "degraded", "disabled", "beta"]),
    circuitState: z.enum(["closed", "open", "half_open"]),
    healthy: z.boolean(),
  })
  .strict();

export type EngineHealthSummary = z.infer<typeof engineHealthSummarySchema>;

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
    // STORY-031 Phase A — RESERVED, always-empty array until this story's
    // later phases wire real per-engine health reads (same shape
    // STORY-022-E-5 established for `queues` before STORY-030 populated it).
    // A read failure degrades this to an empty array — it NEVER flips
    // `status` to `not_ready` (same posture as `queues` above).
    engines: z.array(engineHealthSummarySchema),
  })
  .strict();

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

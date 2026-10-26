import { z } from "zod";

// STORY-031 AC11 — the CUSTOMER-FACING per-engine status read, `GET /v1/engines/status` (`workspace:read`: any member).
//
// "Health state feeds both the health endpoint and the per-engine status surface, so a customer can distinguish a platform
// problem from a vendor problem." `/health/ready` is the operator's probe (public, unenveloped, a pass/fail); this is the
// product's: the degraded pip on first paint (FR-NAV-03), before any `engine.degraded` realtime event has arrived.
//
// GLOBAL, NOT TENANT DATA. Every field comes from `engines`, `engine_health` (both global tables, no `workspace_id`) and the
// per-engine breaker in the cache. Two members of two workspaces see the same body, which is what makes it cacheable.
//
// snake_case like every other product response (the camelCase `engineHealthSummarySchema` in health.schema.ts belongs to the
// operator probe and stays as it is).

export const ENGINE_CATALOG_STATUSES = ["active", "degraded", "disabled", "beta"] as const;
export const ENGINE_CIRCUIT_STATES = ["closed", "open", "half_open"] as const;

export const engineStatusEntrySchema = z
  .object({
    engine_key: z.string().min(1),
    /** `engines.status`. `degraded` is set by the degradation ladder (EC-06 stage 5) and cleared by it when the breaker closes. */
    status: z.enum(ENGINE_CATALOG_STATUSES),
    /** The live breaker state, read from the shared breaker store (not from the latest health bucket). */
    circuit_state: z.enum(ENGINE_CIRCUIT_STATES),
    /** When the breaker left `closed` for the current episode; null while closed. */
    unavailable_since: z.iso.datetime().nullable(),
    /** Trailing-window counters from `engine_health` (customer attempts and the synthetic canary alike). */
    window_minutes: z.number().int().positive(),
    attempts: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    timeouts: z.number().int().nonnegative(),
    rate_limited: z.number().int().nonnegative(),
    /** From the latest bucket only; null when no latency has been observed. */
    p50_latency_ms: z.number().int().nonnegative().nullable(),
    p95_latency_ms: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type EngineStatusEntry = z.infer<typeof engineStatusEntrySchema>;

export const engineStatusResponseSchema = z
  .object({
    engines: z.array(engineStatusEntrySchema),
    generated_at: z.iso.datetime(),
  })
  .strict();
export type EngineStatusResponse = z.infer<typeof engineStatusResponseSchema>;

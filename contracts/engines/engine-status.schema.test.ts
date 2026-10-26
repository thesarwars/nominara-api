import { describe, expect, it } from "vitest";
import { engineStatusResponseSchema } from "./index.js";

const entry = {
  engine_key: "gemini",
  status: "degraded",
  circuit_state: "open",
  unavailable_since: "2026-10-26T10:00:00.000Z",
  window_minutes: 60,
  attempts: 12,
  successes: 3,
  blocks: 9,
  timeouts: 0,
  rate_limited: 0,
  p50_latency_ms: 840,
  p95_latency_ms: null,
} as const;

describe("STORY-031 AC11 · engine status contract", () => {
  it("carries the catalog status, the live breaker state, the episode start and the trailing health counters", () => {
    expect(engineStatusResponseSchema.safeParse({ engines: [entry], generated_at: "2026-10-26T10:31:00.000Z" }).success).toBe(true);
  });

  it("is strict: no tenant field (workspace_id, affected projects) can ride along on a global read", () => {
    expect(engineStatusResponseSchema.safeParse({ engines: [{ ...entry, workspace_id: "x" }], generated_at: "2026-10-26T10:31:00.000Z" }).success).toBe(false);
    expect(engineStatusResponseSchema.safeParse({ engines: [], generated_at: "2026-10-26T10:31:00.000Z", affected_projects: 1 }).success).toBe(false);
  });

  it("refuses a circuit state or catalog status outside the breaker's and the CHECK's vocabularies", () => {
    expect(engineStatusResponseSchema.safeParse({ engines: [{ ...entry, circuit_state: "tripped" }], generated_at: "2026-10-26T10:31:00.000Z" }).success).toBe(false);
    expect(engineStatusResponseSchema.safeParse({ engines: [{ ...entry, status: "down" }], generated_at: "2026-10-26T10:31:00.000Z" }).success).toBe(false);
  });
});

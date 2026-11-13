import { describe, expect, it } from "vitest";
import { projectEngineHealthResponseSchema, projectEngineState } from "./project-engine-health.schema.js";

describe("STORY-090 · project engine health state", () => {
  it.each([
    ["active", "closed", "healthy"],
    ["beta", "closed", "healthy"],
    ["active", "half_open", "degraded"],
    ["degraded", "closed", "degraded"],
    ["degraded", "half_open", "degraded"],
    ["active", "open", "unavailable"],
    ["degraded", "open", "unavailable"],
    ["disabled", "closed", "unavailable"],
  ] as const)("catalog %s with a %s breaker is %s", (status, circuit_state, expected) => {
    expect(projectEngineState({ status, circuit_state })).toBe(expected);
  });

  it("the response is a strict array of {engine_key, state, since}; an empty project is an empty array, and since may be null", () => {
    expect(projectEngineHealthResponseSchema.safeParse([]).success).toBe(true);
    expect(projectEngineHealthResponseSchema.safeParse([{ engine_key: "gemini", state: "healthy", since: null }]).success).toBe(true);
    expect(projectEngineHealthResponseSchema.safeParse([{ engine_key: "gemini", state: "up", since: null }]).success).toBe(false);
    expect(projectEngineHealthResponseSchema.safeParse([{ engine_key: "gemini", state: "healthy", since: null, extra: 1 }]).success).toBe(false);
  });
});

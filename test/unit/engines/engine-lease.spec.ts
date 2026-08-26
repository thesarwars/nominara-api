import { describe, expect, it } from "vitest";
import { configForFromEnv, EngineLeaseConfigError } from "../../../src/lib/engines/engine-lease.js";
import type { EngineTokenBuckets } from "../../../src/config/env.schema.js";

// STORY-031 Phase B — configForFromEnv() adapts the parsed
// ENGINE_TOKEN_BUCKETS env value (D7) into the `configFor` callback
// withEngineLease expects. A MISSING entry is a config defect (never a
// silent default), distinct from D19's store-outage fail-open.

const BUCKETS: EngineTokenBuckets = {
  chatgpt: { capacity: 10, refillPerSecond: 1 },
};

describe("STORY-031 · configForFromEnv", () => {
  it("returns the configured bucket for a present engine key", () => {
    const configFor = configForFromEnv(BUCKETS);
    expect(configFor("chatgpt")).toEqual({ capacity: 10, refillPerSecond: 1 });
  });

  it("throws EngineLeaseConfigError, naming the engine key, when the config is absent", () => {
    const configFor = configForFromEnv(BUCKETS);
    expect(() => configFor("claude")).toThrow(EngineLeaseConfigError);
    expect(() => configFor("claude")).toThrow(/claude/);
  });
});

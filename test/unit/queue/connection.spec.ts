import { describe, expect, it } from "vitest";
import { queueKeyPrefix } from "../../../src/lib/queue/connection.js";

// STORY-030 Phase B — Phase A decision D7: BullMQ's own `prefix` option
// namespaces the whole queue instance per NODE_ENV, so `development`,
// `test`, and `production` processes never collide when pointed at the same
// Valkey deployment.
describe("STORY-030 · queueKeyPrefix", () => {
  it.each(["development", "test", "production"])("derives a distinct, deterministic prefix for NODE_ENV=%s", (nodeEnv) => {
    expect(queueKeyPrefix(nodeEnv)).toBe(`nominara-queue-${nodeEnv}`);
  });

  it("never collides across environments", () => {
    const prefixes = new Set(["development", "test", "production"].map((env) => queueKeyPrefix(env)));
    expect(prefixes.size).toBe(3);
  });
});

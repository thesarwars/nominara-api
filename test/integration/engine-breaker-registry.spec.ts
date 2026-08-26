import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EngineBreakerRegistry } from "../../src/lib/engines/engine-breaker-registry.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-031 Phase D — AC9 ("one engine's breaker opening leaves the others
// capturing", Test scenario 6) and D5 ("breaker state lives in Valkey,
// shared across replicas, survives restart").

const OTHER_FIVE_ACTIVE_ENGINES = ["google_aio", "google_ai_mode", "perplexity", "gemini", "claude"] as const;

describe("STORY-031 · EngineBreakerRegistry — AC9: one engine's breaker open, the other five keep capturing", () => {
  let fixture: ValkeyFixture;
  let redis: Redis;

  beforeAll(async () => {
    fixture = await startValkeyFixture();
    redis = new Redis(fixture.connectionString);
  }, 60_000);

  afterAll(async () => {
    await redis.quit().catch(() => undefined);
    await fixture.stop();
  });

  it("opening chatgpt's breaker via quota_exhausted leaves every other active engine closed and admitting", async () => {
    const registry = new EngineBreakerRegistry(redis);

    await registry.for("chatgpt").recordOutcome("quota_exhausted");
    expect(await registry.for("chatgpt").state()).toBe("open");
    await expect(registry.for("chatgpt").admit()).rejects.toThrow();

    for (const engineKey of OTHER_FIVE_ACTIVE_ENGINES) {
      expect(await registry.for(engineKey).state()).toBe("closed");
      await expect(registry.for(engineKey).admit()).resolves.toBeUndefined();
    }
  });

  it("refuses a disabled engine key (grok) — never silently returns a breaker for a non-dispatching engine", () => {
    const registry = new EngineBreakerRegistry(redis);
    expect(() => registry.for("grok")).toThrow();
  });

  it("refuses an unknown engine key", () => {
    const registry = new EngineBreakerRegistry(redis);
    expect(() => registry.for("not_a_real_engine")).toThrow();
  });
});

describe("STORY-031 · EngineBreakerRegistry — D5: Valkey-shared state across processes, and it survives a restart", () => {
  let fixture: ValkeyFixture;

  beforeAll(async () => {
    fixture = await startValkeyFixture();
  }, 60_000);

  afterAll(async () => {
    await fixture.stop();
  });

  it("process B observes process A's open state for the SAME engine", async () => {
    const redisA = new Redis(fixture.connectionString);
    const redisB = new Redis(fixture.connectionString);
    try {
      const registryA = new EngineBreakerRegistry(redisA);
      const registryB = new EngineBreakerRegistry(redisB);

      expect(await registryB.for("gemini").state()).toBe("closed");

      await registryA.for("gemini").recordOutcome("quota_exhausted");
      expect(await registryA.for("gemini").state()).toBe("open");

      // A DIFFERENT registry instance, never itself called recordOutcome,
      // must observe the SAME open state via the shared Valkey store.
      expect(await registryB.for("gemini").state()).toBe("open");
    } finally {
      await redisA.quit().catch(() => undefined);
      await redisB.quit().catch(() => undefined);
    }
  });

  it("survives a full restart — a brand-new registry (simulating a new process) still reads the persisted open state", async () => {
    const redisA = new Redis(fixture.connectionString);
    try {
      const registryA = new EngineBreakerRegistry(redisA);
      await registryA.for("google_aio").recordOutcome("quota_exhausted");
      expect(await registryA.for("google_aio").state()).toBe("open");
    } finally {
      await redisA.quit().catch(() => undefined);
    }

    // Simulates a process restart: a BRAND NEW connection and a BRAND NEW
    // registry, with no in-memory state carried over from registryA at all.
    const redisC = new Redis(fixture.connectionString);
    try {
      const registryC = new EngineBreakerRegistry(redisC);
      expect(await registryC.for("google_aio").state()).toBe("open");
    } finally {
      await redisC.quit().catch(() => undefined);
    }
  });
});

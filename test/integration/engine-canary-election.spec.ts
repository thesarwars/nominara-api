import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CANARY_INTERVAL_MS, EngineCanary, ValkeyCanaryDueStore, runElectedCanaryRound } from "../../src/lib/engines/canary.js";
import { startValkeyFixture, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-031 Phase F — D9: two replicas race for the SAME 5-minute round via
// `withGlobalQueueLock` (giving locks.ts its first production caller); the
// shared Valkey due-store is what turns "serialized" into "exactly one
// round actually probes" — the loser's turn, once it acquires the lock
// AFTER the winner already ran, sees "not due" and skips.

describe("STORY-031 · runElectedCanaryRound — two replicas, exactly one probe round", () => {
  let container: StartedPostgreSqlContainer;
  let clientA: Client;
  let clientB: Client;
  let valkeyFixture: ValkeyFixture;
  let redis: Redis;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    clientA = new Client({ connectionString: container.getConnectionUri() });
    clientB = new Client({ connectionString: container.getConnectionUri() });
    await clientA.connect();
    await clientB.connect();

    valkeyFixture = await startValkeyFixture();
    redis = new Redis(valkeyFixture.connectionString);
  }, 120_000);

  afterAll(async () => {
    await clientA.end();
    await clientB.end();
    await redis.quit().catch(() => undefined);
    await valkeyFixture.stop();
    await container.stop();
  });

  it("two concurrent replicas contending for the same round → exactly one actually probes", async () => {
    const dueStore = new ValkeyCanaryDueStore(redis);
    let totalProbes = 0;

    const canaryFor = () =>
      new EngineCanary(
        ["chatgpt", "claude"],
        async () => {
          totalProbes += 1;
          return { ok: true, latencyMs: 5 };
        },
        () => undefined,
        dueStore,
        CANARY_INTERVAL_MS,
      );

    async function runOn(client: Client): Promise<boolean> {
      await client.query("BEGIN");
      const ran = await runElectedCanaryRound(client, canaryFor());
      await client.query("COMMIT");
      return ran;
    }

    const [ranA, ranB] = await Promise.all([runOn(clientA), runOn(clientB)]);

    // Exactly one of the two replicas' rounds actually ran.
    expect([ranA, ranB].filter(Boolean)).toHaveLength(1);
    // 2 engines probed exactly once each — never 4 (double-probed).
    expect(totalProbes).toBe(2);
  });

  it("probe failure with no customer traffic still surfaces via onResult — proving detection never depends on customer load", async () => {
    const dueStore = new ValkeyCanaryDueStore(redis);
    const results: Array<{ engineKey: string; ok: boolean }> = [];

    const canary = new EngineCanary(
      ["gemini"],
      async () => ({ ok: false, latencyMs: 12, detail: "vendor changed response shape" }),
      (engineKey, result) => {
        results.push({ engineKey, ok: result.ok });
      },
      dueStore,
      0, // always due for this isolated check
    );

    await clientA.query("BEGIN");
    const ran = await runElectedCanaryRound(clientA, canary);
    await clientA.query("COMMIT");

    expect(ran).toBe(true);
    expect(results).toEqual([{ engineKey: "gemini", ok: false }]);
  });
});

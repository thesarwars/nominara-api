import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { Logger } from "@nestjs/common";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createIdentitySweepUnverifiedHandler } from "../../src/lib/queue/handlers/identity-sweep-unverified.handler.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";
import { handlerFor } from "../../src/lib/queue/handlers.js";
import { UNVERIFIED_ACCOUNT_TTL_DAYS } from "../../src/workers/rollup/unverified-sweep.js";
import type { Env } from "../../src/config/env.schema.js";

// STORY-173 — the daily tick for the stale-unverified-account sweep (owner
// decision, 2026-10-05). The sweep itself is covered by unverified-sweep.spec.ts;
// this is everything that makes it a SCHEDULED JOB: a handler exists, it opens
// the owner connection, it is single-flight across replicas, it is idempotent,
// and what it logs and counts carries no address.
const connectedUrls: string[] = [];
vi.mock("../../src/db/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/db/client.js")>("../../src/db/client.js");
  return {
    ...actual,
    connect: async (url: string) => {
      connectedUrls.push(url);
      return actual.connect(url);
    },
  };
});

const counters: { name: string; labels: Record<string, string> }[] = [];
vi.mock("../../src/lib/telemetry/metrics.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/telemetry/metrics.js")>("../../src/lib/telemetry/metrics.js");
  return {
    ...actual,
    incrementCounter: (name: string, labels: Record<string, string> = {}) => {
      counters.push({ name, labels });
      actual.incrementCounter(name, labels);
    },
  };
});

describe("STORY-173 · identity.sweep_unverified handler", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let env: Env;
  const tick = (): Job => ({ data: {} }) as unknown as Job;
  const noPool = undefined as unknown as Pool;
  const DAY = 24 * 60 * 60 * 1000;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    env = { DATABASE_URL: container.getConnectionUri() } as unknown as Env;
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE users CASCADE");
    counters.length = 0;
    connectedUrls.length = 0;
  });

  async function staleUser(email = `s-${randomUUID()}@corp.example`): Promise<string> {
    const result = await db.query<{ id: string }>(
      "INSERT INTO users (email, status, created_at) VALUES ($1, 'unverified', $2) RETURNING id",
      [email, new Date(Date.now() - (UNVERIFIED_ACCOUNT_TTL_DAYS + 1) * DAY)],
    );
    return result.rows[0]!.id;
  }
  const run = async (): Promise<void> => {
    await createIdentitySweepUnverifiedHandler({ pool: noPool, env })(db, tick());
  };
  const exists = async (id: string): Promise<boolean> => (await db.query("SELECT 1 FROM users WHERE id = $1", [id])).rows.length === 1;

  it("is registered for its queue, so the worker has something to run", () => {
    expect(handlerFor("identity.sweep_unverified")).toBeDefined();
  });

  it("deletes the stale accounts over the OWNER connection, counts the run, and logs counts only", async () => {
    const address = "private.person@corp.example";
    const stale = await staleUser(address);
    const logs: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    expect(await exists(stale)).toBe(false);
    // the owner URL, plus the keepalive options every long-lived job connection carries
    expect(connectedUrls).toHaveLength(1);
    expect(connectedUrls[0]!.startsWith(env.DATABASE_URL)).toBe(true);
    expect(counters.map((c) => c.name)).toEqual(
      expect.arrayContaining(["nominara_identity_unverified_sweep_runs_total", "nominara_identity_unverified_accounts_deleted_total"]),
    );
    const line = logs.find((l) => l.includes("unverified sweep"));
    expect(line).toContain("deleted 1");
    expect(logs.join("\n")).not.toContain(address);
    expect(logs.join("\n")).not.toContain(stale);
  });

  it("is idempotent: a second run finds nothing, and says so without counting a deletion", async () => {
    await staleUser();
    await run();
    counters.length = 0;
    await run();
    expect(counters.map((c) => c.name)).toEqual(["nominara_identity_unverified_sweep_runs_total"]);
  });

  it("yields when another replica holds the lock, deleting nothing", async () => {
    const stale = await staleUser();
    expect(await tryAdvisorySessionLock(db, globalQueueLockKey("identity.sweep_unverified"))).toBe(true);
    try {
      const other = new Client({ connectionString: container.getConnectionUri() });
      await other.connect();
      try {
        const handler = createIdentitySweepUnverifiedHandler({ pool: noPool, env });
        await handler(other, tick());
      } finally {
        await other.end();
      }
      expect(await exists(stale)).toBe(true);
      expect(counters.map((c) => c.name)).toEqual(["nominara_identity_unverified_sweep_yielded_total"]);
    } finally {
      await db.query("SELECT pg_advisory_unlock_all()");
    }
  });
});

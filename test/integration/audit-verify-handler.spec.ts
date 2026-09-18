import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createAuditVerifyHandler } from "../../src/lib/queue/handlers/audit-verify.handler.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";
import type { Env } from "../../src/config/env.schema.js";

// STORY-143 — the tick for `security-and-tenancy.md` §12's daily verifier.
//
// ⚠ THE FIRST TESTS OF THIS JOB IN PRODUCTION SHAPE. `audit-verify.spec.ts`
// covers `verifyAllChains` itself. What was never covered is everything that
// makes it reachable and correct AS A JOB: that a handler exists, that it
// opens the OWNER connection (the pooled role sees zero rows through FORCE
// RLS and would report a clean estate — success, which is the worst possible
// outcome for an integrity check), that it holds the lock, and that a
// detected mismatch pages without failing the job.

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

describe("STORY-143 · audit.verify handler", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let env: Env;
  let workspaceId: string;

  const LOCK_KEY = globalQueueLockKey("audit.verify");
  const tick = (): Job => ({ data: {} }) as unknown as Job;
  const noPool = undefined as unknown as Pool;

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
    await db.query("TRUNCATE audit_log, workspaces CASCADE");
    counters.length = 0;
    connectedUrls.length = 0;
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
  });

  /** Two well-formed, correctly chained rows, written the way production writes them. */
  async function appendChain(count: number): Promise<void> {
    const { AuditChainService } = await import("../../src/modules/audit/audit-chain.service.js");
    const service = new AuditChainService();
    for (let i = 0; i < count; i += 1) {
      await service.append(db, {
        workspaceId,
        actorType: "system",
        actorId: null,
        actorIp: null,
        actorUa: null,
        action: "workspace.updated",
        resourceType: "workspace",
        resourceId: workspaceId,
        beforeState: null,
        afterState: { n: i },
        requestId: randomUUID(),
        supportGrantId: null,
        severity: "info",
      });
    }
  }

  async function run(): Promise<void> {
    await createAuditVerifyHandler({ pool: noPool, env })(db, tick());
  }

  it("verifies an intact chain and reports no mismatch", async () => {
    await appendChain(3);

    const logs: string[] = [];
    const { Logger } = await import("@nestjs/common");
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      await expect(run()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    expect(logs.some((line) => line.includes("no mismatch"))).toBe(true);
    expect(counters.filter((c) => c.name === "audit_chain_mismatch_detected")).toHaveLength(0);
  }, 60_000);

  it("⚠ DETECTS a tampered row, pages, counts it — and does NOT fail the job", async () => {
    // The point of the whole control. A mismatch is a FINDING; throwing would
    // re-walk every chain on every retry, page again identically each time,
    // and then park in the dead-letter queue looking like a broken verifier
    // rather than a detected tamper.
    await appendChain(3);
    // The append-only trigger blocks UPDATE, which is the ordinary-path
    // defence. The chain exists for someone who can get past it, so the test
    // has to get past it too — that is the threat being modelled.
    await db.query("ALTER TABLE audit_log DISABLE TRIGGER USER");
    await db.query("UPDATE audit_log SET action = 'tampered' WHERE seq = (SELECT min(seq) FROM audit_log)");
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER USER");

    const errors: string[] = [];
    const { Logger } = await import("@nestjs/common");
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    try {
      await expect(run()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }

    expect(errors.some((line) => line.includes("audit chain mismatch"))).toBe(true);
    const detected = counters.filter((c) => c.name === "audit_chain_mismatch_detected");
    expect(detected).toHaveLength(1);
    expect(detected[0]!.labels.workspace_id).toBe(workspaceId);
  }, 60_000);

  it("⚠ HOLDS the audit-verify lock while it runs, and frees it after", async () => {
    await appendChain(2);
    const probe = new Client({ connectionString: container.getConnectionUri() });
    await probe.connect();
    try {
      // Before: free. After: free. In between it must have been taken, which
      // the yield test below establishes from the other side.
      expect(await tryAdvisorySessionLock(probe, LOCK_KEY)).toBe(true);
      await probe.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_KEY]);

      await run();

      expect(await tryAdvisorySessionLock(probe, LOCK_KEY)).toBe(true);
    } finally {
      await probe.end();
    }
  }, 60_000);

  it("⚠ YIELDS when another replica holds the lock — verifying nothing, throwing nothing", async () => {
    await appendChain(3);
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    const logs: string[] = [];
    const warns: string[] = [];
    const { Logger } = await import("@nestjs/common");
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(String(m)));
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation((m: unknown) => void warns.push(String(m)));
    try {
      expect(await tryAdvisorySessionLock(other, LOCK_KEY)).toBe(true);

      await expect(run()).resolves.toBeUndefined();

      expect(warns.some((line) => line.includes("yielding"))).toBe(true);
      // It did not walk anything — no verification result was logged.
      expect(logs.some((line) => line.includes("no mismatch"))).toBe(false);
      expect(counters.some((c) => c.name === "audit_verify_yielded_total")).toBe(true);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      await other.end();
    }
  }, 60_000);

  it("⚠ opens the OWNER connection with keepalives — the pooled role would report a clean estate", async () => {
    // `audit_log` carries FORCE ROW LEVEL SECURITY and the verifier's
    // discovery has no workspace filter, so through `nominara_app` it would
    // see zero rows and report success. An integrity check that cannot fail
    // is worse than none, because it is believed.
    await appendChain(2);
    connectedUrls.length = 0;

    await run();

    expect(connectedUrls).toHaveLength(1);
    expect(connectedUrls[0]).toContain("tcp_keepalives_idle%3D60");
    expect(connectedUrls[0]).toContain(new URL(env.DATABASE_URL).host);
  }, 60_000);
});

import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";
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

  it("⚠ DETECTS a tampered row, counts it, and FAILS the job so something notices", async () => {
    // ⚠ THE FIRST VERSION LET THE JOB SUCCEED, on the reasoning that
    // `verifyAllChains` had already paged. It had not: `LoggingPagingNotifier`
    // is a stub (STORY-020-E-4) and `incrementCounter` is a `Logger.log`, so
    // the entire output of a detected tamper was three log lines and a green
    // job — nothing failed, nothing reached a dead-letter queue, nothing a
    // machine watches. The notifier's own header says the calling script's
    // `process.exitCode` was the escalation; moving to a queue removed it.
    //
    // `UnrecoverableError` skips the retry ladder, so this is one walk, one
    // page and one DLQ entry per day rather than a nightly re-walk.
    await appendChain(3);
    // The append-only trigger blocks UPDATE, which is the ordinary-path
    // defence. The chain exists for someone who can get past it, so the test
    // has to get past it too — that is the threat being modelled.
    // The named trigger, not `TRIGGER USER` — `USER` would also switch off
    // migration 0011's marker-forgery guard for the duration, which is a
    // different control and not the one being got past here.
    await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE audit_log SET action = 'tampered' WHERE seq = (SELECT min(seq) FROM audit_log)");
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

    const errors: string[] = [];
    const { Logger } = await import("@nestjs/common");
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    try {
      // ⚠ THE CLASS, NOT ONLY THE MESSAGE — STORY-154. The handler throws
      // `UnrecoverableError` deliberately: it is what makes BullMQ skip the
      // retry ladder, which is what makes this "ONE walk, ONE page and ONE
      // dead-letter entry per day" rather than four of each on a tampered
      // estate. A message-only assertion left that choice untested, so
      // `new UnrecoverableError(...)` could quietly become `new Error(...)`
      // with every gate still green — and the estate would re-walk itself four
      // times per night and page four times, on the one control whose output an
      // operator is meant to trust.
      // ONE run — `run()` increments nominara_audit_chain_mismatch_total, and
      // the assertion below requires exactly one detection.
      const thrown: unknown = await run().then(
        () => null,
        (error: unknown) => error,
      );
      expect(thrown, "the tampered chain did not fail the handler at all").not.toBeNull();
      expect(thrown).toBeInstanceOf(UnrecoverableError);
      expect((thrown as Error).message).toMatch(/audit chain mismatch/);
    } finally {
      spy.mockRestore();
    }

    expect(errors.some((line) => line.includes("audit chain mismatch"))).toBe(true);
    const detected = counters.filter((c) => c.name === "nominara_audit_chain_mismatch_total");
    expect(detected).toHaveLength(1);
    expect(detected[0]!.labels.workspace_id).toBe(workspaceId);
  }, 60_000);

  it("⚠ REFUSES to report clean when it cannot see audit_log at all", async () => {
    // ⚠ THE BRANCH'S OWN HEADLINE FAILURE, and the first version of this spec
    // did not encode it. `audit_log` carries FORCE RLS with a policy only for
    // nominara_app/worker/report, so through the app role — or a plain
    // NOBYPASSRLS owner, which production's migration identity may turn out to
    // be — discovery returns NOTHING and the run reports a clean estate.
    // Reproduced by review: "audit chains verified: no mismatch", byte-identical
    // to a genuinely clean run.
    //
    // Asserting the connection URL cannot catch this: the app role's URL has
    // the same host. Only visibility can.
    await appendChain(2);
    await db.query(`ALTER ROLE nominara_app PASSWORD 'blindtest'`);
    const blindUrl = `postgres://nominara_app:blindtest@${container.getHost()}:${String(container.getMappedPort(5432))}/nominara_test`;

    await expect(
      createAuditVerifyHandler({ pool: noPool, env: { DATABASE_URL: blindUrl } as unknown as Env })(db, tick()),
    ).rejects.toThrow(/neither bypasses row-level security nor is a superuser/);
  }, 60_000);

  it("⚠ an empty estate is clean, not blind", async () => {
    // The guard must not fire on a genuinely fresh deployment, or the first
    // night of every environment is a false alarm and the alarm gets muted.
    await db.query("TRUNCATE audit_log, workspaces CASCADE");

    await expect(run()).resolves.toBeUndefined();
  }, 60_000);

  it("⚠ KEEPS WALKING past the first mismatch, so one bad chain cannot hide the rest", async () => {
    // Stopping estate-wide at the first finding meant that after any single
    // un-remediated mismatch, every workspace after it in an unordered
    // discovery was never verified again — not that night, not any night.
    const second = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W2',$2,'growth')", [
      second,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await appendChain(2);
    const firstWorkspace = workspaceId;
    workspaceId = second;
    await appendChain(2);
    workspaceId = firstWorkspace;

    await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE audit_log SET action = 'tampered' WHERE seq IN (SELECT min(seq) FROM audit_log GROUP BY workspace_id)");
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

    await expect(run()).rejects.toThrow(/2 workspace\(s\)/);
    // Both found, not just whichever discovery happened to return first.
    const detected = counters.filter((c) => c.name === "nominara_audit_chain_mismatch_total");
    expect(detected).toHaveLength(2);
    expect(detected.map((c) => c.labels.workspace_id).sort()).toEqual([firstWorkspace, second].sort());
  }, 60_000);

  describe("⚠ KNOWN GAPS — pinned so they cannot widen unnoticed", () => {
    // These pass CLEAN today and that is the point of asserting them: the
    // daily "no mismatch" line does not mean what a reader would assume, and
    // closing them needs a stored per-workspace high-water mark, which is its
    // own story. If any of these ever starts being detected, these tests fail
    // and someone deletes them deliberately rather than by accident.

    it("does NOT detect tail truncation — the tamper an attacker actually performs", async () => {
      await appendChain(4);
      await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
      await db.query("DELETE FROM audit_log WHERE seq = (SELECT max(seq) FROM audit_log)");
      await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

      await expect(run()).resolves.toBeUndefined();
    }, 60_000);

    it("does NOT detect a whole chain being deleted — the workspace just stops existing to it", async () => {
      await appendChain(3);
      await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
      await db.query("DELETE FROM audit_log");
      await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

      // Reports CLEAN. The workspace still exists and its entire audit history
      // is gone, and this run calls that "no mismatch" — the blindness guard
      // does not catch it, because the role can see fine; there is simply
      // nothing left to see.
      await expect(run()).resolves.toBeUndefined();
    }, 60_000);

    it("DOES detect a missing genesis row, for contrast", async () => {
      await appendChain(3);
      await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
      await db.query("DELETE FROM audit_log WHERE seq = (SELECT min(seq) FROM audit_log)");
      await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

      await expect(run()).rejects.toThrow(/audit chain mismatch/);
    }, 60_000);
  });

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
      expect(counters.some((c) => c.name === "nominara_audit_verify_yielded_total")).toBe(true);
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

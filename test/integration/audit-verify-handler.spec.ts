import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { createAuditVerifyHandler } from "../../src/lib/queue/handlers/audit-verify.handler.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";
import type { Env } from "../../src/config/env.schema.js";
import { EmailAlertAdapter } from "../../src/lib/alerts/email-alert.adapter.js";
import { setAlertEmailerForTests } from "../../src/lib/alerts/alerts.js";

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
    // The marks outlive their workspaces by design (no FK), so they are
    // cleared explicitly.
    await db.query("TRUNCATE audit_log, audit_chain_marks, workspaces CASCADE");
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

  it("Group C · a HANGING alert-email sender is never awaited under the audit.verify lock: the lock is free the moment the sender is entered, and the job still fails with UnrecoverableError", async () => {
    await appendChain(3);
    await db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await db.query("UPDATE audit_log SET action = 'tampered' WHERE seq = (SELECT min(seq) FROM audit_log)");
    await db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

    const probe = new Client({ connectionString: container.getConnectionUri() });
    await probe.connect();
    let lockFreeWhenSenderEntered: boolean | undefined;
    let sends = 0;
    setAlertEmailerForTests(
      new EmailAlertAdapter({
        delivers: true,
        to: "oncall@example.net",
        sender: {
          send: async () => {
            sends += 1;
            if (lockFreeWhenSenderEntered === undefined) {
              // If the page were awaited inside the lock this would be false.
              lockFreeWhenSenderEntered = await tryAdvisorySessionLock(probe, LOCK_KEY);
            }
            await new Promise<void>(() => {}); // hangs forever
          },
        },
      }),
    );
    const { Logger } = await import("@nestjs/common");
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      const started = performance.now();
      const thrown: unknown = await run().then(
        () => null,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(UnrecoverableError);
      expect(sends).toBe(1);
      expect(lockFreeWhenSenderEntered, "the hanging sender was entered while the audit.verify lock was still held").toBe(true);
      // The drain is bounded (5 s): a hung provider cannot hold the job indefinitely either.
      expect(performance.now() - started).toBeLessThan(20_000);
    } finally {
      spy.mockRestore();
      setAlertEmailerForTests(undefined);
      await probe.end();
    }
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
    await db.query("TRUNCATE audit_log, audit_chain_marks, workspaces CASCADE");

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

  describe("STORY-143 AC7 · the high-water mark closes tail truncation and whole-chain deletion", () => {
    // These were pinned as KNOWN GAPS ("does NOT detect tail truncation",
    // "does NOT detect a whole chain being deleted") and asserted `resolves`.
    // They now assert the opposite, against a mark the PREVIOUS run stored:
    // a verifier can only notice what disappeared if something remembers what
    // was there. The first `run()` in each test is that memory being written.

    const disableAppendOnly = () => db.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    const enableAppendOnly = () => db.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");

    async function marks(): Promise<{ max_seq: string | null; reason: string }[]> {
      const result = await db.query<{ max_seq: string | null; reason: string }>(
        "SELECT max_seq::text AS max_seq, reason FROM audit_chain_marks WHERE workspace_id = $1 ORDER BY checked_at, id",
        [workspaceId],
      );
      return result.rows;
    }

    it("STORY-143-AC7a · a clean run appends a `verified` mark at the chain head", async () => {
      await appendChain(3);
      const head = await db.query<{ seq: string }>("SELECT max(seq)::text AS seq FROM audit_log WHERE workspace_id = $1", [workspaceId]);

      await run();

      expect(await marks()).toEqual([{ max_seq: head.rows[0]!.seq, reason: "verified" }]);
    }, 60_000);

    it("STORY-143-AC7b · DETECTS tail truncation — the tamper an attacker actually performs", async () => {
      await appendChain(4);
      await run();
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log WHERE seq = (SELECT max(seq) FROM audit_log)");
      await enableAppendOnly();
      const marksBefore = await marks();

      const thrown: unknown = await run().then(
        () => null,
        (error: unknown) => error,
      );
      // A detected truncation must not become the new baseline.
      expect(await marks()).toEqual(marksBefore);
      expect(thrown, "a truncated chain was reported clean").not.toBeNull();
      expect(thrown).toBeInstanceOf(UnrecoverableError);
      expect((thrown as Error).message).toMatch(/chain_truncated/);
    }, 60_000);

    it("STORY-143-AC7c · DETECTS a whole chain being deleted while the workspace still exists", async () => {
      await appendChain(3);
      await run();
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log");
      await enableAppendOnly();
      const marksBefore = await marks();

      const thrown: unknown = await run().then(
        () => null,
        (error: unknown) => error,
      );
      expect(await marks()).toEqual(marksBefore);
      expect(thrown, "a deleted chain was reported clean").not.toBeNull();
      expect(thrown).toBeInstanceOf(UnrecoverableError);
      expect((thrown as Error).message).toMatch(/chain_missing/);
      expect(counters.filter((c) => c.name === "nominara_audit_chain_mismatch_total")).toHaveLength(1);
    }, 60_000);

    it("STORY-143-AC7d · DETECTS a forged tail whose hashes were recomputed to be self-consistent", async () => {
      // The attacker who can write audit_log can also recompute a row's hash,
      // so the within-chain walk passes. Only the mark remembers what the
      // hash at that position WAS.
      await appendChain(3);
      await run();
      const { readWorkspaceChain } = await import("../../src/modules/audit/audit-log-reader.js");
      const { computeRowHash } = await import("../../src/lib/crypto/audit-chain.js");
      const rows = await readWorkspaceChain(db, workspaceId);
      const last = rows[rows.length - 1]!;
      const { seq: _seq, prev_hash: _prev, row_hash: _hash, ...content } = last;
      const forged = { ...content, after_state: { n: "forged" } };
      const forgedHash = computeRowHash(last.prev_hash, forged);
      await disableAppendOnly();
      await db.query("UPDATE audit_log SET after_state = $2::jsonb, row_hash = $3 WHERE seq = $1", [
        last.seq,
        JSON.stringify(forged.after_state),
        forgedHash,
      ]);
      await enableAppendOnly();
      const marksBefore = await marks();

      const thrown: unknown = await run().then(
        () => null,
        (error: unknown) => error,
      );
      expect(await marks()).toEqual(marksBefore);
      expect(thrown, "a self-consistent forged tail was reported clean").not.toBeNull();
      expect(thrown).toBeInstanceOf(UnrecoverableError);
      expect((thrown as Error).message).toMatch(/mark_hash_mismatch/);
    }, 60_000);

    it("STORY-143-AC7e · DETECTS the marked row being deleted and the chain regrown past it", async () => {
      // max_seq has NOT gone down here, so a check on length alone passes.
      await appendChain(3);
      await run();
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log WHERE seq = (SELECT max(seq) FROM audit_log)");
      await enableAppendOnly();
      await appendChain(2);

      await expect(run()).rejects.toThrow(/mark_hash_mismatch/);
    }, 60_000);

    it("STORY-143-AC7p · compares against the GREATEST mark, not an older one: truncation back to a previously-verified head is still caught", async () => {
      // Two clean runs leave two marks. Truncating to the first run's head
      // satisfies THAT mark exactly, so a verifier that picked the oldest (or
      // any non-greatest) mark would call this clean.
      await appendChain(2);
      await run();
      await appendChain(2);
      await run();
      await disableAppendOnly();
      await db.query(
        "DELETE FROM audit_log WHERE workspace_id = $1 AND seq > (SELECT min(max_seq) FROM audit_chain_marks WHERE workspace_id = $1)",
        [workspaceId],
      );
      await enableAppendOnly();

      await expect(run()).rejects.toThrow(/chain_truncated/);
    }, 60_000);

    it("STORY-143-AC7q · a stale mark committed LATER does not become the baseline (greatest max_seq, not newest row)", async () => {
      // A verifier walking a REPEATABLE READ snapshot can commit its mark after
      // an erasure committed a higher one, leaving the newest-written row as
      // the lower mark. Simulated directly: a lower mark with a later
      // checked_at, then truncation back to that lower head.
      await appendChain(4);
      await run();
      const lowerSeq = await db.query<{ seq: string; row_hash: Buffer }>(
        "SELECT seq::text AS seq, row_hash FROM audit_log WHERE workspace_id = $1 ORDER BY seq LIMIT 1 OFFSET 1",
        [workspaceId],
      );
      await db.query(
        "INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason, checked_at) VALUES ($1, $2::int8, $3, 'verified', now() + interval '1 minute')",
        [workspaceId, lowerSeq.rows[0]!.seq, lowerSeq.rows[0]!.row_hash],
      );
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log WHERE workspace_id = $1 AND seq > $2::int8", [workspaceId, lowerSeq.rows[0]!.seq]);
      await enableAppendOnly();

      await expect(run()).rejects.toThrow(/chain_truncated/);
    }, 60_000);

    it("STORY-143-AC7f · a legitimate erasure rechain passes, and writes a `rechain` mark at the marker row", async () => {
      const { requestIndividualErasure } = await import("../../src/workers/rollup/retention.js");
      const { AuditChainService } = await import("../../src/modules/audit/audit-chain.service.js");
      const user = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
      const userId = user.rows[0]!.id;
      await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'analyst', 'active')", [
        workspaceId,
        userId,
      ]);
      await new AuditChainService().append(db, {
        workspaceId,
        actorType: "user",
        actorId: userId,
        actorIp: null,
        actorUa: null,
        action: "workspace.updated",
        resourceType: "workspace",
        resourceId: workspaceId,
        beforeState: null,
        afterState: { n: 0 },
        requestId: randomUUID(),
        supportGrantId: null,
        severity: "info",
      });
      await appendChain(2);
      await run();

      expect(await requestIndividualErasure(db, userId)).toEqual({ blocked: false });

      const markerSeq = await db.query<{ seq: string }>("SELECT max(seq)::text AS seq FROM audit_log WHERE workspace_id = $1", [workspaceId]);
      const afterErasure = await marks();
      expect(afterErasure[afterErasure.length - 1]).toEqual({ max_seq: markerSeq.rows[0]!.seq, reason: "rechain" });
      await expect(run()).resolves.toBeUndefined();

      // Deleting the marker row afterwards is caught. By the WALK first, not the
      // mark: with the marker gone, the erasure-rewritten rows are no longer in
      // the lenient zone and fail their own hashes. The mark's own contribution
      // is the assertion above — it exists, at the marker's seq.
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log WHERE seq = $1", [markerSeq.rows[0]!.seq]);
      await enableAppendOnly();
      await expect(run()).rejects.toThrow(/audit chain mismatch/);
    }, 60_000);

    // A member with audit rows, so an individual erasure has a chain to rechain.
    async function memberWithAuditRow(): Promise<string> {
      const { AuditChainService } = await import("../../src/modules/audit/audit-chain.service.js");
      const user = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u-${randomUUID()}@example.com`]);
      const userId = user.rows[0]!.id;
      await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'analyst', 'active')", [
        workspaceId,
        userId,
      ]);
      await new AuditChainService().append(db, {
        workspaceId,
        actorType: "user",
        actorId: userId,
        actorIp: null,
        actorUa: null,
        action: "workspace.updated",
        resourceType: "workspace",
        resourceId: workspaceId,
        beforeState: null,
        afterState: { n: 0 },
        requestId: randomUUID(),
        supportGrantId: null,
        severity: "info",
      });
      return userId;
    }

    it("STORY-143-AC7r · an erasure REFUSES to rechain over a truncated chain, so it cannot launder the truncation", async () => {
      const { requestIndividualErasure } = await import("../../src/workers/rollup/retention.js");
      const userId = await memberWithAuditRow();
      await appendChain(4);
      await run();
      const before = await marks();
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log WHERE workspace_id = $1 AND seq > (SELECT max(seq) - 2 FROM audit_log WHERE workspace_id = $1)", [
        workspaceId,
      ]);
      await enableAppendOnly();
      const rowsBefore = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_log WHERE workspace_id = $1", [workspaceId]);

      await expect(requestIndividualErasure(db, userId)).rejects.toThrow(/chain_truncated|mark_hash_mismatch/);

      // Nothing was written: no marker row, no `rechain` mark, and the verifier still sees the truncation.
      const rowsAfter = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_log WHERE workspace_id = $1", [workspaceId]);
      expect(rowsAfter.rows[0]!.n).toBe(rowsBefore.rows[0]!.n);
      expect(await marks()).toEqual(before);
      await expect(run()).rejects.toThrow(/chain_truncated/);
    }, 60_000);

    it("STORY-143-AC7s · the verifier checks EVERY mark: a `rechain` mark forged over a truncation does not wash it out", async () => {
      // The erasure guard is not the only line of defence — an actor with owner
      // access can write the marker row and the `rechain` mark by hand. The
      // old `verified` mark still says its row existed.
      const { AuditChainService } = await import("../../src/modules/audit/audit-chain.service.js");
      const { RECHAINED_MARKER_ACTION } = await import("../../src/lib/crypto/audit-chain.js");
      await appendChain(5);
      await run();
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log WHERE workspace_id = $1 AND seq > (SELECT max(seq) - 2 FROM audit_log WHERE workspace_id = $1)", [
        workspaceId,
      ]);
      await enableAppendOnly();
      await new AuditChainService().append(db, {
        workspaceId,
        actorType: "system",
        actorId: "00000000-0000-0000-0000-000000000000",
        actorIp: null,
        actorUa: null,
        action: RECHAINED_MARKER_ACTION,
        resourceType: "audit_log",
        resourceId: null,
        beforeState: null,
        afterState: { reason: "individual_erasure" },
        requestId: `forged-${workspaceId}`,
        supportGrantId: null,
        severity: "notice",
      });
      await db.query(
        `INSERT INTO audit_chain_marks (workspace_id, max_seq, row_hash, reason)
           SELECT workspace_id, seq, row_hash, 'rechain' FROM audit_log WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1`,
        [workspaceId],
      );

      await expect(run()).rejects.toThrow(/chain_truncated|mark_hash_mismatch/);
    }, 60_000);

    it("STORY-143-AC7g · a hard-deleted workspace leaves a tombstone, so its vanished chain is expected", async () => {
      const { executeWorkspaceHardDelete } = await import("../../src/workers/rollup/retention.js");
      await appendChain(3);
      await run();

      await executeWorkspaceHardDelete(db, workspaceId, { exportComplianceRecords: async () => undefined });

      expect((await marks()).map((m) => m.reason)).toContain("tombstone");
      await expect(run()).resolves.toBeUndefined();
    }, 60_000);

    it("STORY-143-AC7h · a workspace with no audit history and no mark is not a finding", async () => {
      // Fresh workspace, never audited: nothing was ever promised.
      await expect(run()).resolves.toBeUndefined();
      expect(await marks()).toEqual([]);
    }, 60_000);

    it("STORY-143-AC7i · RESIDUAL, pinned: a chain deleted before any run ever marked it is still invisible", async () => {
      // The mark can only remember what a run saw. Closing this needs the
      // Object Lock export (decisions-2026-10-13: compare against it "later").
      await appendChain(3);
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log");
      await enableAppendOnly();

      await expect(run()).resolves.toBeUndefined();
    }, 60_000);

    it("DOES detect a missing genesis row, for contrast", async () => {
      await appendChain(3);
      await disableAppendOnly();
      await db.query("DELETE FROM audit_log WHERE seq = (SELECT min(seq) FROM audit_log)");
      await enableAppendOnly();

      await expect(run()).rejects.toThrow(/audit chain mismatch/);
    }, 60_000);

    it("STORY-143-AC7j · a mismatched chain writes NO new mark", async () => {
      await appendChain(3);
      await run();
      await disableAppendOnly();
      await db.query("UPDATE audit_log SET action = 'tampered' WHERE seq = (SELECT min(seq) FROM audit_log)");
      await enableAppendOnly();
      const before = await marks();

      await expect(run()).rejects.toThrow(/audit chain mismatch/);

      expect(await marks()).toEqual(before);
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

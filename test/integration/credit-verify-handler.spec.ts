import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { UnrecoverableError, type Job } from "bullmq";
import { Client, type ClientBase, type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/config/env.schema.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { provisionWalletWithGrant } from "../../src/lib/credits/balance.js";
import { createCreditVerifyHandler } from "../../src/lib/queue/handlers/credit-verify.handler.js";
import { globalQueueLockKey, tryAdvisorySessionLock } from "../../src/lib/queue/locks.js";

// STORY-073 AC4, scenarios 5 and 6 - `credit.verify` as a JOB, against a real database. The unit spec pins the wiring with
// fakes; what a fake cannot prove is that the handler (a) sees every workspace, (b) finds a deliberate discrepancy and fails the job,
// (c) holds the single-flight lock, and (d) corrects NOTHING (scenario 7: the system never rewrites a balance).

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

describe("STORY-073 AC4 · credit.verify handler", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let env: Env;
  const tick = (): Job => ({ data: {} }) as unknown as Job;
  const noPool = undefined as unknown as Pool;
  const run = async (): Promise<void> => {
    await createCreditVerifyHandler({ pool: noPool, env })(db, tick());
  };

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
    await db.query("ALTER TABLE credit_ledger DISABLE TRIGGER USER");
    await db.query("TRUNCATE credit_ledger, credit_wallets, workspaces CASCADE");
    await db.query("ALTER TABLE credit_ledger ENABLE TRIGGER USER");
    counters.length = 0;
  });

  async function workspaceWithWallet(grant: number): Promise<string> {
    const id = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key) VALUES ($1,'W',$2,'growth')", [id, `w-${randomUUID().slice(0, 8)}`]);
    await db.query("BEGIN");
    try {
      await provisionWalletWithGrant(db as ClientBase, id, grant, { start: "2026-09-01", end: "2026-10-01" });
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
    return id;
  }

  it("scenario 5 · a healthy estate (several workspaces) verifies clean: the job resolves and counts a run", async () => {
    await workspaceWithWallet(100);
    await workspaceWithWallet(250);
    await expect(run()).resolves.toBeUndefined();
    expect(counters.map((c) => c.name)).toContain("nominara_credit_wallet_verify_runs_total");
    expect(counters.map((c) => c.name)).not.toContain("nominara_credit_wallet_mismatch_total");
  }, 60_000);

  it("scenario 6 · a deliberate discrepancy FAILS the job with UnrecoverableError naming the workspace, and counts and logs it", async () => {
    await workspaceWithWallet(100);
    const bad = await workspaceWithWallet(100);
    await db.query("UPDATE credit_wallets SET included_balance = 90 WHERE workspace_id = $1", [bad]);

    const errors: string[] = [];
    const { Logger } = await import("@nestjs/common");
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    try {
      const thrown: unknown = await run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(thrown).toBeInstanceOf(UnrecoverableError);
      expect((thrown as Error).message).toContain(bad);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join("\n")).toContain(bad);
    expect(counters.filter((c) => c.name === "nominara_credit_wallet_mismatch_total")).toHaveLength(1);
  }, 60_000);

  it("scenario 7 · it corrects NOTHING: the diverged wallet and the ledger are byte-for-byte what they were", async () => {
    const bad = await workspaceWithWallet(100);
    await db.query("UPDATE credit_wallets SET included_balance = 90 WHERE workspace_id = $1", [bad]);
    const snapshot = async (): Promise<string> =>
      JSON.stringify([
        (await db.query("SELECT * FROM credit_wallets WHERE workspace_id = $1", [bad])).rows,
        (await db.query("SELECT * FROM credit_ledger WHERE workspace_id = $1 ORDER BY seq", [bad])).rows,
      ]);
    const before = await snapshot();
    const { Logger } = await import("@nestjs/common");
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    try {
      await run().catch(() => undefined);
    } finally {
      spy.mockRestore();
    }
    expect(await snapshot()).toBe(before);
  }, 60_000);

  it("holds the single-flight lock: another session holding it makes the tick yield without verifying anything", async () => {
    const bad = await workspaceWithWallet(100);
    await db.query("UPDATE credit_wallets SET included_balance = 90 WHERE workspace_id = $1", [bad]);
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      expect(await tryAdvisorySessionLock(holder, globalQueueLockKey("credit.verify"))).toBe(true);
      const { Logger } = await import("@nestjs/common");
      const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      try {
        await expect(run()).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
      expect(counters.map((c) => c.name)).toContain("nominara_credit_wallet_verify_yielded_total");
      expect(counters.map((c) => c.name)).not.toContain("nominara_credit_wallet_mismatch_total");
    } finally {
      await holder.end();
    }
  }, 60_000);

  it("the lock is free again after a run, clean or failed", async () => {
    await workspaceWithWallet(10);
    await run();
    const probe = new Client({ connectionString: container.getConnectionUri() });
    await probe.connect();
    try {
      expect(await tryAdvisorySessionLock(probe, globalQueueLockKey("credit.verify"))).toBe(true);
    } finally {
      await probe.end();
    }
  }, 60_000);
});

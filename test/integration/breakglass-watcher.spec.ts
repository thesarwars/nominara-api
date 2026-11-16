import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { BREAKGLASS_ALERT_NAME, BREAKGLASS_AUDIT_ACTION, PLATFORM_AUDIT_WORKSPACE_ID, readBreakglassSessions, recordBreakglassLogin } from "../../src/lib/queue/breakglass-monitor.js";
import { MonitorRuntime, type MonitorState, type MonitorStateStore } from "../../src/lib/queue/monitor-runtime.js";

// STORY-010 AC2 / decision 107(a) — NOT RUN by the author (no docker in that session); the coordinator runs it.
// Proves against real Postgres: nominara_worker can see a nominara_breakglass session in pg_stat_activity (pid and usename;
// backend_start may be null for another role's session and the code accepts that), the audit row lands on the platform
// chain under RLS as the worker role, and a second tick neither re-alerts nor re-audits.

describe("STORY-010-AC2 · break-glass watcher against real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let owner: Client;
  let workerPool: Pool;
  let breakglass: Client;

  const urlAs = (role: string) => {
    const u = new URL(container.getConnectionUri());
    u.username = role;
    u.password = "pw";
    return u.toString();
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    owner = new Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
    await migrateUp(owner);
    await owner.query("ALTER ROLE nominara_worker PASSWORD 'pw'");
    await owner.query("ALTER ROLE nominara_breakglass PASSWORD 'pw'");
    workerPool = new Pool({ connectionString: urlAs("nominara_worker"), max: 3 });
    breakglass = new Client({ connectionString: urlAs("nominara_breakglass") });
    await breakglass.connect();
  }, 180_000);

  afterAll(async () => {
    await breakglass.end().catch(() => undefined);
    await workerPool.end();
    await owner.end();
    await container.stop();
  });

  it("STORY-010-AC2 · the worker role sees the break-glass session", async () => {
    const client = await workerPool.connect();
    try {
      const sessions = await readBreakglassSessions(client);
      expect(sessions).toHaveLength(1);
    } finally {
      client.release();
    }
  });

  it("STORY-010-AC2 · the audit row is writable by nominara_worker on the platform chain, and is immutable", async () => {
    const client = await workerPool.connect();
    try {
      await client.query("BEGIN");
      await recordBreakglassLogin(client, { pid: 1, backendStartMs: 1 }, "it-1");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const rows = await owner.query("SELECT action, severity, actor_type FROM audit_log WHERE workspace_id = $1", [PLATFORM_AUDIT_WORKSPACE_ID]);
    expect(rows.rows).toEqual([{ action: BREAKGLASS_AUDIT_ACTION, severity: "critical", actor_type: "system" }]);
    const worker = await workerPool.connect();
    try {
      await worker.query("BEGIN");
      await worker.query("SELECT set_config('app.current_workspace_id', $1, true)", [PLATFORM_AUDIT_WORKSPACE_ID]);
      await expect(worker.query("UPDATE audit_log SET severity = 'info'")).rejects.toThrow();
      await worker.query("ROLLBACK");
    } finally {
      worker.release();
    }
  });

  it("STORY-010-AC2 · two ticks over one live session: one alert and one audit row for it", async () => {
    let stored: MonitorState | null = null;
    const store: MonitorStateStore = { load: async () => stored, save: async (s) => void (stored = s) };
    const pages: Array<Record<string, unknown>> = [];
    const runtime = new MonitorRuntime({
      pool: workerPool,
      store,
      readDlqDepths: async () => new Map(),
      readLastSuccess: async () => new Map(),
      engines: [],
      pager: { page: (_m, c) => void pages.push(c) },
      readBreakglassSessions,
      recordBreakglassLogin,
    });
    await runtime.tick();
    await runtime.tick();
    expect(pages.filter((p) => p.alertName === BREAKGLASS_ALERT_NAME)).toHaveLength(1);
    const rows = await owner.query("SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1 AND request_id LIKE 'breakglass-login:%'", [PLATFORM_AUDIT_WORKSPACE_ID]);
    expect(rows.rows[0].n).toBe(2); // the "it-1" row from the previous test plus this session's single row
  });
});

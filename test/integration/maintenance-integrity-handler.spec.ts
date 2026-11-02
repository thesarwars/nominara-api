import { createHash } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type Pool } from "pg";
import { UnrecoverableError, type Job } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { createMaintenanceIntegrityHandler } from "../../src/lib/queue/handlers/maintenance-integrity.handler.js";
import { setAlertEmailerForTests } from "../../src/lib/alerts/alerts.js";
import { PURGE_FAILURE_GRACE_DAYS } from "../../src/db/purge-check.js";
import { VECTOR_RECALL_THRESHOLD } from "../../src/db/conventions.js";
import { globalQueueLockKey } from "../../src/lib/queue/locks.js";
import type { Env } from "../../src/config/env.schema.js";

// STORY-013 AC6 / AC14 / AC16 — the nightly integrity tick (`maintenance.integrity`). D4 infrastructure is parked (decision
// 45): no pager and no release pipeline exist, so what is proven here is the code-side hook those will call later — a metric,
// a structured error log, an alert email (a no-op until ALERT_EMAIL_TO is set) and, for the two paging conditions, a FAILED
// job (UnrecoverableError, so one page per night rather than a retry ladder).

const metrics: { name: string; value: number; labels: Record<string, unknown> }[] = [];
vi.mock("../../src/lib/telemetry/metrics.js", () => ({
  incrementCounter: (name: string, labels: Record<string, unknown> = {}) => void metrics.push({ name, value: 1, labels }),
  observeValue: (name: string, value: number, labels: Record<string, unknown> = {}) => void metrics.push({ name, value, labels }),
}));

describe("STORY-013 · maintenance.integrity handler (nightly orphan scan, purge-failure check, vector recall check)", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let env: Env;
  let seq = 0;
  const alerts: { message: string; context: Record<string, unknown> }[] = [];

  const tick = (): Job => ({ data: {} }) as unknown as Job;
  const noPool = undefined as unknown as Pool;
  const run = async (): Promise<void> => {
    await createMaintenanceIntegrityHandler({ pool: noPool, env })(db, tick());
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db, MIGRATIONS_DIR);
    env = { DATABASE_URL: container.getConnectionUri() } as unknown as Env;
  }, 300_000);

  afterAll(async () => {
    setAlertEmailerForTests(undefined);
    await db.end();
    await container.stop();
  });

  afterEach(() => {
    metrics.length = 0;
    alerts.length = 0;
    vi.restoreAllMocks();
  });

  function captureAlerts(): void {
    const fake = {
      page: (message: string, context: Record<string, unknown>) => void alerts.push({ message, context }),
      notify: (message: string, context: Record<string, unknown>) => {
        alerts.push({ message, context });
        return Promise.resolve();
      },
      drain: () => Promise.resolve(),
    };
    setAlertEmailerForTests(fake as never);
  }

  async function captureErrorLogs<T>(fn: () => Promise<T>): Promise<{ lines: string[]; result: PromiseSettledResult<T> }> {
    const { Logger } = await import("@nestjs/common");
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => void lines.push(JSON.stringify(m)));
    try {
      const [result] = await Promise.allSettled([fn()]);
      return { lines, result };
    } finally {
      spy.mockRestore();
    }
  }

  async function workspaceAndProject(): Promise<{ workspaceId: string; projectId: string }> {
    seq += 1;
    const ws = await db.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id", [
      `Integrity Secret Name ${seq}`,
      `integ-${seq}-${Math.random().toString(36).slice(2)}`,
    ]);
    const pr = await db.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, 'https://example.com', 'example.com') RETURNING id",
      [ws.rows[0]!.id, `P ${seq}`, `p-${seq}-${Math.random().toString(36).slice(2)}`],
    );
    return { workspaceId: ws.rows[0]!.id, projectId: pr.rows[0]!.id };
  }

  async function insertOrphanMention(workspaceId: string, projectId: string): Promise<void> {
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          entity_type, entity_label, matched_alias, occurrence_index, char_start, char_end,
          first_token_index, prominence, sentiment_label, sentiment_score, sentiment_confidence, sentiment_method)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'chatgpt', now(),
               'brand', 'Acme', 'acme', 0, 0, 4, 0, 0.5, 'neutral', 0, 1, 'heuristic')`,
      [workspaceId, projectId],
    );
  }

  function spreadLiteral(seed: number): string {
    let state = (seed >>> 0) || 1;
    const values = Array.from({ length: 1536 }, () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return (state / 0xffffffff) * 2 - 1;
    });
    return `[${values.join(",")}]`;
  }

  async function insertPrompts(workspaceId: string, projectId: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      seq += 1;
      await db.query(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, embedding)
         VALUES ($1, $2, $3, $4, 'recommendation', 'awareness', $5::halfvec)`,
        [workspaceId, projectId, `prompt ${seq}`, createHash("sha256").update(`ph-${seq}`).digest(), spreadLiteral(seq)],
      );
    }
  }

  const indexOid = async (): Promise<string> =>
    (await db.query<{ oid: string }>("SELECT oid::text FROM pg_class WHERE relname = 'ix_prompts_embedding'")).rows[0]!.oid;

  it("AC14 · a clean estate passes, and the orphan metric is an explicit 0 rather than absent", async () => {
    captureAlerts();
    await expect(run()).resolves.toBeUndefined();

    const orphan = metrics.filter((m) => m.name === "nominara_maintenance_orphan_fact_rows");
    expect(orphan).toHaveLength(1);
    expect(orphan[0]!.value).toBe(0);
    expect(alerts).toEqual([]);
  }, 60_000);

  it("AC14 / T12 · a fact row without its parent PAGES: metric, redacted error log, alert, and an UnrecoverableError", async () => {
    captureAlerts();
    const { workspaceId, projectId } = await workspaceAndProject();
    await insertOrphanMention(workspaceId, projectId);

    const { lines, result } = await captureErrorLogs(run);

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(UnrecoverableError);
    expect(String((result as PromiseRejectedResult).reason)).toMatch(/orphan fact row/);

    const orphan = metrics.filter((m) => m.name === "nominara_maintenance_orphan_fact_rows");
    expect(orphan.reduce((sum, m) => sum + m.value, 0)).toBe(1);
    expect(metrics.some((m) => m.name === "nominara_maintenance_integrity_findings_total" && m.labels.check === "orphan_facts")).toBe(true);

    expect(lines.some((l) => l.includes("orphan") && l.includes("mention_facts"))).toBe(true);
    expect(alerts.some((a) => a.context.alertName === "maintenance_orphan_facts")).toBe(true);
    // Counts and table/partition names only — never a workspace NAME or row content.
    const everything = JSON.stringify([lines, alerts]);
    expect(everything).not.toContain("Integrity Secret Name");
    expect(everything).not.toContain("Acme");
  }, 60_000);

  it("AC16 · a purge failure still inside the grace window ALERTS but does not fail the job", async () => {
    captureAlerts();
    await db.query("DELETE FROM mention_facts"); // the orphan from the previous case is not what this one is about
    await db.query(
      "INSERT INTO purge_failures (scope, scope_id, reason) VALUES ('project', '44444444-4444-4444-4444-444444444444', 'secret reason text')",
    );

    await expect(run()).resolves.toBeUndefined();

    const unresolved = metrics.filter((m) => m.name === "nominara_retention_purge_failures_unresolved");
    expect(unresolved.at(-1)!.value).toBe(1);
    expect(alerts.some((a) => a.context.alertName === "retention_purge_failure_unresolved")).toBe(true);
    expect(JSON.stringify(alerts)).not.toContain("secret reason text");
  }, 60_000);

  it("AC16 / T14 · a purge failure unresolved past the 7-day grace window fails the job (the release-train block's runtime hook)", async () => {
    captureAlerts();
    await db.query(
      `UPDATE purge_failures SET failed_at = now() - make_interval(days => $1)
        WHERE scope_id = '44444444-4444-4444-4444-444444444444'`,
      [PURGE_FAILURE_GRACE_DAYS + 1],
    );

    const { lines, result } = await captureErrorLogs(run);

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(UnrecoverableError);
    expect(String((result as PromiseRejectedResult).reason)).toMatch(/purge failure/);
    expect(metrics.some((m) => m.name === "nominara_maintenance_integrity_findings_total" && m.labels.check === "purge_failures_blocking")).toBe(true);
    expect(lines.some((l) => l.includes("44444444-4444-4444-4444-444444444444"))).toBe(true);
    expect(JSON.stringify([lines, alerts])).not.toContain("secret reason text");
  }, 60_000);

  it("AC16 · resolving the failure clears the page", async () => {
    await db.query("UPDATE purge_failures SET resolved_at = now(), resolved_by = NULL WHERE resolved_at IS NULL");
    await expect(run()).resolves.toBeUndefined();
    expect(metrics.filter((m) => m.name === "nominara_retention_purge_failures_unresolved").at(-1)!.value).toBe(0);
  }, 60_000);

  it("AC14 · one check failing does not skip the others: an orphan AND a blocking purge failure are both reported", async () => {
    captureAlerts();
    const { workspaceId, projectId } = await workspaceAndProject();
    await insertOrphanMention(workspaceId, projectId);
    await db.query(
      `INSERT INTO purge_failures (scope, scope_id, reason, failed_at)
       VALUES ('workspace', '55555555-5555-5555-5555-555555555555', 'x', now() - interval '30 days')`,
    );

    const { result } = await captureErrorLogs(run);
    expect(result.status).toBe("rejected");
    const checks = metrics.filter((m) => m.name === "nominara_maintenance_integrity_findings_total").map((m) => m.labels.check);
    expect(checks).toEqual(expect.arrayContaining(["orphan_facts", "purge_failures_blocking"]));

    await db.query("DELETE FROM mention_facts");
    await db.query("UPDATE purge_failures SET resolved_at = now(), resolved_by = NULL WHERE resolved_at IS NULL");
  }, 60_000);

  it("AC6 · a vector index with too few rows to measure is SKIPPED (no recall observation, no alert): null is not 0", async () => {
    captureAlerts();
    await expect(run()).resolves.toBeUndefined();
    expect(metrics.filter((m) => m.name === "nominara_maintenance_vector_recall_ratio")).toEqual([]);
    expect(metrics.some((m) => m.name === "nominara_maintenance_vector_recall_skipped_total" && m.labels.table === "tracked_prompts")).toBe(true);
    expect(alerts).toEqual([]);
  }, 60_000);

  it("AC6 / T7 · recall measured at or above the threshold is observed and raises nothing", async () => {
    captureAlerts();
    const { workspaceId, projectId } = await workspaceAndProject();
    await insertPrompts(workspaceId, projectId, 12);

    await expect(run()).resolves.toBeUndefined();

    const recall = metrics.filter((m) => m.name === "nominara_maintenance_vector_recall_ratio" && m.labels.table === "tracked_prompts");
    expect(recall).toHaveLength(1);
    expect(recall[0]!.value).toBeGreaterThanOrEqual(VECTOR_RECALL_THRESHOLD);
    expect(alerts.some((a) => a.context.alertName === "maintenance_vector_recall_below_threshold")).toBe(false);
  }, 120_000);

  it("AC6 / T7 · recall DEGRADED below the real 0.98 threshold alerts and flags the index for rebuild, WITHOUT running the rebuild on the nightly tick", async () => {
    captureAlerts();
    const { workspaceId, projectId } = await workspaceAndProject();
    await insertPrompts(workspaceId, projectId, 400);
    const before = await indexOid();

    // New sessions inherit these, so the handler's own connection sees a starved HNSW search (see partition-maintenance.spec T7).
    await db.query("ALTER DATABASE nominara_test SET hnsw.ef_search = 1");
    await db.query("ALTER DATABASE nominara_test SET enable_seqscan = off");
    try {
      const { lines, result } = await captureErrorLogs(run);
      expect(result.status).toBe("fulfilled");

      const recall = metrics.find((m) => m.name === "nominara_maintenance_vector_recall_ratio" && m.labels.table === "tracked_prompts");
      expect(recall!.value).toBeLessThan(VECTOR_RECALL_THRESHOLD);
      expect(metrics.some((m) => m.name === "nominara_maintenance_integrity_findings_total" && m.labels.check === "vector_recall")).toBe(true);
      expect(lines.some((l) => l.includes("ix_prompts_embedding"))).toBe(true);
      expect(alerts.some((a) => a.context.alertName === "maintenance_vector_recall_below_threshold")).toBe(true);

      // Read-only: the index was neither altered nor rebuilt (a REINDEX CONCURRENTLY swaps the relation's oid).
      expect(await indexOid()).toBe(before);
    } finally {
      await db.query("ALTER DATABASE nominara_test RESET hnsw.ef_search");
      await db.query("ALTER DATABASE nominara_test RESET enable_seqscan");
    }
  }, 180_000);

  it("yields without doing any work when another replica holds the tick's lock", async () => {
    const holder = new Client({ connectionString: container.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [globalQueueLockKey("maintenance.integrity")]);
      await expect(run()).resolves.toBeUndefined();
      expect(metrics.some((m) => m.name === "nominara_maintenance_integrity_yielded_total")).toBe(true);
      expect(metrics.some((m) => m.name === "nominara_maintenance_orphan_fact_rows")).toBe(false);
    } finally {
      await holder.end();
    }
  }, 60_000);
});

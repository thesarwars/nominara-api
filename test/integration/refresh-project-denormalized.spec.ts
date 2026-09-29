import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { refreshProjectAux } from "../../src/lib/rollup/refresh-project-aux.js";
import { refreshProjectSourceCoverage } from "../../src/lib/rollup/refresh-project-source-coverage.js";
import { refreshProjectTaskCounts } from "../../src/lib/rollup/refresh-project-task-counts.js";

// STORY-169 — the three producers `denormalizeProject` deliberately does not
// own: `refreshProjectAux`, `refreshProjectTaskCounts` and
// `refreshProjectSourceCoverage`. Each reads a different table and writes a
// different slice of `projects`, so each gets its own scenario set here
// rather than sharing `rollup-metric-daily.spec.ts`'s metric_daily fixtures.

describe("STORY-169 · the three non-metric project-refresh producers", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  async function setUp(): Promise<void> {
    await db.query(
      "TRUNCATE tasks, aux_findings, aux_audits, aux_rule_catalog, project_source_index, source_domains, projects, workspaces CASCADE",
    );
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'HubSpot',$3,'https://hubspot.com','hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  }

  beforeEach(async () => {
    await setUp();
  });

  async function projectRow(): Promise<{
    aux_score_current: string | null;
    open_task_count: number;
    open_tasks_by_severity: { critical: number; high: number; medium: number; low: number };
    source_coverage: string | null;
  }> {
    const result = await db.query(
      "SELECT aux_score_current::text, open_task_count, open_tasks_by_severity, source_coverage::text FROM projects WHERE id = $1",
      [projectId],
    );
    return result.rows[0];
  }

  // ---------------------------------------------------------------------
  // refreshProjectAux
  // ---------------------------------------------------------------------

  describe("refreshProjectAux", () => {
    it("is NULL when the project has no aux_audits row at all", async () => {
      await refreshProjectAux(db, projectId);
      expect((await projectRow()).aux_score_current).toBeNull();
    });

    async function addAudit(over: { status: string; auxScore: number | null; finishedAt: string | null }): Promise<void> {
      await db.query(
        `INSERT INTO aux_audits
           (id, workspace_id, project_id, trigger, scope, target_urls, aux_score, status, rule_version, tokenizer, finished_at)
         VALUES ($1,$2,$3,'manual','key_pages','{}',$4,$5,'v1','t1',$6::timestamptz)`,
        [randomUUID(), workspaceId, projectId, over.auxScore, over.status, over.finishedAt],
      );
    }

    it("takes the latest COMPLETED audit's score, not a newer queued one", async () => {
      await addAudit({ status: "completed", auxScore: 61.2, finishedAt: "2026-08-01T00:00:00Z" });
      await addAudit({ status: "completed", auxScore: 74.5, finishedAt: "2026-08-15T00:00:00Z" });
      // Newer than both, but not completed — must not win.
      await addAudit({ status: "queued", auxScore: null, finishedAt: null });

      await refreshProjectAux(db, projectId);
      expect(Number((await projectRow()).aux_score_current)).toBeCloseTo(74.5, 3);
    });

    it("ignores a failed or partial audit even if it is the most recent", async () => {
      await addAudit({ status: "completed", auxScore: 50, finishedAt: "2026-08-01T00:00:00Z" });
      await addAudit({ status: "failed", auxScore: null, finishedAt: "2026-08-20T00:00:00Z" });

      await refreshProjectAux(db, projectId);
      expect(Number((await projectRow()).aux_score_current)).toBeCloseTo(50, 3);
    });
  });

  // ---------------------------------------------------------------------
  // refreshProjectTaskCounts
  // ---------------------------------------------------------------------

  describe("refreshProjectTaskCounts", () => {
    async function addFinding(severity: string): Promise<string> {
      await db.query(
        `INSERT INTO aux_rule_catalog (code, category, title, description, rationale, severity_default, weight, rule_version)
         VALUES ('AUX-R-TEST','structured_data','t','d','r',$1,0.1,'v1')
         ON CONFLICT (code) DO NOTHING`,
        [severity],
      );
      const auditId = randomUUID();
      await db.query(
        `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, status, rule_version, tokenizer)
         VALUES ($1,$2,$3,'manual','key_pages','{}','completed','v1','t1')`,
        [auditId, workspaceId, projectId],
      );
      const findingId = randomUUID();
      await db.query(
        `INSERT INTO aux_findings
           (id, workspace_id, project_id, audit_id, rule_code, severity, fingerprint, title, evidence, rule_version)
         VALUES ($1,$2,$3,$4,'AUX-R-TEST',$5,sha256(random()::text::bytea),'t','{}'::jsonb,'v1')`,
        [findingId, workspaceId, projectId, auditId, severity],
      );
      return findingId;
    }

    async function addDomainWithGap(gapSeverity: string): Promise<string> {
      const domainId = randomUUID();
      await db.query(
        `INSERT INTO source_domains (id, workspace_id, domain) VALUES ($1,$2,$3)`,
        [domainId, workspaceId, `${gapSeverity}-${domainId.slice(0, 8)}.example`],
      );
      await db.query(
        `INSERT INTO project_source_index
           (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight, gap_severity)
         VALUES ($1,$2,$3,'all','2026-08-01',30,0.1,$4)`,
        [workspaceId, projectId, domainId, gapSeverity],
      );
      return domainId;
    }

    async function addTask(over: {
      status?: string;
      deletedAt?: string | null;
      sourceFindingId?: string | null;
      sourceDomainId?: string | null;
    }): Promise<void> {
      await db.query(
        `INSERT INTO tasks
           (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description,
            status, source_finding_id, source_domain_id, deleted_at)
         VALUES ($1,$2,$3,$4,'technical',sha256(random()::text::bytea),'t','d',$5,$6,$7,$8::timestamptz)`,
        [
          randomUUID(),
          workspaceId,
          projectId,
          `T-${randomUUID().slice(0, 8)}`,
          over.status ?? "todo",
          over.sourceFindingId ?? null,
          over.sourceDomainId ?? null,
          over.deletedAt ?? null,
        ],
      );
    }

    it("is all zero with no tasks at all", async () => {
      await refreshProjectTaskCounts(db, projectId);
      const row = await projectRow();
      expect(row.open_task_count).toBe(0);
      expect(row.open_tasks_by_severity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    });

    it("derives severity from aux_findings.severity via source_finding_id, and from project_source_index.gap_severity via source_domain_id", async () => {
      const criticalFinding = await addFinding("critical");
      const highGapDomain = await addDomainWithGap("high");
      await addTask({ sourceFindingId: criticalFinding });
      await addTask({ sourceDomainId: highGapDomain });

      await refreshProjectTaskCounts(db, projectId);
      const row = await projectRow();
      expect(row.open_task_count).toBe(2);
      expect(row.open_tasks_by_severity).toEqual({ critical: 1, high: 1, medium: 0, low: 0 });
    });

    it("prefers the finding's severity when a task somehow carries both links", async () => {
      const criticalFinding = await addFinding("critical");
      const lowGapDomain = await addDomainWithGap("low");
      await addTask({ sourceFindingId: criticalFinding, sourceDomainId: lowGapDomain });

      await refreshProjectTaskCounts(db, projectId);
      expect((await projectRow()).open_tasks_by_severity).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
    });

    it("counts a task with no derivable severity only in the total", async () => {
      await addTask({});
      await refreshProjectTaskCounts(db, projectId);
      const row = await projectRow();
      expect(row.open_task_count).toBe(1);
      expect(row.open_tasks_by_severity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    });

    it("a domain gap of 'none' does not count as a severity bucket", async () => {
      const noneDomain = await addDomainWithGap("none");
      await addTask({ sourceDomainId: noneDomain });
      await refreshProjectTaskCounts(db, projectId);
      const row = await projectRow();
      expect(row.open_task_count).toBe(1);
      expect(row.open_tasks_by_severity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    });

    it("excludes done, dismissed and soft-deleted tasks from every count", async () => {
      const criticalFinding = await addFinding("critical");
      await addTask({ sourceFindingId: criticalFinding, status: "done" });
      await addTask({ sourceFindingId: criticalFinding, status: "dismissed" });
      await addTask({ sourceFindingId: criticalFinding, deletedAt: "2026-08-01T00:00:00Z" });
      await addTask({ sourceFindingId: criticalFinding, status: "in_progress" }); // the one that DOES count

      await refreshProjectTaskCounts(db, projectId);
      const row = await projectRow();
      expect(row.open_task_count).toBe(1);
      expect(row.open_tasks_by_severity).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
    });

    it("STORY-169 review · serialises two concurrent writers via a row lock, never losing either one's task", async () => {
      // PROBE reproduced: without a lock, writer B's plain SELECT count runs
      // BEFORE writer A commits, so B's later UPDATE — unblocked only once A
      // commits and releases the row — overwrites A's correct total with
      // B's own STALE count, taken before A's task ever existed. Two tasks
      // end up in `tasks`; `open_task_count` ends up 1. `SELECT ... FOR
      // UPDATE` on the project row, taken BEFORE counting, fixes this by
      // making B's whole read-then-write wait for A's, not just its UPDATE.
      const writerA = new Client({ connectionString: container.getConnectionUri() });
      const writerB = new Client({ connectionString: container.getConnectionUri() });
      await writerA.connect();
      await writerB.connect();
      try {
        const insertTask = (writer: Client, shortRef: string): Promise<unknown> =>
          writer.query(
            `INSERT INTO tasks
               (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status)
             VALUES ($1,$2,$3,$4,'technical',sha256(random()::text::bytea),'t','d','todo')`,
            [randomUUID(), workspaceId, projectId, shortRef],
          );

        // A: insert, then refresh (still uncommitted afterward — A keeps
        // holding the project row's `FOR UPDATE` lock until it commits).
        await writerA.query("BEGIN");
        await insertTask(writerA, `T-${randomUUID().slice(0, 8)}`);
        await refreshProjectTaskCounts(writerA, projectId);

        // B starts CONCURRENTLY, after A already holds the lock. Even B's
        // own `INSERT` cannot proceed yet — a `tasks.project_id` FK takes a
        // `FOR KEY SHARE` lock on the referenced `projects` row, which
        // conflicts with A's `FOR UPDATE` — so the whole chain, not just
        // B's later `refreshProjectTaskCounts`, waits for A to commit.
        let bSettled = false;
        const bDone = (async () => {
          await writerB.query("BEGIN");
          await insertTask(writerB, `T-${randomUUID().slice(0, 8)}`);
          await refreshProjectTaskCounts(writerB, projectId);
        })().then(() => {
          bSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(bSettled).toBe(false);

        await writerA.query("COMMIT");
        await bDone;
        expect(bSettled).toBe(true);
        await writerB.query("COMMIT");

        const row = await db.query<{ open_task_count: number }>("SELECT open_task_count FROM projects WHERE id = $1", [
          projectId,
        ]);
        expect(row.rows[0]!.open_task_count).toBe(2);
      } finally {
        await writerA.end();
        await writerB.end();
      }
    }, 30_000);

    it("STORY-169 re-audit · two writers that BOTH insert before EITHER refreshes deadlock under FOR UPDATE — FOR NO KEY UPDATE must not", async () => {
      // The lock-held test above never exercises the FK-driven conflict this
      // one does: it lets A finish inserting AND calling refresh (still
      // holding the lock) before B's INSERT even starts, so B's `tasks`
      // FK-driven `FOR KEY SHARE` never has to coexist with A's own. Here
      // both writers insert FIRST — each taking a `FOR KEY SHARE` lock on the
      // SAME `projects` row via the `tasks.project_id` FK, which two
      // transactions may hold simultaneously (`FOR KEY SHARE` does not
      // conflict with itself) — and only THEN does either call
      // `refreshProjectTaskCounts`. Under `FOR UPDATE` (the mode this
      // function used before the review fix), A's `SELECT ... FOR UPDATE`
      // must wait for B's `FOR KEY SHARE` to release, and B's must wait for
      // A's, for the same reason — a genuine wait-cycle across two real
      // connections, not a simulated one. Postgres detects it and aborts one
      // side with `40P01 deadlock detected`, rolling that writer's task
      // insert back with it: 1 task survives, not 2. `FOR NO KEY UPDATE`
      // conflicts only with another `FOR UPDATE`/`FOR NO KEY UPDATE`, never
      // with `FOR KEY SHARE`, so the two refreshers merely serialise against
      // EACH OTHER — no cycle, no abort, both tasks survive.
      const writerA = new Client({ connectionString: container.getConnectionUri() });
      const writerB = new Client({ connectionString: container.getConnectionUri() });
      await writerA.connect();
      await writerB.connect();
      try {
        const insertTask = (writer: Client, shortRef: string): Promise<unknown> =>
          writer.query(
            `INSERT INTO tasks
               (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status)
             VALUES ($1,$2,$3,$4,'technical',sha256(random()::text::bytea),'t','d','todo')`,
            [randomUUID(), workspaceId, projectId, shortRef],
          );

        await writerA.query("BEGIN");
        await writerB.query("BEGIN");
        // Both INSERTs land before either refresh — the FK's `FOR KEY SHARE`
        // on `projects` is held by BOTH transactions at once.
        await insertTask(writerA, `T-${randomUUID().slice(0, 8)}`);
        await insertTask(writerB, `T-${randomUUID().slice(0, 8)}`);

        // Both requests are IN FLIGHT, CONCURRENTLY, before either commits —
        // that is what makes the old code's cycle real: under `FOR UPDATE`,
        // A's lock request conflicts with B's already-held `FOR KEY SHARE`
        // and B's conflicts with A's, so BOTH block on each other and
        // Postgres's own deadlock detector (not this test) breaks the cycle
        // by aborting one side with `40P01` after `deadlock_timeout` (1 s).
        // Under `FOR NO KEY UPDATE`, WHICHEVER of A/B happens to reach the
        // lock request first resolves immediately WITHOUT committing (the
        // lock is still held) — committing THAT ONE is what then unblocks
        // the other's pending request.
        //
        // ⚠ Neither connection is guaranteed to "win" that race — the two
        // `refreshProjectTaskCounts` calls are started back to back, with no
        // ordering between them. So each writer commits/rolls back the
        // INSTANT ITS OWN call settles, never waiting on the other first:
        // an earlier version of this test always awaited A before touching
        // B's connection, which deadlocked the TEST ITSELF (not the
        // database) whenever B happened to win the race — B would then be
        // the one sitting resolved-but-uncommitted, while A blocked forever
        // waiting for a commit this code would only ever send after A
        // resolved.
        const settle = (writer: Client): Promise<{ status: "ok" } | { status: "error"; error: unknown }> =>
          refreshProjectTaskCounts(writer, projectId).then(
            async () => {
              await writer.query("COMMIT");
              return { status: "ok" as const };
            },
            async (error: unknown) => {
              await writer.query("ROLLBACK");
              return { status: "error" as const, error };
            },
          );

        const [resultA, resultB] = await Promise.all([settle(writerA), settle(writerB)]);

        expect(resultA.status).toBe("ok");
        expect(resultB.status).toBe("ok");

        const taskCount = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM tasks WHERE project_id = $1", [
          projectId,
        ]);
        expect(Number(taskCount.rows[0]!.n)).toBe(2);

        const row = await db.query<{ open_task_count: number }>("SELECT open_task_count FROM projects WHERE id = $1", [
          projectId,
        ]);
        expect(row.rows[0]!.open_task_count).toBe(2);
      } finally {
        await writerA.end();
        await writerB.end();
      }
    }, 30_000);
  });

  // ---------------------------------------------------------------------
  // refreshProjectSourceCoverage
  // ---------------------------------------------------------------------

  describe("refreshProjectSourceCoverage", () => {
    async function addDomain(): Promise<string> {
      const domainId = randomUUID();
      await db.query(`INSERT INTO source_domains (id, workspace_id, domain) VALUES ($1,$2,$3)`, [
        domainId,
        workspaceId,
        `d-${domainId.slice(0, 8)}.example`,
      ]);
      return domainId;
    }

    async function addIndexRow(
      domainId: string,
      over: { windowStart: string; windowDays?: number; engineKey?: string; contextWeight: number; gapSeverity: string | null },
    ): Promise<void> {
      await db.query(
        `INSERT INTO project_source_index
           (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight, gap_severity)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8)`,
        [
          workspaceId,
          projectId,
          domainId,
          over.engineKey ?? "all",
          over.windowStart,
          over.windowDays ?? 30,
          over.contextWeight,
          over.gapSeverity,
        ],
      );
    }

    it("is NULL with no project_source_index rows at all", async () => {
      await refreshProjectSourceCoverage(db, projectId);
      expect((await projectRow()).source_coverage).toBeNull();
    });

    it("computes 100 * (1 - sum of critical/high context_weight) over the LATEST window", async () => {
      const critical = await addDomain();
      const medium = await addDomain();
      await addIndexRow(critical, { windowStart: "2026-08-01", contextWeight: 0.6, gapSeverity: "critical" });
      await addIndexRow(medium, { windowStart: "2026-08-01", contextWeight: 0.4, gapSeverity: "medium" });

      await refreshProjectSourceCoverage(db, projectId);
      expect(Number((await projectRow()).source_coverage)).toBeCloseTo(100 * (1 - 0.6), 3);
    });

    it("reads the MOST RECENT window_start, ignoring a superseded one", async () => {
      const domain = await addDomain();
      // An older window says fully covered; the latest says a critical gap.
      // If the stale window won, coverage would read 100.
      await addIndexRow(domain, { windowStart: "2026-07-01", contextWeight: 1, gapSeverity: "none" });
      await addIndexRow(domain, { windowStart: "2026-08-01", contextWeight: 1, gapSeverity: "critical" });

      await refreshProjectSourceCoverage(db, projectId);
      expect(Number((await projectRow()).source_coverage)).toBeCloseTo(0, 3);
    });

    it("ignores a per-engine or non-30-day window row", async () => {
      const domain = await addDomain();
      await addIndexRow(domain, { windowStart: "2026-08-01", windowDays: 7, contextWeight: 1, gapSeverity: "critical" });
      await addIndexRow(domain, { windowStart: "2026-08-01", engineKey: "chatgpt", contextWeight: 1, gapSeverity: "critical" });

      // Neither row is engine_key='all' AND window_days=30, so nothing
      // qualifies — the same honest NULL as no rows at all.
      await refreshProjectSourceCoverage(db, projectId);
      expect((await projectRow()).source_coverage).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // cross-cutting
  // ---------------------------------------------------------------------

  it("touches only the named project — a second workspace's project is left untouched by all three", async () => {
    const otherWorkspaceId = randomUUID();
    const otherProjectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'Other',$2,'growth','UTC')", [
      otherWorkspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'Other Co',$3,'https://other.example','other.example')`,
      [otherProjectId, otherWorkspaceId, `p-${randomUUID().slice(0, 8)}`],
    );

    // Give the FIRST project data every producer would act on.
    await db.query(
      `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, aux_score, status, rule_version, tokenizer)
       VALUES ($1,$2,$3,'manual','key_pages','{}',88,'completed','v1','t1')`,
      [randomUUID(), workspaceId, projectId],
    );
    await db.query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description)
       VALUES ($1,$2,$3,$4,'technical',sha256(random()::text::bytea),'t','d')`,
      [randomUUID(), workspaceId, projectId, `T-${randomUUID().slice(0, 8)}`],
    );
    const domainId = randomUUID();
    await db.query(`INSERT INTO source_domains (id, workspace_id, domain) VALUES ($1,$2,'x.example')`, [domainId, workspaceId]);
    await db.query(
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight, gap_severity)
       VALUES ($1,$2,$3,'all','2026-08-01',30,0.5,'critical')`,
      [workspaceId, projectId, domainId],
    );

    await refreshProjectAux(db, projectId);
    await refreshProjectTaskCounts(db, projectId);
    await refreshProjectSourceCoverage(db, projectId);

    const other = await db.query<{
      aux_score_current: string | null;
      open_task_count: number;
      open_tasks_by_severity: { critical: number; high: number; medium: number; low: number };
      source_coverage: string | null;
    }>(
      "SELECT aux_score_current::text, open_task_count, open_tasks_by_severity, source_coverage::text FROM projects WHERE id = $1",
      [otherProjectId],
    );
    expect(other.rows[0]!.aux_score_current).toBeNull();
    expect(other.rows[0]!.open_task_count).toBe(0);
    expect(other.rows[0]!.open_tasks_by_severity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(other.rows[0]!.source_coverage).toBeNull();
  });
});

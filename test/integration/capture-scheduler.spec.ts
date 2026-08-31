import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { advanceNextRun, claimDueProjects } from "../../src/lib/capture/scheduler.js";

// STORY-033 — §5's scheduler, against real Postgres with real concurrency.
//
// Two of the three properties here CANNOT be tested single-threaded, and both
// are the kind that pass every unit test and fail in production:
//
//   SKIP LOCKED. Without it two replicas either block on each other or, worse
//   under a naive implementation, both claim the same project and schedule it
//   twice. A single-connection test sees neither.
//
//   The compare-and-set on next_run_at. It only matters when a claim is
//   replayed or a lock is lost, which never happens with one connection.
//
// The fairness property is the third, and it is invisible in any single tick:
// ordering by id or created_at means the same tenants are always served last
// and their data is always the stalest, compounding daily.
describe("STORY-033 · the scheduler claims due projects fairly and safely", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 6 });
  }, 240_000);

  afterAll(async () => {
    await pool.end();
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE projects, workspaces CASCADE");
  });

  async function addWorkspace(status = "active", deleted = false): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO workspaces (id, name, slug, plan_key, status, deleted_at)
       VALUES ($1, 'W', $2, 'growth', $3, $4)`,
      [id, `w-${randomUUID().slice(0, 8)}`, status, deleted ? new Date() : null],
    );
    return id;
  }

  interface ProjectOptions {
    readonly dueMinutesAgo?: number | null;
    readonly status?: string;
    readonly deleted?: boolean;
  }

  async function addProject(workspaceId: string, options: ProjectOptions = {}): Promise<string> {
    const id = randomUUID();
    const due =
      options.dueMinutesAgo === null
        ? null
        : new Date(Date.now() - (options.dueMinutesAgo ?? 10) * 60_000);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain,
                             status, deleted_at, next_run_at)
       VALUES ($1, $2, 'P', $3, 'https://e.test', 'e.test', $4, $5, $6)`,
      [
        id,
        workspaceId,
        `p-${randomUUID().slice(0, 8)}`,
        options.status ?? "active",
        options.deleted ? new Date() : null,
        due,
      ],
    );
    return id;
  }

  /** Runs `fn` inside a real transaction, so the row locks live as long as they would in a tick. */
  async function inTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("claims a project that is past due", async () => {
    const ws = await addWorkspace();
    const projectId = await addProject(ws);

    const claimed = await inTransaction((tx) => claimDueProjects(tx, new Date()));
    expect(claimed.map((p) => p.projectId)).toEqual([projectId]);
  }, 30_000);

  it("does not claim a project whose next run is in the future, or unset", async () => {
    const ws = await addWorkspace();
    await addProject(ws, { dueMinutesAgo: -60 });
    await addProject(ws, { dueMinutesAgo: null });

    expect(await inTransaction((tx) => claimDueProjects(tx, new Date()))).toHaveLength(0);
  }, 30_000);

  // THE FAIRNESS PROPERTY. Under backlog, ordering by anything other than
  // next_run_at means the same tenants are always last.
  it("serves the LONGEST-WAITING project first", async () => {
    const ws = await addWorkspace();
    const recent = await addProject(ws, { dueMinutesAgo: 5 });
    const oldest = await addProject(ws, { dueMinutesAgo: 500 });
    const middle = await addProject(ws, { dueMinutesAgo: 60 });

    const claimed = await inTransaction((tx) => claimDueProjects(tx, new Date()));
    expect(claimed.map((p) => p.projectId)).toEqual([oldest, middle, recent]);
  }, 30_000);

  it.each([
    ["suspended", "suspended"],
    ["soft_capped", "soft_capped"],
    ["pending_deletion", "pending_deletion"],
    ["past_due", "past_due"],
  ] as const)("skips a %s workspace", async (_label, status) => {
    const ws = await addWorkspace(status);
    await addProject(ws);
    expect(await inTransaction((tx) => claimDueProjects(tx, new Date()))).toHaveLength(0);
  }, 30_000);

  it("claims a trialing workspace, which §5 lists alongside active", async () => {
    const ws = await addWorkspace("trialing");
    await addProject(ws);
    expect(await inTransaction((tx) => claimDueProjects(tx, new Date()))).toHaveLength(1);
  }, 30_000);

  it("skips a soft-deleted workspace and a soft-deleted or paused project", async () => {
    const deletedWs = await addWorkspace("active", true);
    await addProject(deletedWs);
    const ws = await addWorkspace();
    await addProject(ws, { deleted: true });
    await addProject(ws, { status: "paused" });

    expect(await inTransaction((tx) => claimDueProjects(tx, new Date()))).toHaveLength(0);
  }, 30_000);

  it("bounds the batch, so a backlog drains steadily rather than in one spike", async () => {
    const ws = await addWorkspace();
    for (let i = 0; i < 7; i += 1) await addProject(ws, { dueMinutesAgo: 10 + i });

    const claimed = await inTransaction((tx) => claimDueProjects(tx, new Date(), 3));
    expect(claimed).toHaveLength(3);
  }, 30_000);

  // SKIP LOCKED, driven with two live transactions. A second replica must
  // step OVER the rows the first holds, not block and not re-claim them.
  it("two scheduler replicas on one tick never claim the same project", async () => {
    const ws = await addWorkspace();
    for (let i = 0; i < 6; i += 1) await addProject(ws, { dueMinutesAgo: 10 + i });

    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await second.query("BEGIN");

      const claimedByFirst = await claimDueProjects(first, new Date(), 3);
      // The first transaction still holds its locks here — this is the exact
      // overlap a real second replica hits.
      const claimedBySecond = await claimDueProjects(second, new Date(), 3);

      await first.query("COMMIT");
      await second.query("COMMIT");

      const firstIds = new Set(claimedByFirst.map((p) => p.projectId));
      const overlap = claimedBySecond.filter((p) => firstIds.has(p.projectId));

      expect(claimedByFirst, "the first replica takes its batch").toHaveLength(3);
      expect(overlap, "and the second must take a DIFFERENT one, never the same rows").toEqual([]);
      expect(claimedBySecond, "stepping over locked rows, not blocking on them").toHaveLength(3);
    } finally {
      first.release();
      second.release();
    }
  }, 30_000);

  // CRASH SAFETY. The advance is a compare-and-set, so a claim replayed after
  // another transaction already advanced the project updates nothing — and
  // the caller must not enqueue.
  it("advancing twice from the same claim succeeds once and refuses the replay", async () => {
    const ws = await addWorkspace();
    const projectId = await addProject(ws);
    const [claim] = await inTransaction((tx) => claimDueProjects(tx, new Date()));

    const nextRun = new Date(Date.now() + 3_600_000);
    const first = await inTransaction((tx) => advanceNextRun(tx, claim!, nextRun, new Date()));
    const replay = await inTransaction((tx) => advanceNextRun(tx, claim!, nextRun, new Date()));

    expect(first, "the first advance moves the project").toBe(true);
    expect(replay, "a replayed claim must move nothing, or the project is scheduled twice").toBe(false);
  }, 30_000);

  it("an advanced project is not claimed again on the next tick", async () => {
    const ws = await addWorkspace();
    await addProject(ws);
    const [claim] = await inTransaction((tx) => claimDueProjects(tx, new Date()));
    await inTransaction((tx) => advanceNextRun(tx, claim!, new Date(Date.now() + 3_600_000), new Date()));

    expect(
      await inTransaction((tx) => claimDueProjects(tx, new Date())),
      "the next tick must find nothing due",
    ).toHaveLength(0);
  }, 30_000);

  // A crash BETWEEN the advance and the enqueue rolls the whole transaction
  // back, so the project is still due — scheduled once on the next tick
  // rather than never or twice.
  it("a crash between advancing and enqueueing leaves the project due, not lost and not doubled", async () => {
    const ws = await addWorkspace();
    const projectId = await addProject(ws);

    await expect(
      inTransaction(async (tx) => {
        const [claim] = await claimDueProjects(tx, new Date());
        await advanceNextRun(tx, claim!, new Date(Date.now() + 3_600_000), new Date());
        throw new Error("simulated crash before the enqueue");
      }),
    ).rejects.toThrow(/simulated crash/);

    const claimed = await inTransaction((tx) => claimDueProjects(tx, new Date()));
    expect(claimed.map((p) => p.projectId), "still due, exactly once").toEqual([projectId]);
  }, 30_000);
});

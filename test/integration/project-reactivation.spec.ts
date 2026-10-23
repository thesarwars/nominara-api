import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/api/errors/domain-errors.js";
import { UrlGuard } from "../../src/lib/net/url-guard.service.js";
import { reactivateProject } from "../../src/modules/projects/project-reactivation.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { usePlanChangeFixture } from "../support/plan-change-fixture.js";

// STORY-077 — OWNER DECISION 2026-10-23. Archived and person-paused projects use NO plan slot: `projects.max` counts the
// tracking projects (active, initializing). The other half of that rule is what this file is about: leaving `archived`
// or `paused` is a move INTO tracking, so it needs room under `projects.max`, or archiving becomes a way around the limit
// (archive one, create one, un-archive the first). Enforced under the same bounded workspace row lock every other door
// into an active slot takes (active-limit.ts), so two moves that each see one free slot cannot both take it.
//
// There is no HTTP door for this yet: `PATCH /projects/{id}` is in api-specification.md §3 but not built. The rule lives
// in `reactivateProject`, which that route must call; these cases call it the way a handler would, inside a tenant
// context on its own connection.
//
// Hazards:
//   * an un-archive or a person's resume at the limit is accepted (the bypass);
//   * a refusal changes something (status, the downgrade marker);
//   * two reactivations, or a reactivation and a creation, racing for the last slot both succeed;
//   * a person resuming a project a downgrade paused skips onboarding (it must return to what it was).

describe("STORY-077 · owner decision 2026-10-23: leaving archived or paused needs room under projects.max", () => {
  const f = usePlanChangeFixture();
  const db = () => f.harness.db();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return client;
  }

  /** `reactivateProject` in its own tenant transaction, as a handler runs it; the refusal is returned, not thrown. */
  async function reactivate(workspaceId: string, projectId: string, client?: Client): Promise<{ ok: true; status: string } | { ok: false; code: string; details: unknown }> {
    const own = client ?? (await connect());
    try {
      const result = await withTenantContext(own, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => reactivateProject(tx, { workspaceId, projectId }));
      return { ok: true, status: result.status };
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, code: error.code, details: error.details };
      throw error;
    } finally {
      if (client === undefined) await own.end();
    }
  }

  const statusOf = async (projectId: string) =>
    (await db().query<{ status: string; paused_by_downgrade_at: Date | null; paused_by_downgrade_from: string | null }>(
      "SELECT status, paused_by_downgrade_at, paused_by_downgrade_from FROM projects WHERE id = $1",
      [projectId],
    )).rows[0]!;
  const tracking = async (workspaceId: string) =>
    (await db().query<{ n: number }>("SELECT count(*)::int AS n FROM projects WHERE workspace_id = $1 AND status IN ('active','initializing') AND deleted_at IS NULL", [workspaceId])).rows[0]!.n;

  it("un-archiving with room succeeds: the project tracks again", async () => {
    const { workspaceId } = await f.newWorkspace("growth"); // 3 projects
    const ids = await f.projects(workspaceId, 3);
    await db().query("UPDATE projects SET status = 'archived' WHERE id = $1", [ids[2]]);
    expect(await reactivate(workspaceId, ids[2]!)).toEqual({ ok: true, status: "active" });
    expect(await statusOf(ids[2]!)).toMatchObject({ status: "active", paused_by_downgrade_at: null });
  });

  it("un-archiving at the limit is REFUSED 403 entitlement_exceeded (projects.max) and changes nothing", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    const ids = await f.projects(workspaceId, 4);
    await db().query("UPDATE projects SET status = 'archived' WHERE id = $1", [ids[3]]);
    expect(await reactivate(workspaceId, ids[3]!)).toEqual({ ok: false, code: "entitlement_exceeded", details: { key: "projects.max", limit: 3, current: 3 } });
    expect(await statusOf(ids[3]!)).toMatchObject({ status: "archived" });
    expect(await tracking(workspaceId)).toBe(3);
  });

  it("resuming a project a PERSON paused at the limit is REFUSED the same way", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    const ids = await f.projects(workspaceId, 4);
    await db().query("UPDATE projects SET status = 'paused' WHERE id = $1", [ids[0]]);
    expect(await reactivate(workspaceId, ids[0]!)).toEqual({ ok: false, code: "entitlement_exceeded", details: { key: "projects.max", limit: 3, current: 3 } });
    expect(await statusOf(ids[0]!)).toMatchObject({ status: "paused", paused_by_downgrade_at: null });
  });

  it("a person resuming a project a DOWNGRADE paused needs room too; with room it returns to what it was (initializing stays initializing) and the marker is cleared", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    const ids = await f.projects(workspaceId, 4);
    await db().query("UPDATE projects SET status = 'initializing' WHERE id = $1", [ids[3]]);
    await db().query("UPDATE projects SET paused_by_downgrade_from = status, status = 'paused', paused_by_downgrade_at = now() WHERE id = $1", [ids[3]]);
    await db().query("UPDATE projects SET status = 'archived' WHERE id = $1", [ids[2]]);
    expect(await reactivate(workspaceId, ids[3]!)).toEqual({ ok: true, status: "initializing" });
    expect(await statusOf(ids[3]!)).toEqual({ status: "initializing", paused_by_downgrade_at: null, paused_by_downgrade_from: null });

    // Now at 3 tracking: the archived one cannot come back.
    expect(await reactivate(workspaceId, ids[2]!)).toMatchObject({ ok: false, code: "entitlement_exceeded" });
  });

  it("THE BYPASS · archive one, create one, then un-archive the first: the un-archive is refused", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    const ids = await f.projects(workspaceId, 3);
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (url: string) => ({ rootDomain: new URL(url).hostname }));

    await db().query("UPDATE projects SET status = 'archived' WHERE id = $1", [ids[0]]);
    const created = await f.post(actor, "/projects", { root_url: `https://new-${randomUUID().slice(0, 8)}.example.com` });
    expect(created.statusCode, created.body).toBe(202);
    expect(await reactivate(workspaceId, ids[0]!)).toEqual({ ok: false, code: "entitlement_exceeded", details: { key: "projects.max", limit: 3, current: 3 } });
    expect(await tracking(workspaceId)).toBe(3);
  });

  it("an active or initializing project is already tracking: reactivating it is a no-op, never a refusal, even at the limit", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    const ids = await f.projects(workspaceId, 3);
    expect(await reactivate(workspaceId, ids[1]!)).toEqual({ ok: true, status: "active" });
    expect(await tracking(workspaceId)).toBe(3);
  });

  it("CONCURRENT · two reactivations racing for the last slot: exactly one succeeds, the other is refused, never above the limit", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    const ids = await f.projects(workspaceId, 4);
    await db().query("UPDATE projects SET status = 'archived' WHERE id = ANY($1::uuid[])", [[ids[2], ids[3]]]);
    const [a, b] = [await connect(), await connect()];
    try {
      const results = await Promise.all([reactivate(workspaceId, ids[2]!, a), reactivate(workspaceId, ids[3]!, b)]);
      expect(results.map((r) => r.ok).sort(), "exactly one fits").toEqual([false, true]);
      expect(results.find((r) => !r.ok)).toMatchObject({ code: "entitlement_exceeded", details: { key: "projects.max", limit: 3, current: 3 } });
      expect(await tracking(workspaceId), "never above the limit").toBe(3);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("CONCURRENT · a reactivation holding the workspace lock and a POST /projects racing for the last slot: the creation waits and is refused", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    const ids = await f.projects(workspaceId, 3);
    await db().query("UPDATE projects SET status = 'archived' WHERE id = $1", [ids[2]]);
    const actor = await f.enter(await f.ownerOf(workspaceId), workspaceId);
    vi.spyOn(UrlGuard.prototype, "validateAndNormalize").mockImplementation(async (url: string) => ({ rootDomain: new URL(url).hostname }));

    const holder = await connect();
    try {
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.current_workspace_id', $1, true), set_config('app.current_actor_id', $2, true)", [workspaceId, SYSTEM_ACTOR_ID]);
      expect((await reactivateProject(holder, { workspaceId, projectId: ids[2]! })).status).toBe("active");

      // Deterministic: the creation is seen WAITING on the reactivation's workspace lock before that commits.
      const create = f.post(actor, "/projects", { root_url: `https://race-${randomUUID().slice(0, 8)}.example.com` });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = (await db().query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [holderPid])).rows[0]!.n;
        if (waiting > 0) break;
        if (Date.now() > deadline) throw new Error("the creation never waited on the reactivation's workspace lock");
        await new Promise((r) => setTimeout(r, 20));
      }
      await holder.query("COMMIT");

      const res = await create;
      expect(res.statusCode, res.body).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "entitlement_exceeded", details: { key: "projects.max", limit: 3, current: 3 } } });
      expect(await tracking(workspaceId), "never above the limit").toBe(3);
    } finally {
      await holder.end();
    }
  });
});

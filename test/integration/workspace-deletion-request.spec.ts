import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// DELETE /workspaces/{id} (batch 6, owner decision 80) — workspace deletion request, through the REAL ApiModule.
// Decisions: plans-7day/decisions-2026-10-13.md § STORY-021. Every test names the EC-15 line or the
// invariant it guards; each INVARIANT is stated once, in the title, so a reviewer can mutate one guard
// and find the test that dies.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

interface RecordedJob {
  readonly name: string;
  readonly workspaceId: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
}

/** Stands in for the BullMQ producer: records what a request path enqueued, touches no Redis. */
class RecordingQueueProducer {
  readonly jobs: RecordedJob[] = [];
  failWith: Error | undefined;
  async enqueueTenantJob(name: string, workspaceId: string, payload: Record<string, unknown>, options: { idempotencyKey: string }): Promise<{ id: string }> {
    if (this.failWith !== undefined) throw this.failWith;
    this.jobs.push({ name, workspaceId, payload, idempotencyKey: options.idempotencyKey });
    return { id: String(this.jobs.length) };
  }
}

describe("DELETE /workspaces/{id} · workspace deletion request over HTTP", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  let queue: RecordingQueueProducer;
  // As the real nominara_app role: the transfer's revocation statements carry NO workspace predicate (RLS is the
  // guarantee), so a superuser connection would let a cross-tenant leak pass.
  const harness = useApiHarness({
    runAsAppRole: true,
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }),
    configure: (builder) => {
      queue = new RecordingQueueProducer();
      builder.overrideProvider(QueueProducer).useValue(queue);
    },
  });
  let pool: Pool;
  let sessions: SessionService;

  beforeAll(async () => {
    [cacheValkey, queueValkey] = await Promise.all([startValkey(), startValkeyFixture()]);
  }, 180_000);
  afterAll(async () => {
    await Promise.all([cacheValkey.stop(), queueValkey.stop()]);
  });
  beforeEach(() => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    sessions = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());
  });
  afterEach(async () => {
    await pool.end();
  });

  // ---- fixtures ---------------------------------------------------------------------------------------------------

  interface Actor {
    readonly userId: string;
    readonly workspaceId: string;
    readonly sid: string;
    readonly cookie: string;
    readonly csrf: string;
  }

  const db = () => harness.db();

  async function newUser(opts: { verified?: boolean; passkey?: boolean } = {}): Promise<string> {
    const userId = uuidV7();
    await db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,$3,'active',now(),now())`,
      [userId, `${userId}@example.test`, opts.verified === false ? null : new Date()],
    );
    if (opts.passkey !== false) await addPasskey(userId);
    return userId;
  }

  async function addPasskey(userId: string, revoked = false): Promise<void> {
    await db().query(
      `INSERT INTO user_credentials (user_id, kind, credential_id, public_key, revoked_at) VALUES ($1,'passkey',$2,$3,$4)`,
      [userId, randomBytes(32), randomBytes(77), revoked ? new Date() : null],
    );
  }

  async function entVersion(workspaceId: string): Promise<number> {
    return (await db().query<{ v: number }>("SELECT entitlement_version AS v FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.v;
  }

  async function actorIn(workspaceId: string, userId: string, role: string, stepUp: boolean): Promise<Actor> {
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, role, null, await entVersion(workspaceId));
    if (stepUp) await sessions.recordStrongAuth(tokens.sid, "webauthn");
    return { userId, workspaceId, sid: tokens.sid, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  /** A user with a fresh session who creates their own workspace over HTTP and owns it. */
  async function ownerWithWorkspace(opts: { stepUp?: boolean } = {}): Promise<Actor> {
    const userId = await newUser();
    const tokens = await sessions.createSession(userId);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: `Acme ${userId.slice(-6)}`, org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;
    return actorIn(workspaceId, userId, "owner", opts.stepUp !== false);
  }

  async function addMember(workspaceId: string, role: string, opts: { userId?: string; stepUp?: boolean } = {}): Promise<Actor> {
    const userId = opts.userId ?? (await newUser());
    await db().query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,$4,'active')`, [uuidV7(), workspaceId, userId, role]);
    return actorIn(workspaceId, userId, role, opts.stepUp !== false);
  }

  const del = (a: Actor, body: unknown, workspaceId = a.workspaceId) =>
    harness.app().inject({
      method: "DELETE",
      url: apiUrl(`/workspaces/${workspaceId}`),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
      payload: body as object,
    });
  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  const slugOf = async (workspaceId: string) => (await db().query<{ slug: string }>("SELECT slug FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.slug;
  const stateOf = async (workspaceId: string) =>
    (await db().query<{ status: string; deletion_requested_at: Date | null; deletion_execute_at: Date | null }>("SELECT status, deletion_requested_at, deletion_execute_at FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!;
  async function auditRows(workspaceId: string, action: string) {
    return (await db().query<{ severity: string; actor_id: string; resource_id: string }>("SELECT severity, actor_id, resource_id FROM audit_log WHERE workspace_id = $1 AND action = $2", [workspaceId, action])).rows;
  }
  async function addShareToken(workspaceId: string, createdBy: string): Promise<string> {
    const token = await db().query<{ id: string }>(
      `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, scope_project_ids, created_by)
       VALUES ($1, 'L', gen_random_bytes(32), 'abcdefgh', ARRAY[gen_random_uuid()], $2) RETURNING id`,
      [workspaceId, createdBy],
    );
    return token.rows[0]!.id;
  }

  it("DELETE-1 owner with step-up and the right slug: 202, pending_deletion for 30 days, the detail body", async () => {
    const owner = await ownerWithWorkspace();
    const res = await del(owner, { confirm_slug: await slugOf(owner.workspaceId) });
    expect(res.statusCode, res.body).toBe(202);
    const row = await stateOf(owner.workspaceId);
    expect(row.status).toBe("pending_deletion");
    expect(row.deletion_execute_at!.getTime() - row.deletion_requested_at!.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(data<{ id: string; status: string; deletion_scheduled_at: string }>(res)).toMatchObject({ id: owner.workspaceId, status: "pending_deletion", deletion_scheduled_at: row.deletion_execute_at!.toISOString() });
  });

  it("DELETE-2 the lock is immediate: the workspace refuses the next request, share tokens are revoked", async () => {
    const owner = await ownerWithWorkspace();
    const tokenId = await addShareToken(owner.workspaceId, owner.userId);
    expect((await del(owner, { confirm_slug: await slugOf(owner.workspaceId) })).statusCode).toBe(202);
    const after = await harness.app().inject({ method: "GET", url: apiUrl(`/workspaces/${owner.workspaceId}`), headers: { cookie: owner.cookie } });
    expect(after.statusCode).toBe(403);
    const token = await db().query<{ revoked_at: Date | null }>("SELECT revoked_at FROM share_tokens WHERE id = $1", [tokenId]);
    expect(token.rows[0]!.revoked_at).not.toBeNull();
  });

  it("DELETE-3 writes a critical audit row by the owner on the workspace", async () => {
    const owner = await ownerWithWorkspace();
    await del(owner, { confirm_slug: await slugOf(owner.workspaceId) });
    const rows = await auditRows(owner.workspaceId, "workspace.deletion_scheduled");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: owner.userId, resource_id: owner.workspaceId, severity: "critical" });
  });

  it("DELETE-4 a wrong slug is 400 validation_failed and nothing changes", async () => {
    const owner = await ownerWithWorkspace();
    const res = await del(owner, { confirm_slug: "not-the-slug" });
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res).code).toBe("validation_failed");
    expect((await stateOf(owner.workspaceId)).status).toBe("active");
  });

  it("DELETE-5 a missing slug and an unknown key are both 400 (.strict())", async () => {
    const owner = await ownerWithWorkspace();
    expect((await del(owner, {})).statusCode).toBe(400);
    expect((await del(owner, { confirm_slug: await slugOf(owner.workspaceId), extra: 1 })).statusCode).toBe(400);
    expect((await stateOf(owner.workspaceId)).status).toBe("active");
  });

  it("DELETE-6 an admin is 403 naming workspace:delete and nothing changes", async () => {
    const owner = await ownerWithWorkspace();
    const admin = await addMember(owner.workspaceId, "admin");
    const res = await del(admin, { confirm_slug: await slugOf(owner.workspaceId) });
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res).details).toMatchObject({ required_permission: "workspace:delete" });
    expect((await stateOf(owner.workspaceId)).status).toBe("active");
  });

  it("DELETE-7 the owner needs a step-up: 401 step_up_required, nothing changes", async () => {
    const owner = await ownerWithWorkspace({ stepUp: false });
    const res = await del(owner, { confirm_slug: await slugOf(owner.workspaceId) });
    expect(res.statusCode, res.body).toBe(401);
    expect(errorOf(res).code).toBe("step_up_required");
    expect((await stateOf(owner.workspaceId)).status).toBe("active");
  });

  it("DELETE-8 another workspace's id in the path is 403 workspace_mismatch and deletes neither", async () => {
    const a = await ownerWithWorkspace();
    const b = await ownerWithWorkspace();
    const res = await del(a, { confirm_slug: await slugOf(b.workspaceId) }, b.workspaceId);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res).code).toBe("workspace_mismatch");
    expect((await stateOf(a.workspaceId)).status).toBe("active");
    expect((await stateOf(b.workspaceId)).status).toBe("active");
  });

  it("DELETE-9 a second request does not move the deadline", async () => {
    const owner = await ownerWithWorkspace();
    const slug = await slugOf(owner.workspaceId);
    await del(owner, { confirm_slug: slug });
    const first = await stateOf(owner.workspaceId);
    const again = await del(owner, { confirm_slug: slug });
    expect(again.statusCode).toBe(403);
    expect((await stateOf(owner.workspaceId)).deletion_execute_at).toEqual(first.deletion_execute_at);
  });

  // ---- decision 83(a): the Stripe subscription is cancelled at period end by a job, after commit ---------------------------

  it("DELETE-10 after commit exactly ONE billing.cancel_on_deletion job is enqueued, ids only, keyed by the workspace (KAD-06: no Stripe call in the request)", async () => {
    const owner = await ownerWithWorkspace();
    queue.jobs.length = 0;
    expect((await del(owner, { confirm_slug: await slugOf(owner.workspaceId) })).statusCode).toBe(202);
    expect(queue.jobs).toEqual([{ name: "billing.cancel_on_deletion", workspaceId: owner.workspaceId, payload: {}, idempotencyKey: `delcancel:${owner.workspaceId}` }]);
  });

  it("DELETE-11 a refused request (wrong slug, non-owner, no step-up, replay) enqueues nothing", async () => {
    const owner = await ownerWithWorkspace();
    const admin = await addMember(owner.workspaceId, "admin");
    const noStepUp = await ownerWithWorkspace({ stepUp: false });
    queue.jobs.length = 0;
    expect((await del(owner, { confirm_slug: "not-the-slug" })).statusCode).toBe(400);
    expect((await del(admin, { confirm_slug: await slugOf(owner.workspaceId) })).statusCode).toBe(403);
    expect((await del(noStepUp, { confirm_slug: await slugOf(noStepUp.workspaceId) })).statusCode).toBe(401);
    expect(queue.jobs).toEqual([]);
    expect((await del(owner, { confirm_slug: await slugOf(owner.workspaceId) })).statusCode).toBe(202);
    expect((await del(owner, { confirm_slug: await slugOf(owner.workspaceId) })).statusCode).toBe(403);
    expect(queue.jobs, "the replay enqueued nothing more").toHaveLength(1);
  });

  it("DELETE-12 a failed enqueue never fails the committed request", async () => {
    const owner = await ownerWithWorkspace();
    queue.jobs.length = 0;
    queue.failWith = new Error("valkey down");
    try {
      const res = await del(owner, { confirm_slug: await slugOf(owner.workspaceId) });
      expect(res.statusCode, res.body).toBe(202);
    } finally {
      queue.failWith = undefined;
    }
    expect((await stateOf(owner.workspaceId)).status).toBe("pending_deletion");
  });

  // ---- decision 83(b): a legal hold does not refuse the request; the purge is what skips a held workspace ----------------------

  it("DELETE-13 a workspace under a legal hold still accepts the request (202, pending_deletion); the hold, not the request, is what stops the purge", async () => {
    const owner = await ownerWithWorkspace();
    const [a, b] = [await newUser(), await newUser()];
    await db().query(
      `INSERT INTO legal_holds (scope, scope_id, workspace_id, reason, requested_by, approved_by, expires_at) VALUES ('workspace',$1,$1,'Hold on the whole workspace',$2,$3, now() + interval '5 days')`,
      [owner.workspaceId, a, b],
    );
    const res = await del(owner, { confirm_slug: await slugOf(owner.workspaceId) });
    expect(res.statusCode, res.body).toBe(202);
    expect((await stateOf(owner.workspaceId)).status).toBe("pending_deletion");
    expect((await db().query("SELECT 1 FROM legal_holds WHERE scope_id = $1 AND released_at IS NULL", [owner.workspaceId])).rowCount).toBe(1);
  });
});

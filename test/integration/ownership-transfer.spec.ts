import { createHash, randomBytes } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

// STORY-021 core slice — workspace ownership transfer (EC-15), through the REAL ApiModule.
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

describe("STORY-021 / EC-15 · workspace ownership transfer over HTTP", () => {
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

  interface World {
    readonly owner: Actor;
    readonly recipient: Actor;
    readonly workspaceId: string;
  }

  /** A workspace with its owner and an eligible recipient: an active admin, verified, holding a passkey. */
  async function world(): Promise<World> {
    const owner = await ownerWithWorkspace();
    const recipient = await addMember(owner.workspaceId, "admin");
    return { owner, recipient, workspaceId: owner.workspaceId };
  }

  const post = (a: Actor, path: string, body?: unknown, workspaceId = a.workspaceId) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl(`/workspaces/${workspaceId}/transfer-ownership${path}`),
      headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
      payload: (body ?? {}) as object,
    });
  const initiate = (a: Actor, recipientId: string, workspaceId = a.workspaceId) => post(a, "", { recipient_id: recipientId }, workspaceId);
  const accept = (a: Actor, workspaceId = a.workspaceId) => post(a, "/accept", undefined, workspaceId);
  const decline = (a: Actor, workspaceId = a.workspaceId) => post(a, "/decline", undefined, workspaceId);
  const cancel = (a: Actor, workspaceId = a.workspaceId) => post(a, "/cancel", undefined, workspaceId);

  const data = <T>(res: { json(): unknown }): T => (res.json() as { data: T }).data;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;

  /** An error with the per-request noise removed, for comparing two refusals. */
  const shapeOf = (res: { json(): unknown }) => {
    const { request_id: _requestId, message: _message, ...rest } = errorOf(res) as Record<string, unknown>;
    return rest;
  };
  async function roles(workspaceId: string): Promise<Record<string, string>> {
    const rows = await db().query<{ user_id: string; role: string }>("SELECT user_id, role FROM workspace_members WHERE workspace_id = $1 AND status = 'active'", [workspaceId]);
    return Object.fromEntries(rows.rows.map((r) => [r.user_id, r.role]));
  }
  async function transferDoc(workspaceId: string): Promise<Record<string, unknown> | null> {
    return (await db().query<{ t: Record<string, unknown> | null }>("SELECT ownership_transfer AS t FROM workspaces WHERE id = $1", [workspaceId])).rows[0]!.t;
  }
  async function auditRows(workspaceId: string, action?: string) {
    return (
      await db().query<{ action: string; severity: string; actor_id: string; resource_id: string; before_state: unknown; after_state: unknown; seq: string }>(
        `SELECT seq, action, severity, actor_id, resource_id, before_state, after_state FROM audit_log
          WHERE workspace_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY seq`,
        [workspaceId, action ?? null],
      )
    ).rows;
  }
  /** The whole mutable surface a refused/expired/declined transfer must leave untouched. */
  async function snapshot(workspaceId: string) {
    const [members, version, keys, tokens, invitations] = await Promise.all([
      roles(workspaceId),
      entVersion(workspaceId),
      db().query("SELECT id, revoked_at FROM api_keys WHERE workspace_id = $1 ORDER BY id", [workspaceId]),
      db().query("SELECT id, revoked_at FROM share_tokens WHERE workspace_id = $1 ORDER BY id", [workspaceId]),
      db().query("SELECT id, revoked_at FROM workspace_invitations WHERE workspace_id = $1 ORDER BY id", [workspaceId]),
    ]);
    return { members, version, keys: keys.rows, tokens: tokens.rows, invitations: invitations.rows };
  }
  async function sessionRevoked(sid: string): Promise<boolean> {
    return (await db().query<{ r: Date | null }>("SELECT revoked_at AS r FROM sessions WHERE id = $1", [sid])).rows[0]!.r !== null;
  }

  async function insertApiKey(workspaceId: string, createdBy: string): Promise<string> {
    const id = uuidV7();
    await db().query(
      `INSERT INTO api_keys (id, workspace_id, name, key_prefix, key_hash, permissions, created_by) VALUES ($1,$2,'ci',$3,$4,'{}',$5)`,
      [id, workspaceId, id.slice(0, 8), createHash("sha256").update(id).digest(), createdBy],
    );
    return id;
  }
  async function insertShareToken(workspaceId: string, createdBy: string, passwordless: boolean): Promise<string> {
    const id = uuidV7();
    await db().query(
      `INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, password_hash, password_required, scope_project_ids, created_by)
       VALUES ($1,$2,'link',$3,$4,$5,$6,ARRAY[gen_random_uuid()],$7)`,
      [id, workspaceId, createHash("sha256").update(id).digest(), id.slice(0, 8), passwordless ? null : "argon2id$stub", !passwordless, createdBy],
    );
    return id;
  }
  async function insertInvitation(workspaceId: string, invitedBy: string, role: string): Promise<string> {
    const id = uuidV7();
    await db().query(
      `INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '3 days')`,
      [id, workspaceId, `${id}@example.test`, role, createHash("sha256").update(id).digest(), invitedBy],
    );
    return id;
  }
  async function insertInvoice(workspaceId: string, status: string, periodEndOffsetDays: number, paid = false): Promise<void> {
    await db().query(
      `INSERT INTO invoices (workspace_id, stripe_invoice_id, status, subtotal, total, period_start, period_end, paid_at)
       VALUES ($1,$2,$3,10,10, now() + ($4 || ' days')::interval - interval '30 days', now() + ($4 || ' days')::interval, $5)`,
      [workspaceId, `in_${uuidV7()}`, status, String(periodEndOffsetDays), paid ? new Date() : null],
    );
  }
  /** Moves a pending transfer's clock instead of waiting seven days. Writes ISO-8601 'Z' strings, as the service does. */
  async function ageTransfer(workspaceId: string, days: number): Promise<void> {
    const iso = (field: string) =>
      `to_jsonb(to_char(((ownership_transfer->>'${field}')::timestamptz - ($2 || ' days')::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
    await db().query(
      `UPDATE workspaces SET ownership_transfer = jsonb_set(jsonb_set(ownership_transfer, '{initiatedAt}', ${iso("initiatedAt")}), '{expiresAt}', ${iso("expiresAt")}) WHERE id = $1`,
      [workspaceId, String(days)],
    );
  }

  // ===================================================================================================================
  // Initiate
  // ===================================================================================================================

  it("EC-15 initiate · the owner, with step-up, opens a transfer: awaiting_acceptance for seven days, NOTHING mutated yet", async () => {
    const w = await world();
    const before = await snapshot(w.workspaceId);
    const res = await initiate(w.owner, w.recipient.userId);
    expect(res.statusCode, res.body).toBe(200);
    const body = data<{ workspace_id: string; state: string; initiated_by: string; recipient_id: string; initiated_at: string; expires_at: string; resolved_at: string | null }>(res);
    expect(body).toMatchObject({ workspace_id: w.workspaceId, state: "awaiting_acceptance", initiated_by: w.owner.userId, recipient_id: w.recipient.userId, resolved_at: null });
    expect(Date.parse(body.expires_at) - Date.parse(body.initiated_at)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(await snapshot(w.workspaceId), "INVARIANT: execution begins only after acceptance — initiation mutates no role, key, token or invitation").toEqual(before);
    expect(await transferDoc(w.workspaceId)).toMatchObject({ state: "awaiting_acceptance", initiatedBy: w.owner.userId, recipientId: w.recipient.userId });
  });

  it("EC-15 initiate · writes an audit row (notice) by the owner, on the workspace", async () => {
    const w = await world();
    await initiate(w.owner, w.recipient.userId);
    const rows = await auditRows(w.workspaceId, "workspace.ownership_transfer_initiated");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: w.owner.userId, resource_id: w.workspaceId, severity: "notice" });
    expect(rows[0]!.after_state).toMatchObject({ state: "awaiting_acceptance" });
  });

  it("EC-15 actor · an admin (not the owner) cannot initiate: 403 naming workspace:transfer_ownership, nothing written", async () => {
    const w = await world();
    const other = await addMember(w.workspaceId, "admin");
    const res = await initiate(w.recipient, other.userId);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: "forbidden", details: { required_permission: "workspace:transfer_ownership" } });
    expect(await transferDoc(w.workspaceId)).toBeNull();
  });

  it("EC-15 actor · the owner needs a step-up no older than 5 minutes: 401 step_up_required, nothing written", async () => {
    const owner = await ownerWithWorkspace({ stepUp: false });
    const admin = await addMember(owner.workspaceId, "admin");
    const res = await initiate(owner, admin.userId);
    expect(res.statusCode, res.body).toBe(401);
    expect(errorOf(res).code).toBe("step_up_required");
    expect(errorOf(res).details).toEqual({ methods: ["webauthn", "email_otp"] }); // STORY-018: the client re-verifies by method
    expect(await transferDoc(owner.workspaceId)).toBeNull();
  });

  it("EC-15 actor · a step-up exactly outside the 5-minute window is refused", async () => {
    const w = await world();
    await db().query("UPDATE sessions SET last_strong_auth_at = now() - interval '5 minutes 5 seconds' WHERE id = $1", [w.owner.sid]);
    const res = await initiate(w.owner, w.recipient.userId);
    expect(res.statusCode, res.body).toBe(401);
    expect(errorOf(res).code).toBe("step_up_required");
  });

  it("EC-15 recipient · must be an ACTIVE ADMIN here: a manager, a viewer, a removed admin, the owner themself and a stranger are all 409 recipient_not_admin — and a stranger is indistinguishable from a non-admin member", async () => {
    const w = await world();
    const manager = await addMember(w.workspaceId, "manager");
    const viewer = await addMember(w.workspaceId, "viewer");
    const removed = await addMember(w.workspaceId, "admin");
    await db().query("UPDATE workspace_members SET status = 'removed' WHERE workspace_id = $1 AND user_id = $2", [w.workspaceId, removed.userId]);
    const suspended = await addMember(w.workspaceId, "admin");
    await db().query("UPDATE workspace_members SET status = 'suspended' WHERE workspace_id = $1 AND user_id = $2", [w.workspaceId, suspended.userId]);
    const stranger = await newUser();
    const nobody = uuidV7();
    const bodies = new Set<string>();
    for (const candidate of [manager.userId, viewer.userId, removed.userId, suspended.userId, w.owner.userId, stranger, nobody]) {
      const res = await initiate(w.owner, candidate);
      expect(res.statusCode, `${candidate}: ${res.body}`).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: "conflict", details: { reason: "recipient_not_admin" } });
      bodies.add(JSON.stringify(shapeOf(res)));
    }
    expect(bodies.size, "INVARIANT: no membership oracle — every non-admin candidate gets the identical refusal").toBe(1);
    expect(await transferDoc(w.workspaceId)).toBeNull();
  });

  it("EC-15 recipient · an unverified email is refused: 409 recipient_email_unverified", async () => {
    const owner = await ownerWithWorkspace();
    const unverified = await newUser({ verified: false });
    await addMember(owner.workspaceId, "admin", { userId: unverified });
    const res = await initiate(owner, unverified);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "conflict", details: { reason: "recipient_email_unverified" } });
  });

  it("EC-15 recipient · an OTP-only account is NOT a strong authenticator: no credential, a revoked passkey, and an OAuth link are each 409 recipient_no_strong_authenticator", async () => {
    const owner = await ownerWithWorkspace();
    const noCredential = await newUser({ passkey: false });
    const revokedPasskey = await newUser({ passkey: false });
    await addPasskey(revokedPasskey, true);
    const oauthOnly = await newUser({ passkey: false });
    await db().query(`INSERT INTO user_credentials (user_id, kind, provider, external_subject) VALUES ($1,'oauth','google',$2)`, [oauthOnly, randomBytes(8).toString("hex")]);
    for (const userId of [noCredential, revokedPasskey, oauthOnly]) {
      await addMember(owner.workspaceId, "admin", { userId });
      const res = await initiate(owner, userId);
      expect(res.statusCode, `${userId}: ${res.body}`).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: "conflict", details: { reason: "recipient_no_strong_authenticator" } });
    }
    expect(await transferDoc(owner.workspaceId)).toBeNull();
  });

  it("EC-15 recipient · an un-revoked passkey among revoked ones is enough", async () => {
    const owner = await ownerWithWorkspace();
    const userId = await newUser({ passkey: false });
    await addPasskey(userId, true);
    await addPasskey(userId, false);
    await addMember(owner.workspaceId, "admin", { userId });
    expect((await initiate(owner, userId)).statusCode).toBe(200);
  });

  it("EC-15 recipient owns nothing else · a recipient who already owns a workspace is 409 workspace_limit_reached naming that workspace (before anything is decided)", async () => {
    const owner = await ownerWithWorkspace();
    const rival = await ownerWithWorkspace();
    await addMember(owner.workspaceId, "admin", { userId: rival.userId });
    const res = await initiate(owner, rival.userId);
    expect(res.statusCode, res.body).toBe(409);
    const name = (await db().query<{ name: string }>("SELECT name FROM workspaces WHERE id = $1", [rival.workspaceId])).rows[0]!.name;
    expect(errorOf(res)).toMatchObject({ code: "workspace_limit_reached", details: { owned_workspace_id: rival.workspaceId, owned_workspace_name: name } });
    expect(await transferDoc(owner.workspaceId), "nothing was recorded").toBeNull();
  });

  it("EC-15 pending deletion · a workspace with a scheduled deletion refuses initiation: 409 workspace_pending_deletion", async () => {
    const w = await world();
    await db().query("UPDATE workspaces SET deletion_requested_at = now(), deletion_execute_at = now() + interval '30 days' WHERE id = $1", [w.workspaceId]);
    const res = await initiate(w.owner, w.recipient.userId);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "conflict", details: { reason: "workspace_pending_deletion" } });
    expect(await transferDoc(w.workspaceId)).toBeNull();
  });

  it("EC-15 pending deletion · a workspace whose status is pending_deletion is refused outright (never reaches a transfer)", async () => {
    const w = await world();
    await db().query("UPDATE workspaces SET status = 'pending_deletion' WHERE id = $1", [w.workspaceId]);
    const res = await initiate(w.owner, w.recipient.userId);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: "forbidden", details: { reason: "workspace_suspended" } });
    expect(await transferDoc(w.workspaceId)).toBeNull();
  });

  it("EC-15 billing · an unpaid invoice past its due date blocks initiation (open, then uncollectible): 409 past_due_invoice", async () => {
    for (const status of ["open", "uncollectible"]) {
      const w = await world();
      await insertInvoice(w.workspaceId, status, -3);
      const res = await initiate(w.owner, w.recipient.userId);
      expect(res.statusCode, `${status}: ${res.body}`).toBe(409);
      expect(errorOf(res)).toMatchObject({ code: "conflict", details: { reason: "past_due_invoice" } });
      expect(await transferDoc(w.workspaceId)).toBeNull();
    }
  });

  it("EC-15 billing · invoices that are NOT unpaid-and-past-due do not block: paid, void, draft, and an open invoice not yet due", async () => {
    const w = await world();
    await insertInvoice(w.workspaceId, "paid", -40, true);
    await insertInvoice(w.workspaceId, "void", -40);
    await insertInvoice(w.workspaceId, "draft", -40);
    await insertInvoice(w.workspaceId, "open", 5);
    const res = await initiate(w.owner, w.recipient.userId);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("EC-15 billing · ANOTHER workspace's past-due invoice never blocks this one (tenant isolation of the check)", async () => {
    const w = await world();
    const other = await ownerWithWorkspace();
    await insertInvoice(other.workspaceId, "open", -10);
    expect((await initiate(w.owner, w.recipient.userId)).statusCode).toBe(200);
  });

  it("EC-15 state machine · a second initiation while one is pending is 409 transfer_already_pending, and the first is untouched", async () => {
    const w = await world();
    const other = await addMember(w.workspaceId, "admin");
    expect((await initiate(w.owner, w.recipient.userId)).statusCode).toBe(200);
    const before = await transferDoc(w.workspaceId);
    const again = await initiate(w.owner, other.userId);
    expect(again.statusCode, again.body).toBe(409);
    expect(errorOf(again)).toMatchObject({ code: "conflict", details: { reason: "transfer_already_pending" } });
    expect(await transferDoc(w.workspaceId)).toEqual(before);
  });

  it("EC-15 state machine · a lapsed transfer no longer blocks: initiating after seven days replaces it (lazy expiry, no scheduler)", async () => {
    const w = await world();
    const other = await addMember(w.workspaceId, "admin");
    expect((await initiate(w.owner, w.recipient.userId)).statusCode).toBe(200);
    await ageTransfer(w.workspaceId, 8);
    const res = await initiate(w.owner, other.userId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await transferDoc(w.workspaceId)).toMatchObject({ state: "awaiting_acceptance", recipientId: other.userId });
  });

  it("EC-15 initiate · the body is strict: an unknown key and a non-uuid recipient are 400, nothing written", async () => {
    const w = await world();
    const unknownKey = await post(w.owner, "", { recipient_id: w.recipient.userId, retain_credentials: true });
    expect(unknownKey.statusCode).toBe(400);
    const notUuid = await post(w.owner, "", { recipient_id: "someone" });
    expect(notUuid.statusCode).toBe(400);
    const missing = await post(w.owner, "", {});
    expect(missing.statusCode).toBe(400);
    expect(await transferDoc(w.workspaceId)).toBeNull();
  });

  // ===================================================================================================================
  // Accept — dual acceptance and the execution
  // ===================================================================================================================

  /** Initiated, with a rich set of things the execution must (or must not) touch. */
  async function loaded() {
    const w = await world();
    const bystander = await addMember(w.workspaceId, "analyst");
    const apiKeys = [await insertApiKey(w.workspaceId, w.owner.userId), await insertApiKey(w.workspaceId, w.recipient.userId)];
    const passwordless = await insertShareToken(w.workspaceId, w.owner.userId, true);
    const passworded = await insertShareToken(w.workspaceId, w.owner.userId, false);
    const invites = {
      owner: await insertInvitation(w.workspaceId, w.owner.userId, "owner"),
      admin: await insertInvitation(w.workspaceId, w.owner.userId, "admin"),
      manager: await insertInvitation(w.workspaceId, w.owner.userId, "manager"),
      analyst: await insertInvitation(w.workspaceId, w.owner.userId, "analyst"),
      viewer: await insertInvitation(w.workspaceId, w.owner.userId, "viewer"),
    };
    const foreign = await ownerWithWorkspace();
    const foreignKey = await insertApiKey(foreign.workspaceId, foreign.userId);
    const foreignToken = await insertShareToken(foreign.workspaceId, foreign.userId, true);
    const foreignInvite = await insertInvitation(foreign.workspaceId, foreign.userId, "admin");
    const initiated = await initiate(w.owner, w.recipient.userId);
    expect(initiated.statusCode, initiated.body).toBe(200);
    queue.jobs.length = 0;
    return { ...w, bystander, apiKeys, passwordless, passworded, invites, foreign, foreignKey, foreignToken, foreignInvite };
  }

  it("EC-15 dual acceptance · the recipient's accept completes the transfer: state completed, response says so", async () => {
    const x = await loaded();
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<{ state: string; resolved_at: string }>(res)).toMatchObject({ state: "completed" });
    expect(data<{ resolved_at: string | null }>(res).resolved_at).not.toBeNull();
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "completed" });
  });

  it("EC-15 execution · the roles swap: the recipient is the ONLY owner, the old owner is an ADMIN, everyone else is unchanged", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const r = await roles(x.workspaceId);
    expect(r[x.recipient.userId]).toBe("owner");
    expect(r[x.owner.userId], "INVARIANT: the old owner always becomes admin — never removed, never left an owner").toBe("admin");
    expect(r[x.bystander.userId]).toBe("analyst");
    expect(Object.values(r).filter((role) => role === "owner"), "INVARIANT: exactly one owner").toHaveLength(1);
    const ownedByRecipient = await db().query("SELECT 1 FROM workspace_members WHERE user_id = $1 AND role = 'owner' AND status = 'active'", [x.recipient.userId]);
    expect(ownedByRecipient.rowCount, "INVARIANT: the one-owned-workspace index still holds for the recipient").toBe(1);
  });

  it("EC-15 execution · EVERY api key of the workspace is revoked, whoever made it; another workspace's keys are untouched", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const keys = await db().query<{ id: string; revoked_at: Date | null }>("SELECT id, revoked_at FROM api_keys WHERE workspace_id = $1", [x.workspaceId]);
    expect(keys.rows.map((k) => k.id).sort()).toEqual([...x.apiKeys].sort());
    for (const key of keys.rows) expect(key.revoked_at, `key ${key.id}`).not.toBeNull();
    const foreign = await db().query<{ revoked_at: Date | null }>("SELECT revoked_at FROM api_keys WHERE id = $1", [x.foreignKey]);
    expect(foreign.rows[0]!.revoked_at, "INVARIANT: revocation is scoped to the transferred workspace").toBeNull();
  });

  it("EC-15 execution · every PASSWORDLESS share token is force-revoked; password-protected ones are retained; another workspace's passwordless token is untouched", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const revokedAt = async (id: string) => (await db().query<{ r: Date | null }>("SELECT revoked_at AS r FROM share_tokens WHERE id = $1", [id])).rows[0]!.r;
    expect(await revokedAt(x.passwordless)).not.toBeNull();
    expect(await revokedAt(x.passworded), "this slice keeps password-protected links (the retain/revoke inventory is a follow-up)").toBeNull();
    expect(await revokedAt(x.foreignToken)).toBeNull();
  });

  it("EC-15 execution · pending owner- and admin-role invitations are revoked; manager, analyst and viewer ones are kept; another workspace's admin invitation is untouched", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const revokedAt = async (id: string) => (await db().query<{ r: Date | null }>("SELECT revoked_at AS r FROM workspace_invitations WHERE id = $1", [id])).rows[0]!.r;
    expect(await revokedAt(x.invites.owner)).not.toBeNull();
    expect(await revokedAt(x.invites.admin)).not.toBeNull();
    expect(await revokedAt(x.invites.manager)).toBeNull();
    expect(await revokedAt(x.invites.analyst)).toBeNull();
    expect(await revokedAt(x.invites.viewer)).toBeNull();
    expect(await revokedAt(x.foreignInvite)).toBeNull();
  });

  it("EC-15 execution · an already-accepted privileged invitation is history and stays as it was (only PENDING ones are revoked)", async () => {
    const x = await loaded();
    const accepted = await insertInvitation(x.workspaceId, x.owner.userId, "admin");
    await db().query("UPDATE workspace_invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1", [accepted, x.recipient.userId]);
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const row = (await db().query<{ revoked_at: Date | null }>("SELECT revoked_at FROM workspace_invitations WHERE id = $1", [accepted])).rows[0]!;
    expect(row.revoked_at).toBeNull();
  });

  it("EC-15 execution · entitlement_version is bumped by exactly one, so any stale token must refresh", async () => {
    const x = await loaded();
    const before = await entVersion(x.workspaceId);
    expect((await accept(x.recipient)).statusCode).toBe(200);
    expect(await entVersion(x.workspaceId)).toBe(before + 1);
  });

  it("EC-15 execution · BOTH users' sessions are revoked; an unrelated member's session survives", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    expect(await sessionRevoked(x.owner.sid), "INVARIANT: the departed owner keeps no live session").toBe(true);
    expect(await sessionRevoked(x.recipient.sid)).toBe(true);
    expect(await sessionRevoked(x.bystander.sid)).toBe(false);
  });

  it("EC-15 execution · the old owner's pre-transfer cookie no longer reaches the workspace as owner (stale-token isolation exception)", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const res = await harness.app().inject({ method: "GET", url: apiUrl(`/workspaces/${x.workspaceId}`), headers: { cookie: x.owner.cookie } });
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
  });

  it("EC-15 audit · accept writes ONE critical workspace.ownership_transferred row, by the recipient, with the revocation counts (ids in state are redacted by the audit writer, so the row's actor_id and resource_id carry them)", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const rows = await auditRows(x.workspaceId, "workspace.ownership_transferred");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: "critical", actor_id: x.recipient.userId, resource_id: x.workspaceId });
    expect(rows[0]!.after_state).toMatchObject({ previous_owner_role: "admin", revoked: { keys_revoked: 2, links_revoked: 1, invitations: 2 } });
    expect(rows[0]!.before_state).toMatchObject({ recipient_role: "admin" });
    const initiated = await auditRows(x.workspaceId, "workspace.ownership_transfer_initiated");
    expect(initiated, "the departing owner's own row names them as the actor").toHaveLength(1);
    expect(initiated[0]!.actor_id).toBe(x.owner.userId);
  });

  it("EC-15 audit · the hash chain is unbroken after the transfer (prev_hash links every row to its predecessor)", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const broken = await db().query(
      `SELECT seq FROM (SELECT seq, prev_hash, lag(row_hash) OVER (ORDER BY seq) AS expected FROM audit_log WHERE workspace_id = $1) t
        WHERE expected IS NOT NULL AND prev_hash <> expected`,
      [x.workspaceId],
    );
    expect(broken.rowCount).toBe(0);
  });

  it("EC-15 billing · a workspace billing_email that was the OLD owner's address stops pointing at them (billing mail follows the new owner); a deliberate other address is kept", async () => {
    const x = await loaded();
    const oldEmail = (await db().query<{ email: string }>("SELECT email::text AS email FROM users WHERE id = $1", [x.owner.userId])).rows[0]!.email;
    await db().query("UPDATE workspaces SET billing_email = $2 WHERE id = $1", [x.workspaceId, oldEmail]);
    expect((await accept(x.recipient)).statusCode).toBe(200);
    expect((await db().query<{ b: string | null }>("SELECT billing_email::text AS b FROM workspaces WHERE id = $1", [x.workspaceId])).rows[0]!.b, "INVARIANT: no billing mail to the departed owner").toBeNull();

    const y = await loaded();
    await db().query("UPDATE workspaces SET billing_email = 'finance@acme.example' WHERE id = $1", [y.workspaceId]);
    expect((await accept(y.recipient)).statusCode).toBe(200);
    expect((await db().query<{ b: string | null }>("SELECT billing_email::text AS b FROM workspaces WHERE id = $1", [y.workspaceId])).rows[0]!.b).toBe("finance@acme.example");
  });

  it("EC-15 execution · if the owner changed since the offer (a stale offer), accept is refused 409 transfer_not_pending and nothing moves", async () => {
    const x = await loaded();
    const heir = await addMember(x.workspaceId, "admin");
    // Out-of-band ownership change by a writer that knows nothing of the transfer.
    await db().query("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2", [x.workspaceId, x.owner.userId]);
    await db().query("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [x.workspaceId, heir.userId]);
    const before = await snapshot(x.workspaceId);
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "transfer_not_pending" });
    expect(await snapshot(x.workspaceId)).toEqual(before);
  });

  it("EC-15 actor · the guard's membership cache can lag a transfer by up to 30 s; the service re-reads the LIVE owner row, so a stale 'owner' cannot initiate or cancel", async () => {
    const w = await world();
    const warm = await initiate(w.owner, w.recipient.userId); // warms the cache with role=owner
    expect(warm.statusCode, warm.body).toBe(200);
    // The owner is demoted behind the cache's back (another instance, or a direct write).
    await db().query("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2", [w.workspaceId, w.owner.userId]);
    await db().query("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [w.workspaceId, w.recipient.userId]);
    const res = await cancel(w.owner);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: "forbidden", details: { required_permission: "workspace:transfer_ownership" } });
  });

  it("EC-15 execution · after commit, exactly ONE billing.customer_email job is enqueued for this workspace and the NEW owner (KAD-06: no Stripe call in the request)", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    expect(queue.jobs).toHaveLength(1);
    expect(queue.jobs[0]).toMatchObject({ name: "billing.customer_email", workspaceId: x.workspaceId });
    expect(queue.jobs[0]!.payload).toMatchObject({ ownerUserId: x.recipient.userId });
    expect(JSON.stringify(queue.jobs[0]!.payload), "no PII in the job").not.toContain("@");
  });

  it("EC-15 observability · accept emits nominara_workspace_ownership_transfers_total{outcome=completed} and a log line that carries the workspace ID and no name, address or token", async () => {
    const x = await loaded();
    const lines: string[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((message: unknown) => {
      lines.push(typeof message === "string" ? message : JSON.stringify(message));
    });
    try {
      expect((await accept(x.recipient)).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const metric = lines.find((l) => l.includes("nominara_workspace_ownership_transfers_total") && l.includes("completed"));
    expect(metric, "the completed counter was incremented").toBeDefined();
    const line = lines.find((l) => l.includes("ownership transferred"));
    expect(line, "the completion log line").toContain(`workspace_id=${x.workspaceId}`);
    for (const l of lines.filter((l) => l.includes("ownership transfer") || l.includes("nominara_workspace_ownership"))) {
      expect(l, "no workspace name, e-mail address or credential in an ownership-transfer log line").not.toMatch(/Acme|@|cookie|bearer|secret|token=|token_hash|password_hash/i);
    }
  });

  it("EC-15 atomicity · if a write AFTER the swap fails (the request's own audit row), NOTHING is applied — roles, keys, tokens, invitations, version and sessions are as before — and no job is enqueued", async () => {
    const x = await loaded();
    await db().query(`
      CREATE FUNCTION refuse_accept_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'workspace.ownership_transfer_accepted' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
        RETURN NEW;
      END $$`);
    await db().query(`CREATE TRIGGER refuse_accept_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION refuse_accept_audit_fn()`);
    const before = await snapshot(x.workspaceId);
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(500);
    expect(await snapshot(x.workspaceId), "INVARIANT: the swap and every revocation commit together or not at all").toEqual(before);
    expect(await sessionRevoked(x.owner.sid)).toBe(false);
    expect(await sessionRevoked(x.recipient.sid)).toBe(false);
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "awaiting_acceptance" });
    expect(await auditRows(x.workspaceId, "workspace.ownership_transferred")).toHaveLength(0);
    expect(queue.jobs, "INVARIANT: nothing leaves the process for a transfer that rolled back").toHaveLength(0);
    await db().query("DROP TRIGGER refuse_accept_audit ON audit_log");
  });

  it("EC-15 execution · a queue outage does not undo the committed transfer (the enqueue is a hint after commit, never part of it)", async () => {
    const x = await loaded();
    queue.failWith = new Error("redis is down");
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(200);
    expect((await roles(x.workspaceId))[x.recipient.userId]).toBe("owner");
  });

  it("EC-15 execution · nothing is enqueued when the accept is refused", async () => {
    const x = await loaded();
    await ageTransfer(x.workspaceId, 8);
    expect((await accept(x.recipient)).statusCode).toBe(409);
    expect(queue.jobs).toHaveLength(0);
  });

  it("EC-15 dual acceptance · the recipient needs a step-up no older than 5 minutes: 401 step_up_required, NOTHING mutated, the transfer still pending", async () => {
    const x = await loaded();
    const recipient = await actorIn(x.workspaceId, x.recipient.userId, "admin", false);
    const before = await snapshot(x.workspaceId);
    const res = await accept(recipient);
    expect(res.statusCode, res.body).toBe(401);
    expect(errorOf(res).code).toBe("step_up_required");
    expect(errorOf(res).details).toEqual({ methods: ["webauthn", "email_otp"] }); // STORY-018
    expect(await snapshot(x.workspaceId)).toEqual(before);
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "awaiting_acceptance" });
    expect(queue.jobs).toHaveLength(0);
  });

  it("EC-15 dual acceptance · the OWNER cannot accept their own transfer: 403, nothing mutated", async () => {
    const x = await loaded();
    const before = await snapshot(x.workspaceId);
    const res = await accept(x.owner);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res).code).toBe("forbidden");
    expect(await snapshot(x.workspaceId)).toEqual(before);
  });

  it("EC-15 dual acceptance · another admin who is NOT the named recipient cannot accept: 403, nothing mutated", async () => {
    const x = await loaded();
    const impostor = await addMember(x.workspaceId, "admin");
    const before = await snapshot(x.workspaceId);
    const res = await accept(impostor);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res)).toMatchObject({ code: "forbidden", details: { required_permission: "transfer_ownership_recipient" } });
    expect(await snapshot(x.workspaceId)).toEqual(before);
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "awaiting_acceptance" });
  });

  it("EC-15 dual acceptance · a non-recipient is refused identically whether a transfer is pending or not (no oracle for who is being offered ownership)", async () => {
    const x = await loaded();
    const other = await world();
    const withPending = await accept(await addMember(x.workspaceId, "admin"));
    const withoutPending = await accept(await addMember(other.workspaceId, "admin"));
    expect(withPending.statusCode).toBe(403);
    expect(withoutPending.statusCode).toBe(403);
    expect(shapeOf(withPending)).toEqual(shapeOf(withoutPending));
  });

  it("EC-15 state machine · accepting with no transfer at all is 409 transfer_not_pending", async () => {
    const w = await world();
    // The recipient is named by nothing; the only honest answer for an admin is 'no transfer to act on'.
    const res = await accept(w.recipient);
    expect([403, 409]).toContain(res.statusCode);
    expect(await transferDoc(w.workspaceId)).toBeNull();
    expect((await roles(w.workspaceId))[w.owner.userId]).toBe("owner");
  });

  it("EC-15 state machine · an accepted transfer cannot be accepted twice; the repeat changes nothing", async () => {
    const x = await loaded();
    expect((await accept(x.recipient)).statusCode).toBe(200);
    const after = await snapshot(x.workspaceId);
    const again = await accept(await actorIn(x.workspaceId, x.recipient.userId, "owner", true));
    expect([401, 403, 409], again.body).toContain(again.statusCode);
    expect(await snapshot(x.workspaceId)).toEqual(after);
    expect(await auditRows(x.workspaceId, "workspace.ownership_transferred")).toHaveLength(1);
  });

  it("EC-15 expiry · accepting after seven days is refused 409 transfer_expired, NOTHING was mutated, and the lapse is recorded", async () => {
    const x = await loaded();
    await ageTransfer(x.workspaceId, 8);
    const before = await snapshot(x.workspaceId);
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "conflict", details: { reason: "transfer_expired" } });
    expect(await snapshot(x.workspaceId), "INVARIANT: an expired transfer mutates nothing").toEqual(before);
    expect(await transferDoc(x.workspaceId), "the refusal committed the lapse instead of rolling it back with the error").toMatchObject({ state: "expired" });
    expect(await auditRows(x.workspaceId, "workspace.ownership_transfer_expired")).toHaveLength(1);
    const again = await accept(x.recipient);
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).details).toMatchObject({ reason: "transfer_not_pending" });
  });

  it("EC-15 expiry · one second before the deadline the transfer can still be accepted", async () => {
    const x = await loaded();
    await db().query(
      `UPDATE workspaces SET ownership_transfer = jsonb_set(ownership_transfer, '{expiresAt}', to_jsonb(to_char((now() + interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) WHERE id = $1`,
      [x.workspaceId],
    );
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("EC-15 decline/cancel · declining and cancelling an expired transfer record the lapse and refuse (they never resurrect it)", async () => {
    const x = await loaded();
    await ageTransfer(x.workspaceId, 8);
    const res = await decline(x.recipient);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "transfer_expired" });
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "expired" });
  });

  // ---- preconditions are RE-CHECKED at accept: the world may have moved since the offer ----------------------------

  it("EC-15 re-check at accept · a recipient who is no longer an active admin cannot accept: 409 recipient_not_admin, nothing mutated, transfer stays pending", async () => {
    const x = await loaded();
    const before = await snapshot(x.workspaceId);
    await db().query("UPDATE workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2", [x.workspaceId, x.recipient.userId]);
    const demoted = await actorIn(x.workspaceId, x.recipient.userId, "viewer", true);
    const res = await accept(demoted);
    expect([403, 409], res.body).toContain(res.statusCode);
    const members = await roles(x.workspaceId);
    expect(members[x.owner.userId]).toBe("owner");
    expect(members[x.recipient.userId]).toBe("viewer");
    expect((await snapshot(x.workspaceId)).keys).toEqual(before.keys);
  });

  it("EC-15 re-check at accept · a recipient who lost their last passkey since the offer cannot accept: 409 recipient_no_strong_authenticator, nothing mutated", async () => {
    const x = await loaded();
    await db().query("UPDATE user_credentials SET revoked_at = now() WHERE user_id = $1", [x.recipient.userId]);
    const before = await snapshot(x.workspaceId);
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "recipient_no_strong_authenticator" });
    expect(await snapshot(x.workspaceId)).toEqual(before);
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "awaiting_acceptance" });
  });

  it("EC-15 re-check at accept · a recipient who has since come to OWN another workspace gets 409 workspace_limit_reached — a clean refusal, not a raw constraint violation — and nothing is half-applied", async () => {
    const x = await loaded();
    // The recipient founds a workspace of their own after being offered this one.
    const tokens = await sessions.createSession(x.recipient.userId);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Recipient Co", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const before = await snapshot(x.workspaceId);
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).code).toBe("workspace_limit_reached");
    expect(await snapshot(x.workspaceId), "INVARIANT: the failed promotion rolled back the demotion, the revocations and the audit row too").toEqual(before);
    expect(await auditRows(x.workspaceId, "workspace.ownership_transferred")).toHaveLength(0);
  });

  it("EC-15 re-check at accept · an unpaid invoice that went past due since the offer blocks acceptance: 409 past_due_invoice, nothing mutated", async () => {
    const x = await loaded();
    await insertInvoice(x.workspaceId, "open", -2);
    const before = await snapshot(x.workspaceId);
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "past_due_invoice" });
    expect(await snapshot(x.workspaceId)).toEqual(before);
  });

  it("EC-15 re-check at accept · a deletion scheduled since the offer blocks acceptance: 409 workspace_pending_deletion, nothing mutated", async () => {
    const x = await loaded();
    await db().query("UPDATE workspaces SET deletion_requested_at = now(), deletion_execute_at = now() + interval '30 days' WHERE id = $1", [x.workspaceId]);
    const before = await snapshot(x.workspaceId);
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "workspace_pending_deletion" });
    expect(await snapshot(x.workspaceId)).toEqual(before);
  });

  // ===================================================================================================================
  // Decline and cancel
  // ===================================================================================================================

  it("EC-15 decline · the recipient declines: state declined, NOTHING mutated, audited; no step-up needed to say no", async () => {
    const x = await loaded();
    const recipient = await actorIn(x.workspaceId, x.recipient.userId, "admin", false);
    const before = await snapshot(x.workspaceId);
    const res = await decline(recipient);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<{ state: string }>(res).state).toBe("declined");
    expect(await snapshot(x.workspaceId)).toEqual(before);
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "declined" });
    expect(await auditRows(x.workspaceId, "workspace.ownership_transfer_declined")).toHaveLength(1);
    expect(queue.jobs).toHaveLength(0);
  });

  it("EC-15 decline · only the named recipient can decline: the owner and another admin get 403, the transfer stays pending", async () => {
    const x = await loaded();
    const impostor = await addMember(x.workspaceId, "admin");
    for (const actor of [x.owner, impostor]) {
      const res = await decline(actor);
      expect(res.statusCode, res.body).toBe(403);
    }
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "awaiting_acceptance" });
  });

  it("EC-15 decline · after a decline the offer is dead (accept is 409 transfer_not_pending) and a new transfer can be initiated", async () => {
    const x = await loaded();
    expect((await decline(x.recipient)).statusCode).toBe(200);
    const acceptAfter = await accept(x.recipient);
    expect(acceptAfter.statusCode, acceptAfter.body).toBe(409);
    expect(errorOf(acceptAfter).details).toMatchObject({ reason: "transfer_not_pending" });
    expect((await initiate(x.owner, x.recipient.userId)).statusCode).toBe(200);
  });

  it("EC-15 cancel · the initiating owner cancels: state cancelled, NOTHING mutated, audited", async () => {
    const x = await loaded();
    const before = await snapshot(x.workspaceId);
    const res = await cancel(x.owner);
    expect(res.statusCode, res.body).toBe(200);
    expect(data<{ state: string }>(res).state).toBe("cancelled");
    expect(await snapshot(x.workspaceId)).toEqual(before);
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "cancelled" });
    expect(await auditRows(x.workspaceId, "workspace.ownership_transfer_cancelled")).toHaveLength(1);
  });

  it("EC-15 cancel · the recipient and other admins cannot cancel (403 naming workspace:transfer_ownership); the transfer stays pending", async () => {
    const x = await loaded();
    for (const actor of [x.recipient, await addMember(x.workspaceId, "admin")]) {
      const res = await cancel(actor);
      expect(res.statusCode, res.body).toBe(403);
      expect(errorOf(res)).toMatchObject({ code: "forbidden", details: { required_permission: "workspace:transfer_ownership" } });
    }
    expect(await transferDoc(x.workspaceId)).toMatchObject({ state: "awaiting_acceptance" });
  });

  it("EC-15 cancel · after a cancel the recipient can no longer accept: 409 transfer_not_pending, roles unchanged", async () => {
    const x = await loaded();
    expect((await cancel(x.owner)).statusCode).toBe(200);
    const res = await accept(x.recipient);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "transfer_not_pending" });
    expect((await roles(x.workspaceId))[x.owner.userId]).toBe("owner");
  });

  it("EC-15 cancel · cancelling with nothing pending is 409 transfer_not_pending", async () => {
    const w = await world();
    const res = await cancel(w.owner);
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res).details).toMatchObject({ reason: "transfer_not_pending" });
  });

  // ===================================================================================================================
  // Tenant isolation
  // ===================================================================================================================

  it("EC-15 isolation · another workspace's owner cannot initiate, accept, decline or cancel here: 403 workspace_mismatch, and A's transfer is untouched", async () => {
    const x = await loaded();
    const intruder = await ownerWithWorkspace();
    const before = await snapshot(x.workspaceId);
    const doc = await transferDoc(x.workspaceId);
    for (const [name, res] of [
      ["initiate", await initiate(intruder, intruder.userId, x.workspaceId)],
      ["accept", await accept(intruder, x.workspaceId)],
      ["decline", await decline(intruder, x.workspaceId)],
      ["cancel", await cancel(intruder, x.workspaceId)],
    ] as const) {
      expect(res.statusCode, `${name}: ${res.body}`).toBe(403);
      expect(errorOf(res).code, name).toBe("workspace_mismatch");
    }
    expect(await snapshot(x.workspaceId)).toEqual(before);
    expect(await transferDoc(x.workspaceId)).toEqual(doc);
  });

  it("EC-15 isolation · the recipient's token for ANOTHER workspace cannot accept this one (a token is never valid for two tenants)", async () => {
    const x = await loaded();
    const elsewhere = await ownerWithWorkspace();
    const member = await addMember(elsewhere.workspaceId, "admin", { userId: x.recipient.userId });
    const res = await accept(member, x.workspaceId);
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res).code).toBe("workspace_mismatch");
    expect((await roles(x.workspaceId))[x.owner.userId]).toBe("owner");
  });

  it("EC-15 isolation · a transfer in one workspace does not affect another workspace's transfer state", async () => {
    const a = await world();
    const b = await world();
    expect((await initiate(a.owner, a.recipient.userId)).statusCode).toBe(200);
    expect(await transferDoc(b.workspaceId)).toBeNull();
    expect((await accept(a.recipient)).statusCode).toBe(200);
    expect((await roles(b.workspaceId))[b.owner.userId]).toBe("owner");
    expect(await transferDoc(b.workspaceId)).toBeNull();
  });

  // ===================================================================================================================
  // Concurrency
  // ===================================================================================================================

  it("EC-15 concurrency · two simultaneous accepts end with EXACTLY ONE completed transfer: one 200, one audit row, one version bump, one job, one owner", async () => {
    for (let round = 0; round < 3; round++) {
      const x = await loaded();
      const before = await entVersion(x.workspaceId);
      const results = await Promise.all([accept(x.recipient), accept(x.recipient)]);
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 200), `round ${round}: ${results.map((r) => r.body).join(" | ")}`).toHaveLength(1);
      for (const loser of results.filter((r) => r.statusCode !== 200)) expect([401, 409]).toContain(loser.statusCode);
      expect(await auditRows(x.workspaceId, "workspace.ownership_transferred")).toHaveLength(1);
      expect(await entVersion(x.workspaceId)).toBe(before + 1);
      expect(queue.jobs.filter((j) => j.workspaceId === x.workspaceId)).toHaveLength(1);
      const r = await roles(x.workspaceId);
      expect(Object.values(r).filter((role) => role === "owner")).toHaveLength(1);
      expect(r[x.recipient.userId]).toBe("owner");
      expect(r[x.owner.userId]).toBe("admin");
    }
  }, 120_000);

  it("EC-15 concurrency · accept racing cancel ends in exactly ONE outcome, never both and never neither", async () => {
    let completed = 0;
    let cancelled = 0;
    for (let round = 0; round < 6; round++) {
      const x = await loaded();
      const [a, c] = await Promise.all([accept(x.recipient), cancel(x.owner)]);
      const doc = await transferDoc(x.workspaceId);
      const r = await roles(x.workspaceId);
      const acceptWon = a.statusCode === 200;
      const cancelWon = c.statusCode === 200;
      expect(acceptWon !== cancelWon, `round ${round}: accept ${a.statusCode} ${a.body} / cancel ${c.statusCode} ${c.body}`).toBe(true);
      if (acceptWon) {
        completed++;
        expect(doc).toMatchObject({ state: "completed" });
        expect(r[x.recipient.userId]).toBe("owner");
        expect(r[x.owner.userId]).toBe("admin");
        expect(await auditRows(x.workspaceId, "workspace.ownership_transfer_cancelled")).toHaveLength(0);
      } else {
        cancelled++;
        expect(doc).toMatchObject({ state: "cancelled" });
        expect(r[x.owner.userId]).toBe("owner");
        expect(r[x.recipient.userId]).toBe("admin");
        expect(await auditRows(x.workspaceId, "workspace.ownership_transferred")).toHaveLength(0);
        expect((await db().query("SELECT 1 FROM api_keys WHERE workspace_id = $1 AND revoked_at IS NOT NULL", [x.workspaceId])).rowCount).toBe(0);
      }
    }
    expect(completed + cancelled).toBe(6);
  }, 180_000);

  it("EC-15 concurrency · accept racing decline ends in exactly one outcome", async () => {
    for (let round = 0; round < 4; round++) {
      const x = await loaded();
      const [a, d] = await Promise.all([accept(x.recipient), decline(x.recipient)]);
      const wins = [a.statusCode === 200, d.statusCode === 200].filter(Boolean).length;
      expect(wins, `round ${round}: ${a.body} | ${d.body}`).toBe(1);
      const doc = await transferDoc(x.workspaceId);
      const r = await roles(x.workspaceId);
      if (a.statusCode === 200) expect([doc?.state, r[x.recipient.userId]]).toEqual(["completed", "owner"]);
      else expect([doc?.state, r[x.owner.userId]]).toEqual(["declined", "owner"]);
    }
  }, 120_000);

  it("EC-15 concurrency · the audit chain does not fork under concurrent transfer traffic", async () => {
    const x = await loaded();
    await Promise.all([accept(x.recipient), accept(x.recipient), cancel(x.owner), decline(x.recipient)]);
    const dup = await db().query(`SELECT prev_hash FROM audit_log WHERE workspace_id = $1 GROUP BY prev_hash HAVING count(*) > 1`, [x.workspaceId]);
    expect(dup.rowCount, "two rows sharing a prev_hash is a forked chain").toBe(0);
  }, 60_000);
});

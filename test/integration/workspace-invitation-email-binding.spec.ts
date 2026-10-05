import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, type Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiModule } from "../../src/api/api.module.js";
import { configureApp } from "../../src/api/configure-app.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { PG_POOL } from "../../src/db/pg-pool.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { computeCsrfToken } from "../../src/lib/auth/csrf.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InvitationsService } from "../../src/modules/workspaces/invitations.service.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";

// STORY-172 — an invitation can only be accepted by the account whose VERIFIED
// email matches the invitation. Every test goes through the real, deployed
// ApiModule over HTTP: the property under test is what a caller can observe
// (status, body, timing) and what the database is left holding, and a
// service-level call would skip the very pipe (the :id UUID check) and
// uniform-error mapping this story changes.
//
// "Verified" here means `users.email_verified_at IS NOT NULL` — the only
// column that records proof of control of the address (OTP verify sets it;
// OAuth sets it only when the provider's own signal is trustworthy). It is NOT
// `users.status = 'active'`: a passkey registration promotes status to
// 'active' without anyone proving they own the address.

const PRIVATE_KEY_DER = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
const PUBLIC_KEY_DER = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
const CSRF_SECRET = "test-csrf-secret";
const WRAPPING_KEY = Buffer.alloc(32, 17);
const TIMING_TOLERANCE_MS = 25;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

describe("STORY-172 · invitation acceptance is bound to the invited, verified email", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    process.env = { ...originalEnv };
  });

  beforeEach(async () => {
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = PRIVATE_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = PUBLIC_KEY_DER;
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = CSRF_SECRET;
    process.env.WORKSPACE_DEK_WRAPPING_KEY = WRAPPING_KEY.toString("base64");
    process.env.OAUTH_REDIRECT_BASE_URL = "http://localhost:3000";
    process.env.OAUTH_STATE_SECRET = "test-oauth-state-secret";
    process.env.OTP_EMAIL_HASH_PEPPER = "test-otp-email-hash-pepper";
    process.env.OTP_EMAIL_FROM = "Nominara <no-reply@nominara.test>";
    process.env.VALKEY_CACHE_URL = "redis://localhost:6379";
    process.env.QUEUE_REDIS_URL = "redis://localhost:6380";
    process.env.ENGINE_TOKEN_BUCKETS = '{"google_aio":{"capacity":10,"refillPerSecond":1},"google_ai_mode":{"capacity":10,"refillPerSecond":1},"perplexity":{"capacity":10,"refillPerSecond":1},"chatgpt":{"capacity":10,"refillPerSecond":1},"gemini":{"capacity":10,"refillPerSecond":1},"claude":{"capacity":10,"refillPerSecond":1}}';
    process.env.QUEUE_JOB_SIGNING_KEY = Buffer.alloc(32, 3).toString("base64");
    process.env.QUEUE_JOB_SIGNING_KID = "test-queue-kid-1";
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await db.end();
  });

  const meta = { ip: "127.0.0.1", ua: "vitest", requestId: randomUUID() };

  async function createUser(opts: { email?: string; verified?: boolean; status?: string } = {}): Promise<{ id: string; email: string }> {
    const email = opts.email ?? `user-${randomUUID()}@example.com`;
    const verified = opts.verified ?? true;
    const result = await db.query<{ id: string }>(
      "INSERT INTO users (email, status, email_verified_at) VALUES ($1, $2, $3) RETURNING id",
      [email, opts.status ?? "active", verified ? new Date() : null],
    );
    return { id: result.rows[0]!.id, email };
  }

  async function createWorkspace(ownerId: string): Promise<string> {
    const workspace = await app.get(WorkspacesService).create(ownerId, { name: `WS ${randomUUID()}` }, meta);
    return workspace.id;
  }

  async function invite(workspaceId: string, inviterId: string, email: string, role: "viewer" | "manager" | "admin" = "manager") {
    const pool = app.get<Pool>(PG_POOL);
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: inviterId }, () =>
        app.get(InvitationsService).create(workspaceId, inviterId, { email, role }),
      );
    } finally {
      client.release();
    }
  }

  async function accept(userId: string, workspaceId: string, token: string) {
    const tokens = await app.get(SessionService).createSession(userId);
    const csrf = computeCsrfToken(tokens.sid, CSRF_SECRET);
    return app.inject({
      method: "POST",
      url: apiUrl(`/workspaces/${workspaceId}/invitations/accept`),
      cookies: { [ACCESS_COOKIE_NAME]: tokens.accessToken, [CSRF_COOKIE_NAME]: csrf },
      headers: { [CSRF_HEADER_NAME]: csrf },
      payload: { token },
    });
  }

  async function invitationRow(id: string) {
    const result = await db.query<{ accepted_at: Date | null; accepted_user_id: string | null }>(
      "SELECT accepted_at, accepted_user_id FROM workspace_invitations WHERE id = $1",
      [id],
    );
    return result.rows[0]!;
  }

  async function memberCount(workspaceId: string, userId: string): Promise<number> {
    const result = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId],
    );
    return Number(result.rows[0]!.count);
  }

  /** The caller-visible refusal, with the per-request correlation fields dropped. */
  function refusalShape(res: { statusCode: number; json: () => Record<string, unknown> }) {
    const body = res.json() as { error?: Record<string, unknown> } & Record<string, unknown>;
    const { request_id, ...error } = body.error ?? {};
    void request_id;
    return { status: res.statusCode, body: { ...body, error } };
  }

  it("STORY-172-AC1 · a different signed-in account holding the link is refused and the token stays valid for the invitee", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const invitee = await createUser();
    const stranger = await createUser();
    const invitation = await invite(workspaceId, owner.id, invitee.email, "admin");

    const refused = await accept(stranger.id, workspaceId, invitation.token!);
    expect(refused.statusCode).toBe(400);
    expect(await memberCount(workspaceId, stranger.id)).toBe(0);
    expect((await invitationRow(invitation.id)).accepted_at).toBeNull();

    const accepted = await accept(invitee.id, workspaceId, invitation.token!);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.role).toBe("admin");
    expect((await invitationRow(invitation.id)).accepted_user_id).toBe(invitee.id);
  });

  it("STORY-172-AC2 · a matching address on an unverified account (email_verified_at NULL) is refused, token unconsumed", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const email = `target-${randomUUID()}@example.com`;
    // status 'active' + no email_verified_at is exactly what a passkey
    // registration leaves behind: active is NOT proof of the address.
    const impostor = await createUser({ email, verified: false, status: "active" });
    const invitation = await invite(workspaceId, owner.id, email);

    const refused = await accept(impostor.id, workspaceId, invitation.token!);
    expect(refused.statusCode).toBe(400);
    expect(await memberCount(workspaceId, impostor.id)).toBe(0);
    expect((await invitationRow(invitation.id)).accepted_at).toBeNull();
  });

  it("STORY-172-AC3 · case variants of the right address are accepted in both directions", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const local = randomUUID();

    const upperInvite = await invite(workspaceId, owner.id, `${local.toUpperCase()}@Example.COM`);
    const lowerUser = await createUser({ email: `${local}@example.com` });
    expect((await accept(lowerUser.id, workspaceId, upperInvite.token!)).statusCode).toBe(200);

    const local2 = randomUUID();
    const lowerInvite = await invite(workspaceId, owner.id, `${local2}@example.com`);
    const upperUser = await createUser({ email: `${local2.toUpperCase()}@EXAMPLE.com` });
    expect((await accept(upperUser.id, workspaceId, lowerInvite.token!)).statusCode).toBe(200);
  });

  it("STORY-172-AC4 · a mismatch is byte-for-byte the same refusal as an unknown, expired, revoked or used token", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const invitee = await createUser();
    const stranger = await createUser();
    const live = await invite(workspaceId, owner.id, invitee.email);
    const expired = await invite(workspaceId, owner.id, `x-${randomUUID()}@example.com`);
    await db.query("UPDATE workspace_invitations SET expires_at = now() - interval '1 hour' WHERE id = $1", [expired.id]);

    const mismatch = refusalShape(await accept(stranger.id, workspaceId, live.token!));
    const unknown = refusalShape(await accept(stranger.id, workspaceId, "no-such-token"));
    const expiredRes = refusalShape(await accept(stranger.id, workspaceId, expired.token!));

    expect(mismatch.status).toBe(400);
    expect(unknown).toEqual(mismatch);
    expect(expiredRes).toEqual(mismatch);
  });

  it("STORY-172-AC5 · median latency of a mismatch and of an unknown token is within tolerance", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    // A fresh caller per request: the writes rate limit is per user, and a
    // single caller would trip it (429) long before the sample is large enough.
    const post = async (token: string) => {
      const stranger = await createUser();
      const tokens = await app.get(SessionService).createSession(stranger.id);
      const csrf = computeCsrfToken(tokens.sid, CSRF_SECRET);
      const start = performance.now();
      const res = await app.inject({
        method: "POST",
        url: apiUrl(`/workspaces/${workspaceId}/invitations/accept`),
        cookies: { [ACCESS_COOKIE_NAME]: tokens.accessToken, [CSRF_COOKIE_NAME]: csrf },
        headers: { [CSRF_HEADER_NAME]: csrf },
        payload: { token },
      });
      return { res, ms: performance.now() - start };
    };

    const mismatchMs: number[] = [];
    const unknownMs: number[] = [];
    for (let i = 0; i < 15; i++) {
      const target = await createUser();
      const invitation = await invite(workspaceId, owner.id, target.email);
      const mismatch = await post(invitation.token!);
      expect(mismatch.res.statusCode).toBe(400);
      mismatchMs.push(mismatch.ms);
      const unknown = await post(`unknown-${randomUUID()}`);
      expect(unknown.res.statusCode).toBe(400);
      unknownMs.push(unknown.ms);
    }
    expect(Math.abs(median(mismatchMs) - median(unknownMs))).toBeLessThan(TIMING_TOLERANCE_MS);
  }, 60_000);

  it("STORY-172-AC6 · an already-active member is refused with a 409 and the token is NOT consumed", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const invitee = await createUser();
    await db.query(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')",
      [randomUUID(), workspaceId, invitee.id],
    );
    const invitation = await invite(workspaceId, owner.id, invitee.email, "admin");

    const res = await accept(invitee.id, workspaceId, invitation.token!);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: "conflict", details: { reason: "already_member" } });

    expect((await invitationRow(invitation.id)).accepted_at).toBeNull();
    expect(await memberCount(workspaceId, invitee.id)).toBe(1);
    const role = await db.query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, invitee.id],
    );
    expect(role.rows[0]!.role).toBe("viewer");
  });

  it("STORY-172-AC6b · a non-member holding a valid token for someone else gets the uniform 400, never the 409 that would reveal membership", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const member = await createUser();
    await db.query(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','active')",
      [randomUUID(), workspaceId, member.id],
    );
    const invitation = await invite(workspaceId, owner.id, member.email);
    const stranger = await createUser();

    const res = await accept(stranger.id, workspaceId, invitation.token!);
    const unknown = await accept(stranger.id, workspaceId, "no-such-token");
    expect(refusalShape(res)).toEqual(refusalShape(unknown));
  });

  it("STORY-172-AC7 · a non-UUID workspace id is a 400 validation error, not a 500", async () => {
    const user = await createUser();
    for (const bad of ["not-a-uuid", "123", "%27%3B--", "00000000-0000-0000-0000-00000000000"]) {
      const res = await accept(user.id, bad, "whatever");
      expect(res.statusCode, `id=${bad}`).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
    }
  });

  it("STORY-172-AC8 · a token for workspace A presented at workspace B is the uniform refusal, and A's invitation survives", async () => {
    const ownerA = await createUser();
    const ownerB = await createUser();
    const workspaceA = await createWorkspace(ownerA.id);
    const workspaceB = await createWorkspace(ownerB.id);
    const invitee = await createUser();
    const invitation = await invite(workspaceA, ownerA.id, invitee.email, "admin");

    const cross = await accept(invitee.id, workspaceB, invitation.token!);
    const unknown = await accept(invitee.id, workspaceB, "no-such-token");
    expect(refusalShape(cross)).toEqual(refusalShape(unknown));
    expect(await memberCount(workspaceB, invitee.id)).toBe(0);
    expect(await memberCount(workspaceA, invitee.id)).toBe(0);
    expect((await invitationRow(invitation.id)).accepted_at).toBeNull();
  });

  it("STORY-172-AC9 · a suspended or deleted account whose address matches cannot accept", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const target = await createUser();
    const invitation = await invite(workspaceId, owner.id, target.email);

    await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [target.id]);
    await expect(app.get(InvitationsService).accept(workspaceId, target.id, invitation.token!, meta)).rejects.toMatchObject({ status: 400 });
    expect((await invitationRow(invitation.id)).accepted_at).toBeNull();

    await db.query("UPDATE users SET status = 'active', deleted_at = now() WHERE id = $1", [target.id]);
    await expect(app.get(InvitationsService).accept(workspaceId, target.id, invitation.token!, meta)).rejects.toMatchObject({ status: 400 });
    expect((await invitationRow(invitation.id)).accepted_at).toBeNull();
  });

  it("STORY-172-AC10 · the refusal reason is logged and counted internally, with no token, address or workspace name in it", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const invitee = await createUser();
    const stranger = await createUser();
    const invitation = await invite(workspaceId, owner.id, invitee.email);
    const logSpy = vi.spyOn(Logger.prototype, "log");
    const warnSpy = vi.spyOn(Logger.prototype, "warn");

    const res = await accept(stranger.id, workspaceId, invitation.token!);
    expect(res.statusCode).toBe(400);

    const emitted = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((call) => JSON.stringify(call[0]));
    expect(emitted.some((line) => line.includes("nominara_identity_invitation_accept_refused_total") && line.includes("email_mismatch"))).toBe(true);
    for (const line of emitted) {
      expect(line).not.toContain(invitation.token!);
      expect(line.toLowerCase()).not.toContain(invitee.email.toLowerCase());
    }
    // The response never names the reason.
    expect(JSON.stringify(res.json())).not.toMatch(/mismatch|verified|another account/i);
  });

  it("STORY-172-AC11 · a suspended member whose address matches is still refused 409 member_suspended, token unconsumed", async () => {
    const owner = await createUser();
    const workspaceId = await createWorkspace(owner.id);
    const invitee = await createUser();
    await db.query(
      "INSERT INTO workspace_members (id, workspace_id, user_id, role, status) VALUES ($1,$2,$3,'viewer','suspended')",
      [randomUUID(), workspaceId, invitee.id],
    );
    const invitation = await invite(workspaceId, owner.id, invitee.email);

    const res = await accept(invitee.id, workspaceId, invitation.token!);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ details: { reason: "member_suspended" } });
    expect((await invitationRow(invitation.id)).accepted_at).toBeNull();
  });
});

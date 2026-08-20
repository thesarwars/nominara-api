import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Reflector } from "@nestjs/core";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { WorkspaceGuard, type WorkspaceScopedRequest } from "../../src/api/guards/workspace.guard.js";
import { AuthGuard, type AuthenticatedRequest } from "../../src/api/guards/auth.guard.js";
import { RbacGuard, type RbacScopedRequest } from "../../src/api/guards/rbac.guard.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { StepUpRequiredException, ProjectOutOfScopeException, PermissionDeniedException } from "../../src/tenancy/errors.js";
import { RequirePermission } from "../../src/api/decorators/require-permission.decorator.js";
import { ProjectParam } from "../../src/api/decorators/project-param.decorator.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { ACCESS_COOKIE_NAME } from "../../src/lib/auth/cookies.js";
import { WORKSPACE_HEADER_NAME } from "../../src/tenancy/constants.js";

// STORY-019 — security-and-tenancy.md §5 (step-up)/§7 (revocation and
// freshness). Real Postgres (testcontainers, testing-strategy.md §1):
// proves decision 1's plumbing end-to-end — AuthGuard's existing per-request
// session SELECT now also carries last_strong_auth_at/method, and
// RbacGuard's step-up check reads it off req.session without any lookup of
// its own — and proves the project_scope=[] vs. null distinction against a
// REAL workspace_members row, not a hand-built fixture. Dangerous area
// (tenant-authorization path) — a reviewer other than the author must read
// this guard (DoD).

class WorkspaceDeleteController {
  @RequirePermission("workspace:delete")
  handler(): void {}
}

class ProjectReadController {
  @RequirePermission("project:read")
  @ProjectParam("projectId")
  handler(): void {}
}

class MemberInviteController {
  @RequirePermission("member:invite")
  handler(): void {}
}

class CreditsSpendController {
  @RequirePermission("credits:spend")
  handler(): void {}
}

function makeContext(req: WorkspaceScopedRequest | RbacScopedRequest, ctor: new () => object = class {}) {
  const proto = ctor.prototype as { handler?: () => void };
  return {
    getHandler: () => proto.handler ?? (() => undefined),
    getClass: () => ctor,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
  } as unknown as Parameters<WorkspaceGuard["canActivate"]>[0];
}

describe("STORY-019 · RbacGuard + step-up, against real Postgres", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let workspaceGuard: WorkspaceGuard;
  let authGuard: AuthGuard;
  let rbacGuard: RbacGuard;
  let sessions: SessionService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 120_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    process.env.WEBAUTHN_RP_ID = "localhost";
    process.env.WEBAUTHN_RP_NAME = "Nominara";
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.AUTH_TOKEN_ED25519_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1";
    process.env.AUTH_TOKEN_ED25519_PUBLIC_KEY = "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=";
    process.env.AUTH_TOKEN_ED25519_KID = "test-kid-1";
    process.env.CSRF_SECRET = "test-csrf-secret";
    // STORY-021 — WORKSPACE_DEK_WRAPPING_KEY became required by the global
    // env schema this story extended; SessionService.createSession's
    // loadEnv() call now needs it even though this file provisions no DEK.
    process.env.WORKSPACE_DEK_WRAPPING_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.DATABASE_URL_POOLED = container.getConnectionUri();

    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db.query("DROP SCHEMA IF EXISTS app CASCADE");
    await db.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await migrateUp(db);

    pool = new Pool({ connectionString: container.getConnectionUri() });
    const cache = new MembershipCacheService();
    const membership = new MembershipService(cache);
    workspaceGuard = new WorkspaceGuard(pool, membership, new Reflector());
    authGuard = new AuthGuard(new Reflector(), pool);
    rbacGuard = new RbacGuard(new Reflector());
    sessions = new SessionService(pool);
  });

  afterEach(async () => {
    await pool.end();
    await db.end();
  });

  // ---- fixtures ---------------------------------------------------------

  let seq = 0;
  async function createUser(): Promise<string> {
    seq += 1;
    const result = await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `user-${seq}@example.com`,
    ]);
    return result.rows[0]!.id;
  }

  async function createWorkspace(): Promise<string> {
    seq += 1;
    const result = await db.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}`],
    );
    return result.rows[0]!.id;
  }

  async function addMember(
    workspaceId: string,
    userId: string,
    role: string,
    projectScope: string[] | null = null,
  ): Promise<void> {
    await db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, status, project_scope) VALUES ($1, $2, $3, 'active', $4)",
      [workspaceId, userId, role, projectScope],
    );
  }

  /** Runs the real AuthGuard -> WorkspaceGuard -> RbacGuard chain over one cookie-carrying request. */
  async function runChain(
    req: AuthenticatedRequest & WorkspaceScopedRequest & RbacScopedRequest,
    ctor: new () => object,
  ): Promise<boolean> {
    await authGuard.canActivate(makeContext(req, ctor));
    await workspaceGuard.canActivate(makeContext(req, ctor));
    return rbacGuard.canActivate(makeContext(req, ctor));
  }

  // ---- decision 1 — AuthGuard exposes strong-auth freshness --------------

  it("AuthGuard's existing session SELECT now also carries last_strong_auth_at/method onto req.session", async () => {
    const userId = await createUser();
    const tokens = await sessions.createSession(userId);
    const req: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: tokens.accessToken }, method: "GET" };

    await authGuard.canActivate(makeContext(req));
    expect(req.session).toEqual({ lastStrongAuthAt: null, lastStrongAuthMethod: null });

    const strongAuthAt = new Date();
    await sessions.recordStrongAuth(tokens.sid, "webauthn", strongAuthAt);

    const secondReq: AuthenticatedRequest = { cookies: { [ACCESS_COOKIE_NAME]: tokens.accessToken }, method: "GET" };
    await authGuard.canActivate(makeContext(secondReq));
    expect(secondReq.session?.lastStrongAuthMethod).toBe("webauthn");
    expect(secondReq.session?.lastStrongAuthAt?.getTime()).toBe(strongAuthAt.getTime());
  });

  // ---- EC-17/AC 2 — live role, never the token's role claim ---------------

  it("EC-17/AC 2 · RbacGuard enforces the LIVE workspace_members role, never the JWT's role claim, when they diverge", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    // Live row: viewer (member:invite denied).
    await addMember(workspaceId, userId, "viewer");

    const tokens = await sessions.createSession(userId);
    // Test seam (switchWorkspace mints the role claim directly, see the
    // comment above its definition) — deliberately mints a token whose
    // `role` claim says "owner" (member:invite allowed) while the live
    // workspace_members row says "viewer", to prove RbacGuard evaluates
    // req.membership.role (re-verified by WorkspaceGuard this request), not
    // req.auth.role. A guard mutated to prefer the JWT claim would permit
    // this request; the correct guard refuses it.
    const { accessToken } = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 1);

    const req: AuthenticatedRequest & WorkspaceScopedRequest & RbacScopedRequest = {
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
      method: "GET",
    };

    await expect(runChain(req, MemberInviteController)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(req.membership?.role).toBe("viewer");
  });

  // ---- end-to-end step-up ---------------------------------------------------

  it("REQ-019-5/6 · a privileged route is refused for step-up until a real recordStrongAuth call, then permitted through the whole chain", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "owner");

    const tokens = await sessions.createSession(userId);
    const { accessToken } = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 1);

    const req: AuthenticatedRequest & WorkspaceScopedRequest = {
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
      method: "GET",
    };
    await expect(runChain(req, WorkspaceDeleteController)).rejects.toBeInstanceOf(StepUpRequiredException);

    await sessions.recordStrongAuth(tokens.sid, "webauthn");

    const secondReq: AuthenticatedRequest & WorkspaceScopedRequest = {
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
      method: "GET",
    };
    await expect(runChain(secondReq, WorkspaceDeleteController)).resolves.toBe(true);
  });

  // ---- project_scope = [] vs null, off a REAL membership row --------------

  it("a real workspace_members row with project_scope = [] flows through WorkspaceGuard to RbacGuard as a distinct empty scope, refusing every project", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addMember(workspaceId, userId, "manager", []);

    const tokens = await sessions.createSession(userId);
    const { accessToken } = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "manager", null, 1);

    const req: AuthenticatedRequest & WorkspaceScopedRequest & RbacScopedRequest = {
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
      method: "GET",
      params: { projectId: uuidV7() },
    };

    await authGuard.canActivate(makeContext(req));
    await workspaceGuard.canActivate(makeContext(req));
    // req.tenant collapses [] and null to the same "undefined" shape
    // (workspace.guard.ts) — this is exactly why RbacGuard must read
    // req.membership.projectScope, asserted here against the real row.
    expect(req.tenant?.scopeProjectIds).toBeUndefined();
    expect(req.membership?.projectScope).toEqual([]);

    expect(() => rbacGuard.canActivate(makeContext(req, ProjectReadController))).toThrow(ProjectOutOfScopeException);
  });

  it("a real workspace_members row with a matching project in scope is permitted through the whole chain", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    const projectId = uuidV7();
    await addMember(workspaceId, userId, "manager", [projectId]);

    const tokens = await sessions.createSession(userId);
    const { accessToken } = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "manager", null, 1);

    const req: AuthenticatedRequest & WorkspaceScopedRequest & RbacScopedRequest = {
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
      method: "GET",
      params: { projectId },
    };

    await expect(runChain(req, ProjectReadController)).resolves.toBe(true);
  });

  // ---- STORY-019-E-2 — API-key requests never get req.membership ----------

  it("STORY-019-E-2 · an apiKey request on a @RequirePermission route is refused, since it never gets req.membership", async () => {
    const workspaceId = await createWorkspace();

    const req: WorkspaceScopedRequest & RbacScopedRequest = {
      authMethod: "apiKey",
      apiKey: { id: uuidV7(), workspaceId },
      headers: { [WORKSPACE_HEADER_NAME]: workspaceId },
    };

    // No AuthGuard step — an API key never carries a session cookie
    // (matches STORY-018's own apiKey test pattern, which calls
    // WorkspaceGuard directly rather than through AuthGuard).
    await expect(workspaceGuard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(req.membership).toBeUndefined();

    expect(() => rbacGuard.canActivate(makeContext(req, MemberInviteController))).toThrow(
      /missing required permission/,
    );
  });

  // ---- STORY-019-E-6 — scoped permission with no @ProjectParam ------------

  it("STORY-019-E-6 · a scoped permission on a route with no @ProjectParam refuses, even for an in-scope member, since there is no project id to check against", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    const projectId = uuidV7();
    // manager's credits:spend cell is "scoped" (permission-matrix.ts) — this
    // member IS in scope for projectId, but CreditsSpendController below
    // declares no @ProjectParam, so RbacGuard has no route param to read a
    // project id from.
    await addMember(workspaceId, userId, "manager", [projectId]);

    const tokens = await sessions.createSession(userId);
    const { accessToken } = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "manager", null, 1);

    const req: AuthenticatedRequest & WorkspaceScopedRequest & RbacScopedRequest = {
      cookies: { [ACCESS_COOKIE_NAME]: accessToken },
      method: "GET",
    };

    await expect(runChain(req, CreditsSpendController)).rejects.toBeInstanceOf(ProjectOutOfScopeException);
  });
});

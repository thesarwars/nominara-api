import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-019 review (MAJOR) - routes whose permission a role holds as "scoped"
// but that named no project made RbacGuard refuse EVERY restricted scope with
// project_out_of_scope, locking a member out of a project they are assigned to.
// Driven over HTTP through the real guard chain. For each representative
// route: an in-scope scoped member is allowed; an out-of-scope one is refused
// with project_out_of_scope; an unrestricted member is allowed; a member of
// another workspace gets nothing. The entity-id routes (a run, a result) name
// no project in the URL, so the scope is checked against the row's own
// project: the out-of-scope case there must ALSO leave the row untouched.

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;

interface Actor {
  readonly cookie: string;
  readonly csrf: string;
}

describe("STORY-019 · a scoped permission on a project route (REQ-019-scope-declared)", () => {
  let cacheValkey: StartedValkey;
  let queueValkey: ValkeyFixture;
  const harness = useApiHarness({
    runAsAppRole: true,
    env: () => ({ VALKEY_CACHE_URL: cacheValkey.url, QUEUE_REDIS_URL: queueValkey.connectionString }),
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

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await harness.db().query(
      `INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`,
      [userId, `${userId}@example.test`],
    );
    return userId;
  }

  async function ownerOfNewWorkspace(): Promise<{ workspaceId: string; actor: Actor }> {
    const userId = await newUser();
    const tokens = await sessions.createSession(userId);
    const created = await harness.app().inject({
      method: "POST",
      url: apiUrl("/workspaces"),
      headers: { cookie: cookieOf(tokens), [CSRF_HEADER_NAME]: tokens.csrfToken, "content-type": "application/json" },
      payload: { name: "Acme", org_type: "in_house", region: "us-east-1", timezone: "UTC" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const workspaceId = (created.json() as { data: { id: string } }).data.id;
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly("growth"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, 2);
    return { workspaceId, actor: { cookie: cookieOf(entered), csrf: entered.csrfToken } };
  }

  async function manager(workspaceId: string, projectScope: readonly string[] | null): Promise<Actor> {
    const userId = await newUser();
    await harness.db().query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, project_scope, status) VALUES ($1,$2,$3,'manager',$4,'active')`,
      [uuidV7(), workspaceId, userId, projectScope],
    );
    const tokens = await sessions.createSession(userId);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "manager", null, 2);
    return { cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function project(workspaceId: string, name: string): Promise<string> {
    const slug = `${name}-${uuidV7().slice(-8)}`;
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status) VALUES ($1,$2,$3,$4,$5,$6,'active')`,
      [id, workspaceId, name, slug, `https://${slug}.example`, `${slug}.example`],
    );
    return id;
  }

  async function run(workspaceId: string, projectId: string): Promise<string> {
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO capture_runs (id, workspace_id, project_id, trigger, engine_keys, planned_cells) VALUES ($1,$2,$3,'manual',ARRAY['gemini'],4)`,
      [id, workspaceId, projectId],
    );
    return id;
  }

  async function result(workspaceId: string, projectId: string): Promise<{ resultId: string; promptId: string }> {
    const promptId = uuidV7();
    const resultId = uuidV7();
    await harness.db().query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'best crm',sha256($4::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId, Buffer.from(promptId)],
    );
    await harness.db().query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,
          normalizer_version,scoring_version,content_hash,payload,flags,cache_layer,status,
          brand_present,sov,sentiment_label,sentiment_score,citation_count,owned_citation_count,truncated)
       VALUES ($1,$2,$3,$4,$5,'chatgpt', now(),'api','1.0.0','n1','v1',$6,$7::jsonb,'{}','live','parsed',true,0.62,'positive',0.5,1,1,false)`,
      [
        resultId,
        workspaceId,
        projectId,
        uuidV7(),
        promptId,
        createHash("sha256").update(resultId).digest(),
        JSON.stringify({ format: "markdown", text: "HubSpot is a CRM." }),
      ],
    );
    return { resultId, promptId };
  }

  interface Routed {
    readonly name: string;
    readonly allowed: number;
    /** Builds the request for an actor against a target the fixture seeded for ONE project. */
    readonly request: (target: Target, actor: Actor) => { method: "GET" | "POST" | "PATCH"; url: string; headers: Record<string, string>; payload?: object };
  }
  interface Target {
    readonly projectId: string;
    readonly runId: string;
    readonly resultId: string;
    readonly promptId: string;
  }

  const read = (path: string) => (_t: Target, a: Actor) => ({ method: "GET" as const, url: apiUrl(path), headers: { cookie: a.cookie } });
  const routes: readonly Routed[] = [
    { name: "GET /projects/{id}/prompts", allowed: 200, request: (t, a) => read(`/projects/${t.projectId}/prompts`)(t, a) },
    {
      name: "POST /projects/{id}/prompts",
      allowed: 201,
      request: (t, a) => ({
        method: "POST",
        url: apiUrl(`/projects/${t.projectId}/prompts`),
        headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json", "idempotency-key": uuidV7() },
        payload: { text: `what is the best crm ${uuidV7()}` },
      }),
    },
    { name: "GET /projects/{id}/matrix", allowed: 200, request: (t, a) => read(`/projects/${t.projectId}/matrix`)(t, a) },
    { name: "GET /projects/{id}/growth-map", allowed: 200, request: (t, a) => read(`/projects/${t.projectId}/growth-map`)(t, a) },
    { name: "GET /runs/{id}", allowed: 200, request: (t, a) => read(`/runs/${t.runId}`)(t, a) },
    {
      name: "POST /runs/{id}/cancel",
      allowed: 200,
      request: (t, a) => ({
        method: "POST",
        url: apiUrl(`/runs/${t.runId}/cancel`),
        headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
        payload: {},
      }),
    },
    {
      name: "POST /runs/{id}/undo",
      allowed: 200,
      request: (t, a) => ({
        method: "POST",
        url: apiUrl(`/runs/${t.runId}/undo`),
        headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
        payload: {},
      }),
    },
    {
      name: "PATCH /prompts/{id}",
      allowed: 200,
      request: (t, a) => ({
        method: "PATCH",
        url: apiUrl(`/prompts/${t.promptId}`),
        headers: { cookie: a.cookie, [CSRF_HEADER_NAME]: a.csrf, "content-type": "application/json" },
        payload: { status: "paused" },
      }),
    },
    { name: "GET /results/{id}", allowed: 200, request: (t, a) => read(`/results/${t.resultId}`)(t, a) },
  ];

  async function seedTarget(workspaceId: string, projectId: string): Promise<Target> {
    return { projectId, runId: await run(workspaceId, projectId), ...(await result(workspaceId, projectId)) };
  }

  for (const route of routes) {
    describe(route.name, () => {
      it("REQ-019-scope-in: a manager scoped to THIS project is allowed", async () => {
        const { workspaceId } = await ownerOfNewWorkspace();
        const mine = await project(workspaceId, "mine");
        const other = await project(workspaceId, "other");
        const actor = await manager(workspaceId, [mine]);
        const target = await seedTarget(workspaceId, mine);
        void other;
        const res = await harness.app().inject(route.request(target, actor));
        expect(res.statusCode, res.body).toBe(route.allowed);
      });

      it("REQ-019-scope-out: a manager scoped to ANOTHER project is refused 403 project_out_of_scope", async () => {
        const { workspaceId } = await ownerOfNewWorkspace();
        const mine = await project(workspaceId, "mine");
        const other = await project(workspaceId, "other");
        const actor = await manager(workspaceId, [other]);
        const target = await seedTarget(workspaceId, mine);
        const res = await harness.app().inject(route.request(target, actor));
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: "project_out_of_scope" } });
      });

      it("REQ-019-scope-unrestricted: a manager with no project scope is allowed", async () => {
        const { workspaceId } = await ownerOfNewWorkspace();
        const mine = await project(workspaceId, "mine");
        const actor = await manager(workspaceId, null);
        const target = await seedTarget(workspaceId, mine);
        const res = await harness.app().inject(route.request(target, actor));
        expect(res.statusCode, res.body).toBe(route.allowed);
      });

      it("REQ-019-scope-tenant: a member of ANOTHER workspace is refused, even one scoped to that project's id", async () => {
        const a = await ownerOfNewWorkspace();
        const b = await ownerOfNewWorkspace();
        const mine = await project(a.workspaceId, "mine");
        const target = await seedTarget(a.workspaceId, mine);
        const outsiderUnrestricted = await manager(b.workspaceId, null);
        const outsiderNamingIt = await manager(b.workspaceId, [mine]);
        for (const outsider of [outsiderUnrestricted, outsiderNamingIt]) {
          const res = await harness.app().inject(route.request(target, outsider));
          expect(res.statusCode, res.body).toBe(404);
        }
      });
    });
  }

  it("REQ-019-scope-out: an out-of-scope cancel leaves the run untouched (the check precedes the write)", async () => {
    const { workspaceId } = await ownerOfNewWorkspace();
    const mine = await project(workspaceId, "mine");
    const other = await project(workspaceId, "other");
    const actor = await manager(workspaceId, [other]);
    const runId = await run(workspaceId, mine);
    const res = await harness.app().inject({
      method: "POST",
      url: apiUrl(`/runs/${runId}/cancel`),
      headers: { cookie: actor.cookie, [CSRF_HEADER_NAME]: actor.csrf, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(403);
    const row = await harness.db().query<{ status: string }>("SELECT status FROM capture_runs WHERE id = $1", [runId]);
    expect(row.rows[0]!.status).not.toBe("canceled");
  });
});

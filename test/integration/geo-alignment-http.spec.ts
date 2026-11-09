import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alignmentSessionPayloadSchema, ALIGNMENT_DRAFT_MAX_CHARS, ALIGNMENT_DRAFT_P95_OBJECTIVE_MS } from "../../contracts/analytics/index.js";
import { auxPatchSchema } from "../../contracts/aux/index.js";
import { ACCESS_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../src/lib/auth/cookies.js";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { SessionService, type SessionTokens } from "../../src/modules/identity/session.service.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";
import { startValkey, startValkeyFixture, type StartedValkey, type ValkeyFixture } from "../support/valkey-fixture.js";

// STORY-192 - the four /geo/alignment routes through the REAL HTTP pipeline: the permission guard, the feature flag, the idempotency interceptor, the
// rate-limit class, the audit interceptor and the contract validation are all in the composition root, so a service-level test cannot see them. The queue
// and the cache are the spec's own containers (never the developer's Valkey); the worker is not run (its half is test/integration/geo-alignment-job.spec.ts).

type Cookie = Pick<SessionTokens, "accessToken" | "csrfToken">;
const cookieOf = (t: Cookie): string => `${ACCESS_COOKIE_NAME}=${t.accessToken}; ${CSRF_COOKIE_NAME}=${t.csrfToken}`;
const PAGE = "https://brand.test/products/crm";

describe("STORY-192 · /geo/alignment over HTTP", () => {
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
    vi.restoreAllMocks();
    await pool.end();
  });

  interface Actor {
    readonly workspaceId: string;
    readonly userId: string;
    readonly cookie: string;
    readonly csrf: string;
  }

  async function newUser(): Promise<string> {
    const userId = uuidV7();
    await harness.db().query(`INSERT INTO users (id, email, email_verified_at, status, created_at, updated_at) VALUES ($1,$2,now(),'active',now(),now())`, [userId, `${userId}@example.test`]);
    return userId;
  }

  async function owner(plan: "free" | "starter" | "growth" | "business" = "growth"): Promise<Actor> {
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
        applyPlanChange(tx, workspaceId, planKeyOnly(plan as "starter"), { requestId: "R", operator: "test", reason: "test" }),
      );
    } finally {
      client.release();
    }
    const version = Number((await harness.db().query("SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId])).rows[0].entitlement_version);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, workspaceId, "owner", null, version);
    return { userId, workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  async function member(a: Actor, role: "manager" | "analyst" | "viewer", scope: readonly string[] | null = null): Promise<Actor> {
    const userId = await newUser();
    await harness.db().query(`INSERT INTO workspace_members (id, workspace_id, user_id, role, status, project_scope) VALUES ($1,$2,$3,$4,'active',$5::uuid[])`, [uuidV7(), a.workspaceId, userId, role, scope === null ? null : [...scope]]);
    const tokens = await sessions.createSession(userId);
    const version = Number((await harness.db().query("SELECT entitlement_version FROM workspaces WHERE id = $1", [a.workspaceId])).rows[0].entitlement_version);
    const entered = await sessions.switchWorkspace(tokens.sid, userId, a.workspaceId, role, scope, version);
    return { userId, workspaceId: a.workspaceId, cookie: cookieOf(entered), csrf: entered.csrfToken };
  }

  const headers = (a: Actor, key: string | null = randomUUID()): Record<string, string> => ({
    cookie: a.cookie,
    [CSRF_HEADER_NAME]: a.csrf,
    "content-type": "application/json",
    ...(key === null ? {} : { "idempotency-key": key }),
  });
  /** The error code, or the whole response when there is none (a missing code names the actual status and body). */
  const codeOf = (res: { json(): unknown; statusCode: number; body: string }): string => (res.json() as { error?: { code?: string } }).error?.code ?? `HTTP ${String(res.statusCode)} ${res.body}`;
  const errorOf = (res: { json(): unknown }) => (res.json() as { error: { code: string; details?: Record<string, unknown> } }).error;
  const dataOf = <T,>(res: { json(): unknown }): T => (res.json() as { data: T }).data;

  async function project(a: Actor): Promise<string> {
    const id = uuidV7();
    await harness.db().query(`INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence) VALUES ($1,$2,'P',$3,'https://brand.test','brand.test','active','weekly')`, [id, a.workspaceId, `p-${randomUUID().slice(0, 8)}`]);
    await harness.db().query(`INSERT INTO project_engines (workspace_id, project_id, engine_key) VALUES ($1,$2,'chatgpt'), ($1,$2,'gemini')`, [a.workspaceId, id]);
    return id;
  }
  async function cluster(a: Actor, projectId: string): Promise<string> {
    const id = uuidV7();
    await harness.db().query(`INSERT INTO topic_clusters (id, workspace_id, project_id, label) VALUES ($1,$2,$3,'Enterprise CRM')`, [id, a.workspaceId, projectId]);
    return id;
  }
  /** A session the worker has finished: ready, with live content. */
  async function readySession(a: Actor, projectId: string, clusterId: string | null, state: "ready" | "pending" = "ready"): Promise<string> {
    const id = uuidV7();
    await harness.db().query(
      `INSERT INTO geo_alignments (id, workspace_id, project_id, target_url, prompt_cluster_id, engine_keys, embedding_model, live_content_md, analysis_state)
       VALUES ($1,$2,$3,$4,$5,'{chatgpt}','stand-in-bow-1536','# CRM\n\nReporting for teams.',$6)`,
      [id, a.workspaceId, projectId, PAGE, clusterId, state],
    );
    return id;
  }

  const open = (a: Actor, body: unknown, key: string | null = randomUUID()) =>
    harness.app().inject({ method: "POST", url: apiUrl("/geo/alignment"), headers: headers(a, key), payload: body as object });
  const get = (a: Actor, id: string) => harness.app().inject({ method: "GET", url: apiUrl(`/geo/alignment/${id}`), headers: { cookie: a.cookie } });
  const patch = (a: Actor, id: string, body: unknown) =>
    harness.app().inject({ method: "PATCH", url: apiUrl(`/geo/alignment/${id}`), headers: headers(a, null), payload: body as object });
  const cutPatch = (a: Actor, id: string, key: string | null = randomUUID(), body: unknown = {}) =>
    harness.app().inject({ method: "POST", url: apiUrl(`/geo/alignment/${id}/patch`), headers: headers(a, key), payload: body as object });
  const noCharge = async (a: Actor): Promise<void> => {
    expect((await harness.db().query("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1", [a.workspaceId])).rows[0].n).toBe(0);
  };

  // ---- open -----------------------------------------------------------------------------------------------------------------

  it("AC open H1 · 202 with a pending session and a poll pointer; the row, the signed job and the audit row agree; nothing is charged", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const enqueue = vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob");

    const res = await open(a, { project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId });
    expect(res.statusCode, res.body).toBe(202);
    const body = dataOf<{ session_id: string; status: string; poll_url: string; credits_charged: number }>(res);
    expect(body).toMatchObject({ status: "pending", credits_charged: 0, poll_url: `/v1/geo/alignment/${body.session_id}` });

    const row = (await harness.db().query("SELECT * FROM geo_alignments WHERE id = $1", [body.session_id])).rows[0];
    expect(row).toMatchObject({ project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId, analysis_state: "pending", status: "open", created_by: a.userId, live_content_md: null });
    expect(row.engine_keys).toEqual(["chatgpt", "gemini"]);
    expect(row.embedding_model).toBe("stand-in-bow-1536");

    const jobs = enqueue.mock.calls.filter((c) => c[0] === "geo.analyze");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]![1]).toBe(a.workspaceId);
    expect(jobs[0]![2]).toEqual({ kind: "alignment_session", projectId, sessionId: body.session_id, attempt: 0 });
    expect(jobs[0]![3]).toEqual({ idempotencyKey: `geo:${projectId}:alignment:${body.session_id}.alignment_session.0` });

    const audit = (await harness.db().query("SELECT action, resource_type, resource_id FROM audit_log WHERE workspace_id = $1 AND action = 'geo_alignment.opened'", [a.workspaceId])).rows;
    expect(audit).toEqual([{ action: "geo_alignment.opened", resource_type: "geo_alignment", resource_id: body.session_id }]);
    await noCharge(a);
  }, 120_000);

  it("AC open H2 · an Idempotency-Key is required (400), and the same key replays the first session instead of opening another", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const payload = { project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId };
    const missing = await open(a, payload, null);
    expect(missing.statusCode, missing.body).toBe(400);
    const key = randomUUID();
    const first = await open(a, payload, key);
    const second = await open(a, payload, key);
    expect([first.statusCode, second.statusCode]).toEqual([202, 202]);
    expect(dataOf<{ session_id: string }>(second).session_id).toBe(dataOf<{ session_id: string }>(first).session_id);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM geo_alignments WHERE workspace_id = $1", [a.workspaceId])).rows[0].n).toBe(1);
  }, 120_000);

  it("AC open H3 · the request is strict: an unknown key, a non-http(s) URL, a missing cluster or a malformed id is 400 and writes nothing", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const ok = { project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId };
    for (const bad of [{ ...ok, engine_keys: ["gemini"] }, { ...ok, target_url: "file:///etc/passwd" }, { project_id: projectId, target_url: PAGE }, { ...ok, project_id: "nope" }]) {
      const res = await open(a, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(errorOf(res).code).toBe("validation_failed");
    }
    expect((await harness.db().query("SELECT count(*)::int AS n FROM geo_alignments")).rows[0].n).toBe(0);
  }, 120_000);

  it("AC open H4 · a cluster of another project, an unknown project and a foreign workspace's project are refused with nothing written", async () => {
    const a = await owner();
    const other = await owner();
    const projectId = await project(a);
    const otherProject = await project(a);
    const foreignProject = await project(other);
    const foreignCluster = await cluster(a, otherProject);
    expect((await open(a, { project_id: projectId, target_url: PAGE, prompt_cluster_id: foreignCluster })).statusCode).toBe(400);
    expect((await open(a, { project_id: randomUUID(), target_url: PAGE, prompt_cluster_id: foreignCluster })).statusCode).toBe(404);
    expect((await open(a, { project_id: foreignProject, target_url: PAGE, prompt_cluster_id: foreignCluster })).statusCode).toBe(404);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM geo_alignments")).rows[0].n).toBe(0);
  }, 120_000);

  it("AC open H5 · optimizer:use - an analyst and a viewer are 403 naming the permission on every route; a manager scoped to ANOTHER project is 403 project_out_of_scope", async () => {
    const a = await owner();
    const projectId = await project(a);
    const otherProject = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId);
    for (const role of ["analyst", "viewer"] as const) {
      const m = await member(a, role);
      const results = [
        await open(m, { project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId }),
        await get(m, sessionId),
        await patch(m, sessionId, { draft_content_md: "x" }),
        await cutPatch(m, sessionId),
      ];
      for (const res of results) {
        expect(res.statusCode, `${role} ${res.body}`).toBe(403);
        expect(JSON.stringify(errorOf(res))).toContain("optimizer:use");
      }
    }
    const scoped = await member(a, "manager", [otherProject]);
    expect(codeOf(await open(scoped, { project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId }))).toBe("project_out_of_scope");
    expect(codeOf(await get(scoped, sessionId))).toBe("project_out_of_scope");
    expect(codeOf(await patch(scoped, sessionId, { draft_content_md: "x" }))).toBe("project_out_of_scope");
    expect(codeOf(await cutPatch(scoped, sessionId))).toBe("project_out_of_scope");
    const inScope = await member(a, "manager", [projectId]);
    expect((await get(inScope, sessionId)).statusCode).toBe(200);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM geo_alignments WHERE workspace_id = $1", [a.workspaceId])).rows[0].n).toBe(1);
  }, 180_000);

  it("AC open H6 · a plan without the optimizer (Free) is 403 feature_not_in_plan on every route, before anything is written", async () => {
    const a = await owner("free");
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const res = await open(a, { project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId });
    expect(res.statusCode, res.body).toBe(403);
    expect(errorOf(res).code).toBe("feature_not_in_plan");
    expect(errorOf(res).details).toMatchObject({ key: "optimizer.enabled" });
    expect((await get(a, randomUUID())).statusCode).toBe(403);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM geo_alignments")).rows[0].n).toBe(0);
  }, 120_000);

  it("AC open H7 · rate limited as section 12 states: burst 5, the sixth open in a row is 429 rate_limited; nothing is charged", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await open(a, { project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId })).statusCode);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    await noCharge(a);
  }, 120_000);

  it("AC open H8 · a failed enqueue is compensated: the request still answers 202, and the session is marked failed (dispatch_failed), never left pending for ever", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob").mockRejectedValue(new Error("valkey down"));
    const res = await open(a, { project_id: projectId, target_url: PAGE, prompt_cluster_id: clusterId });
    expect(res.statusCode, res.body).toBe(202);
    const id = dataOf<{ session_id: string }>(res).session_id;
    await vi.waitFor(async () => {
      const row = (await harness.db().query("SELECT analysis_state, analysis_reason FROM geo_alignments WHERE id = $1", [id])).rows[0];
      expect(row).toEqual({ analysis_state: "failed", analysis_reason: "dispatch_failed" });
    }, { timeout: 10_000 });
    expect(dataOf<{ status: string; status_reason: string }>(await get(a, id))).toMatchObject({ status: "failed", status_reason: "dispatch_failed" });
  }, 120_000);

  // ---- read -----------------------------------------------------------------------------------------------------------------

  it("AC pending H9 · a pending session reads as pending and shows no partial figure; another workspace's session is 404, not 403", async () => {
    const a = await owner();
    const b = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId, "pending");
    // leave behind what a half-finished analysis would: it must not be shown
    await harness.db().query(`UPDATE geo_alignments SET coverage_ratio = 0.5, baseline_alignment = 0.4, current_alignment = 0.4 WHERE id = $1`, [sessionId]);
    const res = await get(a, sessionId);
    expect(res.statusCode, res.body).toBe(200);
    const body = dataOf<Record<string, unknown>>(res);
    expect(alignmentSessionPayloadSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ status: "pending", coverage_ratio: null, baseline_alignment: null, current_alignment: null, recommendations: [], projection: null, generation: "disabled", draft_status: null });
    expect((await get(b, sessionId)).statusCode).toBe(404);
    expect((await get(a, randomUUID())).statusCode).toBe(404);
    expect((await get(a, "not-a-uuid")).statusCode).toBe(400);
  }, 120_000);

  // ---- draft ----------------------------------------------------------------------------------------------------------------

  it("AC draft H10 · PATCH stores the draft, queues ONE delayed recompute and answers with the payload marked draft pending; the live page is untouched; the audit row holds no draft text", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId);
    const enqueue = vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob");
    const draft = "# CRM\n\nReporting for teams with a SECRETDRAFTMARKER section.";
    const res = await patch(a, sessionId, { draft_content_md: draft });
    expect(res.statusCode, res.body).toBe(200);
    expect(dataOf<Record<string, unknown>>(res)).toMatchObject({ status: "ready", draft_status: "pending", generation: "disabled" });
    const row = (await harness.db().query("SELECT draft_content_md, live_content_md, draft_state, draft_recompute_due_at FROM geo_alignments WHERE id = $1", [sessionId])).rows[0];
    expect(row.draft_content_md).toBe(draft);
    expect(row.live_content_md).toBe("# CRM\n\nReporting for teams.");
    expect(row.draft_state).toBe("pending");
    expect(row.draft_recompute_due_at).not.toBeNull();

    const draftJobs = enqueue.mock.calls.filter((c) => c[0] === "geo.analyze");
    expect(draftJobs).toHaveLength(1);
    const dueAt = (await harness.db().query("SELECT draft_recompute_due_at::text AS due FROM geo_alignments WHERE id = $1", [sessionId])).rows[0].due as string;
    expect(draftJobs[0]![2]).toEqual({ kind: "alignment_draft", projectId, sessionId, attempt: 0, dueAt });
    expect(draftJobs[0]![3]).toMatchObject({ delayMs: 2000 });
    await vi.waitFor(() => expect(enqueue.mock.calls.some((c) => c[0] === "embed.batch")).toBe(true), { timeout: 10_000 });

    const audit = (await harness.db().query("SELECT after_state FROM audit_log WHERE workspace_id = $1 AND action = 'geo_alignment.draft_updated'", [a.workspaceId])).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0])).not.toContain("SECRETDRAFTMARKER");
    await noCharge(a);
  }, 120_000);

  it("AC draft H10b · every save of a draft queues a job with its OWN idempotency key: the queue deduplicates by key for an hour, so a shared key would drop every save after the first", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId);
    const enqueue = vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob");
    for (const text of ["first draft", "second draft", "third draft"]) expect((await patch(a, sessionId, { draft_content_md: text })).statusCode).toBe(200);
    const keys = enqueue.mock.calls.filter((c) => c[0] === "geo.analyze").map((c) => (c[3] as { idempotencyKey: string }).idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  }, 120_000);

  it("AC draft H11 · a session that is not ready (pending) refuses a draft with 409 and stores nothing; the body is strict and bounded", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const pending = await readySession(a, projectId, clusterId, "pending");
    const res = await patch(a, pending, { draft_content_md: "x" });
    expect(res.statusCode, res.body).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "conflict", details: { current_state: "pending" } });
    expect((await harness.db().query("SELECT draft_content_md FROM geo_alignments WHERE id = $1", [pending])).rows[0].draft_content_md).toBeNull();

    const ready = await readySession(a, projectId, clusterId);
    for (const bad of [{}, { draft_content_md: "" }, { draft_content_md: "x", live_content_md: "y" }, { draft_content_md: "a".repeat(ALIGNMENT_DRAFT_MAX_CHARS + 1) }]) {
      expect((await patch(a, ready, bad)).statusCode).toBe(400);
    }
    expect((await patch(a, ready, { draft_content_md: "a".repeat(ALIGNMENT_DRAFT_MAX_CHARS) })).statusCode).toBe(200);
    expect((await patch(a, randomUUID(), { draft_content_md: "x" })).statusCode).toBe(404);
  }, 120_000);

  it("AC draft H12 · a failed enqueue marks THIS draft failed (dispatch_failed compensation) and leaves a later edit alone", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId);
    vi.spyOn(harness.app().get(QueueProducer), "enqueueTenantJob").mockRejectedValue(new Error("valkey down"));
    expect((await patch(a, sessionId, { draft_content_md: "a draft" })).statusCode).toBe(200);
    await vi.waitFor(async () => expect((await harness.db().query("SELECT draft_state FROM geo_alignments WHERE id = $1", [sessionId])).rows[0].draft_state).toBe("failed"), { timeout: 10_000 });
    expect(dataOf<{ draft_status: string }>(await get(a, sessionId)).draft_status).toBe("failed");
  }, 120_000);

  it("AC latency H13 · the draft request answers within the 200 ms p95 objective (15 requests: the per-user write burst is 20) for a realistic page, and observes its latency on a metric", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId);
    const log = vi.spyOn(Logger.prototype, "log");
    const sentence = "Teams compare reporting tools by export formats, audit logging, role based access and webhook delivery. ";
    const timings: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const started = performance.now();
      const res = await patch(a, sessionId, { draft_content_md: `# Page ${String(i)}\n\n${sentence.repeat(60)}` });
      timings.push(performance.now() - started);
      expect(res.statusCode, res.body).toBe(200);
    }
    timings.sort((x, y) => x - y);
    const p95 = timings[Math.ceil(0.95 * timings.length) - 1]!;
    expect(p95, `p95 ${p95.toFixed(1)} ms`).toBeLessThan(ALIGNMENT_DRAFT_P95_OBJECTIVE_MS);
    const observed = log.mock.calls.map((c) => c[0]).filter((l) => typeof l === "object" && l !== null && (l as { metric?: string }).metric === "nominara_geo_alignment_draft_request_seconds");
    expect(observed).toHaveLength(15);
    expect(observed.every((o) => Number.isFinite((o as { value: number }).value) && (o as { value: number }).value >= 0)).toBe(true);
  }, 180_000);

  // ---- patch ----------------------------------------------------------------------------------------------------------------

  it("AC patch H14 · without a measured draft the patch is 422 precondition_unmet naming why, and writes nothing", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId);
    const none = await cutPatch(a, sessionId);
    expect(none.statusCode, none.body).toBe(422);
    expect(errorOf(none)).toMatchObject({ code: "precondition_unmet", details: { reason: "no_draft" } });
    await patch(a, sessionId, { draft_content_md: "a draft not yet measured" });
    const pending = await cutPatch(a, sessionId);
    expect(errorOf(pending)).toMatchObject({ code: "precondition_unmet", details: { reason: "draft_not_ready" } });
    const notReady = await readySession(a, projectId, clusterId, "pending");
    expect(errorOf(await cutPatch(a, notReady))).toMatchObject({ code: "precondition_unmet", details: { reason: "session_not_ready" } });
    expect((await harness.db().query("SELECT count(*)::int AS n FROM patches")).rows[0].n).toBe(0);
  }, 120_000);

  it("AC patch H15 · 201 with the same wire shape as GET /patches/{id}: the customer's draft, the page hash, a reversal, free; a repeat with a new key is a NEW immutable row, the same key replays; the body is empty and strict", async () => {
    const a = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId);
    await harness.db().query(`UPDATE geo_alignments SET draft_content_md = '# CRM\n\nReporting for teams, with more.', draft_state = 'ready', baseline_alignment = 0.4, current_alignment = 0.5 WHERE id = $1`, [sessionId]);
    const key = randomUUID();
    const res = await cutPatch(a, sessionId, key);
    expect(res.statusCode, res.body).toBe(201);
    const body = dataOf<Record<string, unknown>>(res);
    expect(auxPatchSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ kind: "markdown", finding_id: null, rule_code: null, content_after: "# CRM\n\nReporting for teams, with more.", free: true, credits_charged: 0, requires_human_review: false, page_matches: null, target_url: PAGE });
    expect((body.reversal as { operation: string }).operation).toBe("replace_file");
    expect(String(body.content_before_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);

    const replay = await cutPatch(a, sessionId, key);
    expect(dataOf<{ patch_id: string }>(replay).patch_id).toBe((body as { patch_id: string }).patch_id);
    const again = await cutPatch(a, sessionId, randomUUID());
    expect(again.statusCode).toBe(201);
    expect(dataOf<{ patch_id: string }>(again).patch_id).not.toBe((body as { patch_id: string }).patch_id);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM patches WHERE session_id = $1", [sessionId])).rows[0].n).toBe(2);
    expect((await cutPatch(a, sessionId, randomUUID(), { content: "generated prose" })).statusCode).toBe(400);
    expect((await cutPatch(a, sessionId, null)).statusCode).toBe(400);

    // and it is readable through the AUX route like any patch
    const read = await harness.app().inject({ method: "GET", url: apiUrl(`/patches/${(body as { patch_id: string }).patch_id}`), headers: { cookie: a.cookie } });
    expect(read.statusCode, read.body).toBe(200);
    const audit = (await harness.db().query("SELECT after_state FROM audit_log WHERE workspace_id = $1 AND action = 'geo_alignment.patched'", [a.workspaceId])).rows;
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("with more");
    await noCharge(a);
  }, 120_000);

  it("AC patch H16 · another workspace cannot cut a patch from, or read, this session: 404", async () => {
    const a = await owner();
    const b = await owner();
    const projectId = await project(a);
    const clusterId = await cluster(a, projectId);
    const sessionId = await readySession(a, projectId, clusterId);
    await harness.db().query(`UPDATE geo_alignments SET draft_content_md = 'd', draft_state = 'ready' WHERE id = $1`, [sessionId]);
    expect((await cutPatch(b, sessionId)).statusCode).toBe(404);
    expect((await patch(b, sessionId, { draft_content_md: "intrusion" })).statusCode).toBe(404);
    expect((await harness.db().query("SELECT count(*)::int AS n FROM patches")).rows[0].n).toBe(0);
  }, 120_000);
});

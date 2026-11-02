import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Job } from "bullmq";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, UnsafeTargetError, ValidationFailedError } from "../../src/api/errors/domain-errors.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import type { GuardedResponse } from "../../src/lib/net/guarded-fetch.js";
import type { QueueHandlerContext } from "../../src/lib/queue/handlers.js";
import { attemptsFor } from "../../src/lib/queue/queue-factory.js";
import { phasesOf } from "../../src/lib/queue/worker-factory.js";
import { topologyFor } from "../../src/lib/queue/topology.js";
import {
  commitSubmissionVerification,
  prepareSubmissionVerification,
} from "../../src/lib/sources/verify-submission.js";
import { createSourceVerifyPresenceHandler } from "../../src/lib/queue/handlers/source-verify-presence.handler.js";
import type { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { refreshProjectSourceIndex } from "../../src/lib/rollup/refresh-project-source-index.js";
import { verifyProjectSourcePresence } from "../../src/lib/sources/verify-presence.js";
import { GoalsService } from "../../src/modules/tasks/goals.service.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { completeTaskResponseSchema, taskEventSchema, taskSchema } from "../../contracts/tasks/index.js";

// STORY-055 AC5-AC8 + AC11 (owner decision 30), scenarios 4-9, over real SQL: a SEEDING task is completed with a URL, goes
// `in_review`, and a `source.verify_presence` job (guarded fetch, faked here - no network) moves it to `done` with the milestones
// and the presence flag, or leaves it in review with a specific reason. The fetch is the job's: the request fetches nothing.

const TODAY = "2026-10-07";
const NOW = new Date("2026-10-08T12:00:00Z");
const URL_OK = "https://reviews.dev/threads/best-tools-compared";

const page = (text: string, finalUrl = URL_OK, status = 200, type = "text/html"): GuardedResponse => ({
  status,
  headers: { "content-type": type },
  body: Buffer.from(`<html><body><p>${text}</p></body></html>`),
  finalUrl,
});

describe("STORY-055 · seeding-task completion with a URL and its verification", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let actorId: string;
  const enqueueTenantJob = vi.fn();
  const realtime = new NoopRealtimePublisher();
  const service = new TasksService(new NoopRealtimePublisher(), { enqueueTenantJob } as unknown as QueueProducer);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    enqueueTenantJob.mockReset().mockResolvedValue(undefined);
    realtime.published.length = 0;
    await db.query("TRUNCATE citation_facts, project_source_index, source_domains, milestones, tasks, task_events, projects, workspaces, users CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    actorId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await db.query("INSERT INTO users (id, email) VALUES ($1,$2)", [actorId, `u-${actorId}@example.com`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, brand_aliases, negative_aliases)
       VALUES ($1,$2,'Acme Analytics',$3,'https://acme.com','acme.com','{Acme}','{}')`,
      [projectId, workspaceId, `p-${projectId.slice(0, 8)}`],
    );
  });

  const inTenant = <T>(fn: () => Promise<T>, ws = workspaceId): Promise<T> => withTenantContext(db, { workspaceId: ws, actorId }, fn);

  async function cite(domain: string, prompt: number): Promise<void> {
    const url = `https://${domain}/best`;
    await db.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url,
          url_hash, domain, is_owned, is_competitor, source_class, http_status, position_weight)
       VALUES ($1,$2,$3,$4,'gemini', $5::date - 1 + interval '12 hours', 1,$6,$6,$7,$8,false,false,'community_forum',200,1)`,
      [workspaceId, projectId, randomUUID(), randomUUID(), TODAY, url, createHash("sha256").update(url + prompt).digest(), domain],
    );
  }

  /** A gap: reviews.dev is cited and verified ABSENT, so the index carries a `critical` gap on it. */
  async function openGap(): Promise<void> {
    for (let i = 0; i < 6; i++) await cite("reviews.dev", i);
    await db.query("BEGIN");
    await refreshProjectSourceIndex(db, projectId, TODAY);
    await db.query("COMMIT");
    await inTenant(() => verifyProjectSourcePresence(db, projectId, { fetch: async () => page("Only Globex here."), now: new Date(NOW.getTime() - 86_400_000), today: TODAY }));
  }

  async function task(opts: { playbook?: string | null; domain?: string | null; status?: string; kind?: string } = {}): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO tasks (id, workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description, status, playbook_slug, source_domain_id)
       VALUES ($1,$2,$3,$4,$5,$6,'Contribute to reviews.dev','d',$7,$8,(SELECT id FROM source_domains WHERE domain = $9))`,
      [id, workspaceId, projectId, `T-${id.slice(0, 6)}`, opts.kind ?? "authority", randomBytes(16), opts.status ?? "todo",
       opts.playbook === undefined ? "community-forum-contribution" : opts.playbook, opts.domain === undefined ? "reviews.dev" : opts.domain],
    );
    await db.query("UPDATE projects SET open_task_count = (SELECT count(*) FROM tasks WHERE project_id = $1 AND status IN ('todo','in_progress','in_review'))::int WHERE id = $1", [projectId]);
    return id;
  }

  const submit = (taskId: string, url?: string) => inTenant(() => service.completeTask(taskId, url === undefined ? undefined : { url }));
  const lastSubmission = async (taskId: string): Promise<string> =>
    (await db.query<{ id: string }>("SELECT id FROM task_events WHERE task_id = $1 AND event = 'verification_submitted' ORDER BY occurred_at DESC, id DESC LIMIT 1", [taskId])).rows[0]!.id;

  /** The job, through the real handler (its phases composed on one client - the shape for a handler spec). */
  const job = (taskId: string, submissionId: string, fetch: (url: string) => Promise<GuardedResponse>, ws = workspaceId) =>
    withTenantContext(db, { workspaceId: ws, actorId }, (tx) =>
      createSourceVerifyPresenceHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, { fetch, now: () => new Date(), realtime })(
        tx,
        { data: { payload: { workspaceId: ws, kid: "k", projectId, taskId, submissionId } } } as unknown as Job,
      ),
    );

  const row = async (taskId: string) => (await db.query("SELECT status, completed_at, completed_by, milestone_id FROM tasks WHERE id = $1", [taskId])).rows[0]!;
  const milestones = async () => (await db.query("SELECT kind, source_type, occurred_at FROM milestones WHERE project_id = $1 ORDER BY kind", [projectId])).rows;
  const events = async (taskId: string) => (await db.query("SELECT event, from_value, to_value, payload, actor_type FROM task_events WHERE task_id = $1 ORDER BY occurred_at, id", [taskId])).rows;
  const openCount = async () => (await db.query("SELECT open_task_count FROM projects WHERE id = $1", [projectId])).rows[0].open_task_count as number;
  const gap = async () =>
    (await db.query("SELECT gap_severity, brand_present_on_domain FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id WHERE sd.domain = 'reviews.dev' AND psi.engine_key = 'all' AND psi.window_days = 30")).rows[0];

  describe("AC5 / scenarios 4 and 8 · the request", () => {
    it("scenario 4 - completing a seeding task without a URL is refused and changes nothing", async () => {
      await openGap();
      const id = await task();
      const error = await submit(id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationFailedError);
      expect((await row(id)).status).toBe("todo");
      expect(await events(id)).toEqual([]);
      expect(enqueueTenantJob).not.toHaveBeenCalled();
    });

    it("scenario 8 - an internal address is 422 unsafe_target at submit; nothing is written and nothing is queued", async () => {
      await openGap();
      const id = await task();
      for (const url of ["http://127.0.0.1/x", "http://10.0.0.7/x", "http://169.254.169.254/latest", "http://[::1]/x", "ftp://reviews.dev/x", "http://localhost/x"]) {
        const error = await submit(id, url).catch((e: unknown) => e);
        expect(error, url).toBeInstanceOf(UnsafeTargetError);
      }
      expect((await row(id)).status).toBe("todo");
      expect(await events(id)).toEqual([]);
      expect(enqueueTenantJob).not.toHaveBeenCalled();
    });

    it("a valid URL: the task is in_review (not done), pending, with no milestone, and ONE job is enqueued after commit", async () => {
      await openGap();
      const id = await task({ status: "in_progress" });
      const out = await submit(id, URL_OK);
      expect(completeTaskResponseSchema.parse(out)).toEqual(out);
      expect(out.milestone).toBeNull();
      expect(out.task.status).toBe("in_review");
      expect(out.task.completed_at).toBeNull();
      expect(out.task.review).toMatchObject({ state: "pending", url: URL_OK, reason: null });
      expect(await milestones()).toEqual([]);
      expect(await events(id)).toEqual([expect.objectContaining({ event: "verification_submitted", from_value: "in_progress", to_value: "in_review", payload: { url: URL_OK } })]);
      const submission = await lastSubmission(id);
      expect(enqueueTenantJob.mock.calls).toEqual([["source.verify_presence", workspaceId, { projectId, taskId: id, submissionId: submission }, { idempotencyKey: `taskverify:${submission}` }]]);
    });

    it("in_review is OPEN: submitting changes no open count", async () => {
      await openGap();
      const id = await task();
      expect(await openCount()).toBe(1);
      await submit(id, URL_OK);
      expect(await openCount()).toBe(1);
    });

    it("a task in review with its URL still being checked is a 409, with no second event or job", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const error = await submit(id, URL_OK).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as { details: unknown }).details).toMatchObject({ current_state: "in_review" });
      // the 409 re-queues the SAME submission's job (idempotent key), it does not queue a second submission
      expect(enqueueTenantJob.mock.calls.map((c) => c[3])).toHaveLength(2);
      expect(new Set(enqueueTenantJob.mock.calls.map((c) => (c[3] as { idempotencyKey: string }).idempotencyKey)).size).toBe(1);
      expect((await events(id)).filter((e) => e.event === "verification_submitted")).toHaveLength(1);
    });

    it("every other task completes exactly as before: no body, done, task_completed milestone, no job", async () => {
      const plain = await task({ playbook: null, domain: null, kind: "content" });
      const out = await submit(plain);
      expect(out.task.status).toBe("done");
      expect(out.milestone).toMatchObject({ kind: "task_completed" });
      expect(enqueueTenantJob).not.toHaveBeenCalled();
      expect(await openCount()).toBe(0);
    });

    it("review r3 - a url sent for a task that is not a seeding task is a 400, and the task is untouched", async () => {
      const stray = await task({ playbook: null, domain: null, kind: "technical" });
      const error = await submit(stray, "https://reddit.com/r/x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationFailedError);
      expect((await row(stray)).status).toBe("todo");
      expect(enqueueTenantJob).not.toHaveBeenCalled();
    });

    it("review r3 - a seeding task with a playbook but NO source domain is refused (fails closed) with the reason no_source_domain", async () => {
      const id = await task({ domain: null });
      const error = await submit(id, URL_OK).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as { details: unknown }).details).toMatchObject({ reason: "no_source_domain" });
      expect((await row(id)).status).toBe("todo");
      expect(await events(id)).toEqual([]);
    });

    it("review r3 - a URL that carries credentials is a 400, and the stored URL is the normalised href", async () => {
      await openGap();
      const id = await task();
      for (const url of ["https://user:pw@reviews.dev/x", "https://user@reviews.dev/x"]) {
        const error = await submit(id, url).catch((e: unknown) => e);
        expect(error, url).toBeInstanceOf(ValidationFailedError);
      }
      expect(await events(id)).toEqual([]);
      const out = await submit(id, "  HTTPS://Reviews.DEV:443/Threads/Acme#frag  ");
      expect(out.task.review).toMatchObject({ url: "https://reviews.dev/Threads/Acme#frag" });
      expect((await events(id))[0]!.payload).toEqual({ url: "https://reviews.dev/Threads/Acme#frag" });
    });

    it("review r3 M2 - a submission whose job was never queued is NOT stuck: the next submit re-queues the SAME key (409), and the job then completes the task", async () => {
      await openGap();
      const id = await task();
      enqueueTenantJob.mockRejectedValueOnce(new Error("redis down"));
      await submit(id, URL_OK);
      await new Promise((resolve) => setImmediate(resolve)); // the failed enqueue is logged, not thrown
      const submission = await lastSubmission(id);
      expect(enqueueTenantJob).toHaveBeenCalledTimes(1);
      const error = await submit(id, URL_OK).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(enqueueTenantJob).toHaveBeenCalledTimes(2);
      expect(enqueueTenantJob.mock.calls[1]).toEqual(["source.verify_presence", workspaceId, { projectId, taskId: id, submissionId: submission }, { idempotencyKey: `taskverify:${submission}` }]);
      await job(id, submission, vi.fn().mockResolvedValue(page("Acme Analytics")));
      expect((await row(id)).status).toBe("done");
      expect((await events(id)).filter((e) => e.event === "verification_submitted")).toHaveLength(1); // the 409 wrote no second submission
    });
  });

  describe("AC6, AC7, AC8 / scenarios 5 and 9 · the job verifies", () => {
    it("scenario 5 - a page that names the brand: done, task_completed AND source_seeded milestones, the gap closes, counts follow", async () => {
      await openGap();
      expect((await gap()).gap_severity).toBe("critical");
      const id = await task();
      await submit(id, URL_OK);
      const fetch = vi.fn().mockResolvedValue(page("Acme Analytics answered the question"));
      await job(id, await lastSubmission(id), fetch);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(URL_OK, expect.objectContaining({ followRedirect: expect.any(Function) }));
      const done = await row(id);
      expect(done.status).toBe("done");
      expect(done.completed_by).toBe(actorId);
      expect(done.milestone_id).not.toBeNull();
      expect((await milestones()).map((m) => m.kind)).toEqual(["source_seeded", "task_completed"]);
      expect((await events(id)).map((e) => e.event)).toEqual(["verification_submitted", "completed"]);
      expect((await events(id))[1]).toMatchObject({ from_value: "in_review", to_value: "done", actor_type: "system" });
      expect(await openCount()).toBe(0);
      // AC8: the flag flipped and the recompute carries the gap closed
      expect(await gap()).toEqual({ gap_severity: "none", brand_present_on_domain: true });
    });

    it("review r3 - the in_review -> done transition is AUDITED (system actor) and publishes task.moved from the worker, after commit", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      realtime.published.length = 0;
      await job(id, await lastSubmission(id), vi.fn().mockResolvedValue(page("Acme Analytics")));
      const audit = (await db.query("SELECT action, actor_type, resource_type, resource_id FROM audit_log WHERE resource_id = $1", [id])).rows;
      expect(audit).toEqual([{ action: "task.verification_completed", actor_type: "system", resource_type: "task", resource_id: id }]);
      expect(realtime.published).toEqual([expect.objectContaining({ event: "task.moved", payload: { task_id: id, project_id: projectId } })]);
    });

    it("review r3 - a failed check writes no audit row and announces the changed review once; a no-op redelivery announces nothing", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const submission = await lastSubmission(id);
      realtime.published.length = 0;
      await job(id, submission, vi.fn().mockResolvedValue(page("Globex")));
      expect((await db.query("SELECT 1 FROM audit_log WHERE resource_id = $1", [id])).rows).toEqual([]);
      expect(realtime.published).toHaveLength(1);
      realtime.published.length = 0;
      await job(id, submission, vi.fn());
      expect(realtime.published).toEqual([]);
    });

    it("scenario 9 - recomputing the index afterwards keeps the presence flag and the closed gap", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      await job(id, await lastSubmission(id), vi.fn().mockResolvedValue(page("Acme Analytics")));
      await db.query("BEGIN");
      await refreshProjectSourceIndex(db, projectId, TODAY);
      await db.query("COMMIT");
      expect(await gap()).toEqual({ gap_severity: "none", brand_present_on_domain: true });
    });

    it("a redelivery after success fetches nothing and writes nothing more", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const submission = await lastSubmission(id);
      const fetch = vi.fn().mockResolvedValue(page("Acme Analytics"));
      await job(id, submission, fetch);
      await job(id, submission, fetch);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await milestones()).toHaveLength(2);
      expect((await events(id)).filter((e) => e.event === "completed")).toHaveLength(1);
    });

    it("the whole task response and list carry the typed review, validated against the contract", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const listed = await inTenant(() => service.listProjectTasks(projectId, { sort: "impact", limit: 50 } as never));
      const found = listed.items.find((t) => t.id === id)!;
      expect(taskSchema.parse(found)).toEqual(found);
      expect(found.status).toBe("in_review");
      expect(found.review).toMatchObject({ state: "pending" });
    });
  });

  describe("AC11 / scenarios 6 and 7 · the job leaves the task in review, with a specific reason", () => {
    const failureCase = async (fetch: (url: string) => Promise<GuardedResponse>, reason: string) => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const submission = await lastSubmission(id);
      await job(id, submission, fetch);
      expect((await row(id)).status).toBe("in_review");
      expect(await milestones()).toEqual([]);
      const failed = (await events(id)).filter((e) => e.event === "verification_failed");
      expect(failed).toEqual([expect.objectContaining({ payload: { submission_id: submission, reason }, actor_type: "system" })]);
      const read = (await inTenant(() => service.listProjectTasks(projectId, { sort: "impact", limit: 50 } as never))).items.find((t) => t.id === id)!;
      expect(read.review).toMatchObject({ state: "unverified", reason, url: URL_OK });
      expect(await gap()).toMatchObject({ brand_present_on_domain: false, gap_severity: "critical" }); // the gap stays open
      expect(await openCount()).toBe(1);
      return { id, submission };
    };

    it("scenario 6 - the URL resolves but names no brand: reason no_mention, the task stays in review", async () => {
      await failureCase(vi.fn().mockResolvedValue(page("A thread about Globex only")), "no_mention");
    });

    it("scenario 7 - an unreachable URL (the fetch errors): reason unreachable", async () => {
      await failureCase(vi.fn().mockRejectedValue(new Error("ECONNRESET")), "unreachable");
    });

    it("scenario 7 - a 404 is unreachable too", async () => {
      await failureCase(vi.fn().mockResolvedValue(page("Not found", URL_OK, 404)), "unreachable");
    });

    it("a PDF or image is not_a_page", async () => {
      await failureCase(vi.fn().mockResolvedValue(page("%PDF", URL_OK, 200, "application/pdf")), "not_a_page");
    });

    it("a host that the guarded fetch refuses at connect time (DNS now private) is unsafe_target", async () => {
      const { GuardedFetchRefusal } = await import("../../src/lib/net/guarded-fetch.js");
      await failureCase(vi.fn().mockRejectedValue(new GuardedFetchRefusal("address_not_global")), "unsafe_target");
    });

    it("a URL that names the brand but is NOT on the task's domain is wrong_domain, and is never fetched", async () => {
      await openGap();
      const id = await task();
      await submit(id, "https://elsewhere.example.org/acme");
      const fetch = vi.fn().mockResolvedValue(page("Acme Analytics"));
      await job(id, await lastSubmission(id), fetch);
      expect(fetch).not.toHaveBeenCalled();
      expect((await row(id)).status).toBe("in_review");
      expect((await events(id)).filter((e) => e.event === "verification_failed")).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reason: "wrong_domain" }) })]);
    });

    it("a redirect that lands off the task's domain is wrong_domain even though the page names the brand", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      await job(id, await lastSubmission(id), vi.fn().mockResolvedValue(page("Acme Analytics", "https://evil.example.org/landing")));
      expect((await row(id)).status).toBe("in_review");
      expect(await milestones()).toEqual([]);
      expect((await events(id)).filter((e) => e.event === "verification_failed")[0]!.payload).toMatchObject({ reason: "wrong_domain" });
    });

    it("a redelivery after a failure fetches nothing and writes no second failure", async () => {
      const { id, submission } = await failureCase(vi.fn().mockResolvedValue(page("Globex")), "no_mention");
      const fetch = vi.fn();
      await job(id, submission, fetch);
      expect(fetch).not.toHaveBeenCalled();
      expect((await events(id)).filter((e) => e.event === "verification_failed")).toHaveLength(1);
    });

    it("after a failure the customer may submit another URL, and THAT submission verifies", async () => {
      const { id, submission } = await failureCase(vi.fn().mockResolvedValue(page("Globex")), "no_mention");
      await submit(id, "https://reviews.dev/threads/second-try");
      const second = await lastSubmission(id);
      expect(second).not.toBe(submission);
      expect(enqueueTenantJob).toHaveBeenCalledTimes(2);
      await job(id, second, vi.fn().mockResolvedValue(page("Acme Analytics")));
      expect((await row(id)).status).toBe("done");
      // the first submission's job, redelivered late, is stale and changes nothing
      const late = vi.fn();
      await job(id, submission, late);
      expect(late).not.toHaveBeenCalled();
      expect((await milestones()).map((m) => m.kind)).toEqual(["source_seeded", "task_completed"]);
    });
  });

  describe("races and tenancy", () => {
    it("a task moved out of review while the fetch ran is not completed by the late answer", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const submission = await lastSubmission(id);
      const fetch = vi.fn().mockImplementation(async () => {
        await db.query("UPDATE tasks SET status = 'in_progress' WHERE id = $1", [id]);
        return page("Acme Analytics");
      });
      await job(id, submission, fetch);
      expect((await row(id)).status).toBe("in_progress");
      expect(await milestones()).toEqual([]);
      expect(await gap()).toMatchObject({ brand_present_on_domain: false });
    });

    it("a late answer for a SUPERSEDED submission does not complete the task, even though the task is back in review on a newer one", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const first = await lastSubmission(id);
      const fetch = vi.fn().mockImplementation(async () => {
        // while the first URL is being fetched: the customer moves the task out of review and submits another URL
        await db.query("UPDATE tasks SET status = 'in_progress' WHERE id = $1", [id]);
        await db.query(
          `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, from_value, to_value, payload, occurred_at)
           VALUES ($1,$2,$3,'user','verification_submitted','in_progress','in_review','{"url":"https://reviews.dev/threads/second"}'::jsonb, clock_timestamp())`,
          [workspaceId, id, actorId],
        );
        await db.query("UPDATE tasks SET status = 'in_review' WHERE id = $1", [id]);
        return page("Acme Analytics");
      });
      await job(id, first, fetch);
      expect((await row(id)).status).toBe("in_review");
      expect(await milestones()).toEqual([]);
      expect((await events(id)).filter((e) => e.event === "completed" || e.event === "verification_failed")).toEqual([]);
      expect(await gap()).toMatchObject({ brand_present_on_domain: false });
    });

    // ---- review r4 -----------------------------------------------------------------------------------------------------------
    async function secondClient(): Promise<Client> {
      const c = new Client({ connectionString: container.getConnectionUri() });
      await c.connect();
      return c;
    }

    it("review r4 - two CONCURRENT deliveries of one submission complete the task once (one milestone pair, one completed event, one audit row)", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const submission = await lastSubmission(id);
      const plan = await withTenantContext(db, { workspaceId, actorId }, (tx) => prepareSubmissionVerification(tx, projectId, id, submission));
      expect(plan).not.toBeNull();
      const db2 = await secondClient();
      try {
        const commit = (c: Client) => withTenantContext(c, { workspaceId, actorId }, (tx) => commitSubmissionVerification(tx, plan!, { status: "verified" }, new Date()));
        const results = await Promise.all([commit(db), commit(db2)]);
        expect(results.filter(Boolean)).toHaveLength(1);
      } finally {
        await db2.end();
      }
      expect((await events(id)).filter((e) => e.event === "completed")).toHaveLength(1);
      expect((await milestones()).map((m) => m.kind)).toEqual(["source_seeded", "task_completed"]);
      expect((await db.query("SELECT 1 FROM audit_log WHERE resource_id = $1", [id])).rows).toHaveLength(1);
    });

    it("review r4 - the RESUBMISSION race: a newer submission that commits while the older answer waits on the task row lock makes the older answer a no-op", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const first = await lastSubmission(id);
      const plan = await withTenantContext(db, { workspaceId, actorId }, (tx) => prepareSubmissionVerification(tx, projectId, id, first));
      const db2 = await secondClient();
      try {
        // A (db2): the resubmit's transaction - it holds the task row lock and has written the newer submission, uncommitted.
        await db2.query("BEGIN");
        await db2.query("SELECT id FROM tasks WHERE id = $1 FOR UPDATE", [id]);
        await db2.query(
          `INSERT INTO task_events (workspace_id, task_id, actor_id, actor_type, event, from_value, to_value, payload, occurred_at)
           VALUES ($1,$2,$3,'user','verification_submitted','in_review','in_review','{"url":"https://reviews.dev/threads/second"}'::jsonb, clock_timestamp())`,
          [workspaceId, id, actorId],
        );
        // B (db): the older answer. It takes the rollup's advisory lock, then waits on the task row lock A holds.
        const answer = withTenantContext(db, { workspaceId, actorId }, (tx) => commitSubmissionVerification(tx, plan!, { status: "verified" }, new Date()));
        for (let i = 0; i < 100; i += 1) {
          const waiting = await db2.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR NO KEY UPDATE%'");
          if (waiting.rows[0].n > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await db2.query("COMMIT");
        await expect(answer).resolves.toBe(false);
      } finally {
        await db2.end();
      }
      expect((await row(id)).status).toBe("in_review");
      expect(await milestones()).toEqual([]);
      expect((await events(id)).filter((e) => e.event === "completed")).toEqual([]);
    });

    it("review r4 - a job whose LAST attempt fails answers the submission unreachable (the task is not left pending); an earlier attempt, a stale or foreign payload does not", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const submission = await lastSubmission(id);
      const handler = createSourceVerifyPresenceHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, { fetch: vi.fn(), realtime });
      const phases = phasesOf(handler)!;
      const jobOf = (attemptsMade: number, payload: Record<string, unknown> = { workspaceId, kid: "k", projectId, taskId: id, submissionId: submission }) =>
        ({ attemptsMade, opts: { attempts: 4 }, data: { payload } }) as unknown as Job;
      const recover = (job: Job) => withTenantContext(db, { workspaceId, actorId }, (tx) => phases.recover!(tx, job, { error: new Error("db down"), phase: "commit" }));

      await expect(recover(jobOf(1))).resolves.toBe(false); // attempt 2 of 4: the queue retries
      await expect(recover(jobOf(3, { workspaceId, kid: "k", projectId }))).resolves.toBe(false); // not a submission job
      expect((await events(id)).filter((e) => e.event === "verification_failed")).toEqual([]);

      await expect(recover(jobOf(3))).resolves.toBe(true); // attempt 4 of 4
      expect((await events(id)).filter((e) => e.event === "verification_failed")).toEqual([expect.objectContaining({ payload: { submission_id: submission, reason: "unreachable" } })]);
      await expect(recover(jobOf(3))).resolves.toBe(false); // already answered: nothing more
      expect((await events(id)).filter((e) => e.event === "verification_failed")).toHaveLength(1);
      // and the customer is no longer stuck: the task shows the reason and a resubmit is accepted
      const out = await submit(id, "https://reviews.dev/threads/again");
      expect(out.task.review).toMatchObject({ state: "pending" });
    });

    it("review r5 - recover uses the topology's REAL attempt count (attemptsFor), and the answer it writes is announced as task.moved", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const submission = await lastSubmission(id);
      const attempts = attemptsFor(topologyFor("source.verify_presence"));
      const handler = createSourceVerifyPresenceHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, { fetch: vi.fn(), realtime });
      const phases = phasesOf(handler)!;
      const jobAt = (attempt: number) =>
        ({ attemptsMade: attempt - 1, opts: { attempts }, data: { payload: { workspaceId, kid: "k", projectId, taskId: id, submissionId: submission } } }) as unknown as Job;
      const recover = (job: Job) => withTenantContext(db, { workspaceId, actorId }, (tx) => phases.recover!(tx, job, { error: new Error("db down"), phase: "commit" }));

      expect(attempts).toBeGreaterThan(1);
      realtime.published.length = 0;
      await expect(recover(jobAt(attempts - 1))).resolves.toBe(false); // the attempt before the last: the queue retries
      expect(realtime.published).toEqual([]);
      await expect(recover(jobAt(attempts))).resolves.toBe(true); // the last attempt the topology allows
      expect((await events(id)).filter((e) => e.event === "verification_failed")).toHaveLength(1);
      expect(realtime.published).toEqual([expect.objectContaining({ event: "task.moved", payload: { task_id: id, project_id: projectId } })]);
      realtime.published.length = 0;
      await expect(recover(jobAt(attempts))).resolves.toBe(false); // answered already: nothing written, nothing announced
      expect(realtime.published).toEqual([]);
    });

    it("review r5 - EVERY statement against tasks, task_events or project_source_index carries workspace_id = app.current_workspace(), bar a short explicit list", async () => {
      await openGap();
      const id = await task();
      const seen: string[] = [];
      let recording = true;
      const original = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
      (db as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text;
        if (text !== undefined && recording) seen.push(text);
        return original(...args);
      };
      const lookup = async <T>(fn: () => Promise<T>): Promise<T> => {
        recording = false; // this spec's own helpers run as the superuser; they are not production SQL
        try {
          return await fn();
        } finally {
          recording = true;
        }
      };
      try {
        await submit(id, URL_OK); // the request: lock, submission insert, status update, readTask
        const first = await lookup(() => lastSubmission(id));
        await job(id, first, vi.fn().mockResolvedValue(page("Globex only"))); // a failed check: prepare + commitLocked + the failure insert
        await expect(submit(id, "https://reviews.dev/threads/second")).resolves.toBeDefined(); // a resubmit after the failure
        const second = await lookup(() => lastSubmission(id));
        await expect(submit(id, "https://reviews.dev/threads/third")).rejects.toBeInstanceOf(ConflictError); // the pending 409 path
        await job(id, second, vi.fn().mockResolvedValue(page("Acme Analytics"))); // the verified path: milestones, index, counts
        await inTenant(() => service.listProjectTasks(projectId, { sort: "impact", limit: 50 } as never)); // REVIEW_SELECT
        // the give-up path
        const other = await lookup(() => task()); // spec setup, not production SQL
        await submit(other, URL_OK);
        const stuck = await lookup(() => lastSubmission(other));
        const handler = createSourceVerifyPresenceHandler({ pool: undefined, env: {} } as unknown as QueueHandlerContext, { fetch: vi.fn(), realtime });
        const gaveUp = { attemptsMade: 0, opts: { attempts: 1 }, data: { payload: { workspaceId, kid: "k", projectId, taskId: other, submissionId: stuck } } } as unknown as Job;
        await withTenantContext(db, { workspaceId, actorId }, (tx) => phasesOf(handler)!.recover!(tx, gaveUp, { error: new Error("db down"), phase: "commit" }));
        // the non-seeding path of completeTask: milestone insert, the status update, the event
        const plainTask = await lookup(() => task({ playbook: null, domain: null, kind: "content" }));
        await submit(plainTask);
      } finally {
        (db as unknown as { query: unknown }).query = original;
      }

      const TOUCHES = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?(?:tasks|task_events|project_source_index)\b/iu;
      const touching = seen.filter((sql) => TOUCHES.test(sql));
      expect(touching.length).toBeGreaterThanOrEqual(15);

      // THE EXEMPTION LIST. Each entry is the FULL, EXACT text (whitespace folded) of one statement of the shared rollup index rebuild
      // (src/lib/rollup/refresh-project-source-index.ts, refresh-project-source-coverage.ts and refresh-project-task-counts.ts), which every presence write
      // calls. They are bounded by RLS and by project_id, over a whole project's index, never a task selected by a caller-supplied id.
      // A pattern is NOT enough: a looser match once also covered commitLocked's own UPDATE on project_source_index. Adding needs a reason.
      const fold = (sql: string) => sql.replace(/\s+/gu, " ").trim();
      const EXEMPT: ReadonlyArray<{ readonly text: string; readonly why: string }> = [
        {
          text: "SELECT DISTINCT ON (sd.domain) sd.domain, psi.brand_present_on_domain AS present, psi.verified_at::text AS verified_at FROM project_source_index psi JOIN source_domains sd ON sd.id = psi.source_domain_id WHERE psi.project_id = $1 AND psi.verified_at IS NOT NULL AND psi.brand_present_on_domain IS NOT NULL ORDER BY sd.domain, psi.verified_at DESC",
          why: "refreshProjectSourceIndex: carries verified presence across the rebuild",
        },
        { text: "WITH open_tasks AS ( SELECT t.id, COALESCE(af.severity, psi.gap_severity) AS severity FROM tasks t LEFT JOIN aux_findings af ON af.id = t.source_finding_id LEFT JOIN LATERAL ( SELECT gap_severity FROM project_source_index WHERE source_domain_id = t.source_domain_id AND project_id = t.project_id AND engine_key = $2 AND window_days = $3 ORDER BY window_start DESC LIMIT 1 ) psi ON t.source_domain_id IS NOT NULL WHERE t.project_id = $1 AND t.status IN ('todo', 'in_progress', 'in_review') AND t.deleted_at IS NULL ) SELECT count(*) FILTER (WHERE severity = 'critical')::text AS critical, count(*) FILTER (WHERE severity = 'high')::text AS high, count(*) FILTER (WHERE severity = 'medium')::text AS medium, count(*) FILTER (WHERE severity = 'low')::text AS low, count(*)::text AS total FROM open_tasks", why: "refreshProjectTaskCounts (src/lib/rollup/refresh-project-task-counts.ts): the whole-project open-task recount" },
        { text: "DELETE FROM project_source_index WHERE project_id = $1", why: "refreshProjectSourceIndex: replaces the project's index" },
        {
          text: "SELECT max(window_start)::text AS window_start FROM project_source_index WHERE project_id = $1 AND engine_key = $2 AND window_days = $3",
          why: "refreshProjectSourceCoverage: latest window",
        },
        {
          text: "SELECT context_weight::text, gap_severity FROM project_source_index WHERE project_id = $1 AND engine_key = $2 AND window_days = $3 AND window_start = $4::date",
          why: "refreshProjectSourceCoverage: the window's rows",
        },
      ];
      const INDEX_INSERT = /^INSERT INTO project_source_index \( ?workspace_id,/iu; // the rebuild's INSERT names workspace_id as a column; RLS WITH CHECK pins it
      const isExempt = (sql: string) => EXEMPT.some((e) => fold(sql) === e.text) || INDEX_INSERT.test(fold(sql));
      const offenders = touching.filter((sql) => !sql.includes("app.current_workspace()") && !isExempt(sql));
      expect(offenders, offenders.join("\n---\n")).toEqual([]);
      // the exemptions are not a loophole: each must actually be used, or it is dead weight to delete
      for (const e of EXEMPT) expect(touching.some((sql) => fold(sql) === e.text), e.why).toBe(true);
      expect(touching.some((sql) => INDEX_INSERT.test(fold(sql)))).toBe(true);
    });

    it("another workspace's context cannot verify (or fetch for) this task", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const otherWorkspace = randomUUID();
      await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W2',$2,'growth','UTC')", [otherWorkspace, `w-${randomUUID().slice(0, 8)}`]);
      const fetch = vi.fn();
      const submission = await lastSubmission(id);
      await db.query("SET ROLE nominara_app");
      try {
        await job(id, submission, fetch, otherWorkspace);
      } finally {
        await db.query("RESET ROLE");
      }
      expect(fetch).not.toHaveBeenCalled();
      expect((await row(id)).status).toBe("in_review");
      expect((await events(id)).filter((e) => e.event === "verification_failed")).toEqual([]);
    });
  });

  describe("owner decision 30 · in_review is OPEN everywhere a todo or in_progress task is", () => {
    it("the cross-project action queue and the portal's open list still show the task; the portal status is in_review", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const queue = await inTenant(() => service.listActionItems({ limit: 50 } as never));
      expect(queue.items.map((i) => i.id)).toContain(id);
      const portal = await inTenant(() => service.portalTasks(projectId, { hideCompetitors: false, completedSince: null }));
      expect(portal.open.map((o) => o.status)).toEqual(["in_review"]);
      expect(portal.completed).toEqual([]);
    });

    it("review r5 - the served task says whether it CAN BE COMPLETED WITH A URL (it has a source domain), in the list and in a response", async () => {
      await openGap();
      const both = await task();
      const playbookOnly = await task({ domain: null });
      const domainOnly = await task({ playbook: null });
      const plain = await task({ playbook: null, domain: null, kind: "content" });
      const listed = (await inTenant(() => service.listProjectTasks(projectId, { sort: "impact", limit: 50 } as never))).items;
      const seedingOf = (id: string) => listed.find((t) => t.id === id)!.seeding;
      // `seeding` = "can be completed with a URL" = has a source domain. A playbook-only task is refused with no_source_domain, so it is false.
      expect([both, playbookOnly, domainOnly, plain].map(seedingOf)).toEqual([true, false, true, false]);
      for (const t of listed) expect(taskSchema.parse(t)).toEqual(t);
      expect((await submit(both, URL_OK)).task.seeding).toBe(true);
      expect((await submit(plain)).task.seeding).toBe(false);
      // and the flag matches what the request does: the playbook-only task it calls false is the one completeTask refuses
      await expect(submit(playbookOnly, URL_OK)).rejects.toMatchObject({ details: expect.objectContaining({ reason: "no_source_domain" }) });
    });

    it("the status filter finds a task in review, and a goal counts it in tasks_total but never in tasks_done", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const filtered = await inTenant(() => service.listProjectTasks(projectId, { sort: "impact", limit: 50, status: "in_review" } as never));
      expect(filtered.items.map((t) => t.id)).toEqual([id]);
      expect((await inTenant(() => service.listProjectTasks(projectId, { sort: "impact", limit: 50, status: "todo" } as never))).items).toEqual([]);
      const goalId = randomUUID();
      await db.query(
        `INSERT INTO goals (id, workspace_id, project_id, title, kind, target, status) VALUES ($1,$2,$3,'g','custom','{"metric":"citation_share","value":0.5}'::jsonb,'active')`,
        [goalId, workspaceId, projectId],
      );
      await db.query("UPDATE tasks SET goal_id = $2 WHERE id = $1", [id, goalId]);
      const goals = new GoalsService();
      const listed = await inTenant(() => goals.listGoals(projectId, { limit: 50 } as never));
      expect(listed.items[0]).toMatchObject({ tasks_done: 0, tasks_total: 1 });
    });

    it("review r3 - openGeoTasks (the digest levers) links a task in review", async () => {
      const id = await task({ playbook: null, domain: null, kind: "content", status: "in_review" });
      await db.query("UPDATE tasks SET rule_code = 'TG-ENTITY-ALIAS', source_geo_analysis = 'entity' WHERE id = $1", [id]);
      const levers = await inTenant(() => service.openGeoTasks(projectId, ["TG-ENTITY-ALIAS"]));
      expect(levers.map((l) => l.task_id)).toEqual([id]);
    });

    it("the task event contract accepts the two new event kinds", async () => {
      await openGap();
      const id = await task();
      await submit(id, URL_OK);
      const page1 = await inTenant(() => service.listTaskEvents(id, { limit: 50 } as never));
      for (const e of page1.items) expect(taskEventSchema.parse(e)).toEqual(e);
      expect(page1.items.map((e) => e.event)).toContain("verification_submitted");
    });
  });
});

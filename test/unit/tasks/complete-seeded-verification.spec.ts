import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, UnsafeTargetError, ValidationFailedError } from "../../../src/api/errors/domain-errors.js";
import { NoopRealtimePublisher } from "../../../src/lib/cache/realtime-publisher.js";
import type { QueueProducer } from "../../../src/lib/queue/queue-producer.js";
import { TasksService } from "../../../src/modules/tasks/tasks.service.js";
import * as tenantContext from "../../../src/tenancy/tenant-context.js";

// STORY-055 AC5 + AC6 (owner decision 30), superseding the STORY-066 AC8 trigger this file used to pin ("completing an authority
// task enqueues the verification of its OWN target", reference gap 4: the endpoint took no body). Completing a SEEDING task now
// takes the customer's contribution URL:
//   - no URL is refused (scenario 4), an internal address is `422 unsafe_target` (scenario 8), both BEFORE any write;
//   - the task goes `in_review`, NOT `done`: no milestone, no `completed` event, a `verification_submitted` event instead;
//   - the verification job is enqueued AFTER COMMIT, keyed by the submission, and the request fetches nothing (KAD-06).
// A task that is not a seeding task completes exactly as before.

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "22222222-2222-7222-8222-222222222222";
const TASK = "33333333-3333-7333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-7444-8444-444444444444";
const SUBMISSION = "77777777-7777-7777-8777-777777777777";
const OCCURRED_AT = new Date("2026-10-20T09:15:00.000Z");
const URL_OK = "https://www.reddit.com/r/saas/comments/abc/best_tools/";

interface TaskFixture {
  kind: string;
  source_domain_id: string | null;
  playbook_slug: string | null;
  status?: string;
  pending?: boolean;
}

function service(task: TaskFixture) {
  const deferred: (() => void)[] = [];
  const statements: string[] = [];
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
    context: { workspaceId: WS, actorId: "55555555-5555-7555-8555-555555555555" },
    client: {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("FOR UPDATE OF t")) {
          return { rows: [{ project_id: PROJECT, status: task.status ?? "in_progress", title: "Contribute", in_scope: true, ...task }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO milestones")) return { rows: [{ id: "66666666-6666-7666-8666-666666666666", occurred_at: OCCURRED_AT }], rowCount: 1 };
        if (sql.includes("verification_submitted") && sql.includes("INSERT INTO task_events")) return { rows: [{ id: SUBMISSION }], rowCount: 1 };
        if (sql.includes("verification_submitted")) return { rows: [{ id: SUBMISSION, pending: task.pending ?? false }], rowCount: 1 };
        return { rows: [{ critical: "0", high: "0", medium: "0", low: "0", total: "0" }], rowCount: 1 };
      }),
    },
  } as never);
  vi.spyOn(tenantContext, "afterCommit").mockImplementation((effect: () => void) => {
    deferred.push(effect);
  });
  vi.spyOn(TasksService.prototype as unknown as { readTask: () => Promise<unknown> }, "readTask").mockResolvedValue({ id: TASK });
  const enqueueTenantJob = vi.fn().mockResolvedValue(undefined);
  const tasks = new TasksService(new NoopRealtimePublisher(), { enqueueTenantJob } as unknown as QueueProducer);
  return { tasks, enqueueTenantJob, statements, commit: () => deferred.forEach((effect) => effect()) };
}

const SEEDING: TaskFixture = { kind: "authority", source_domain_id: DOMAIN_ID, playbook_slug: "reddit-contribution" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("STORY-055 AC5 · a seeding task requires a URL", () => {
  it("scenario 4 — completing a seeding task with no body is refused, and nothing was written", async () => {
    const s = service(SEEDING);
    const error = await s.tasks.completeTask(TASK).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect(JSON.stringify((error as { details: unknown }).details)).toContain("url");
    expect(s.statements.some((sql) => /^\s*(INSERT|UPDATE)/u.test(sql))).toBe(false);
    s.commit();
    expect(s.enqueueTenantJob).not.toHaveBeenCalled();
  });

  it("a source domain alone makes a task a seeding task (a URL is required)", async () => {
    const s = service({ kind: "authority", source_domain_id: DOMAIN_ID, playbook_slug: null });
    await expect(s.tasks.completeTask(TASK, {})).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it("review r3 - a playbook with NO source domain is refused with no_source_domain (fails closed), before any write", async () => {
    const s = service({ kind: "content", source_domain_id: null, playbook_slug: "reddit-contribution" });
    const error = await s.tasks.completeTask(TASK, { url: URL_OK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as { details: unknown }).details).toMatchObject({ reason: "no_source_domain" });
    expect(s.statements.some((sql) => /^\s*(INSERT|UPDATE)/u.test(sql))).toBe(false);
  });

  it("review r3 - a URL carrying credentials is a 400 validation_failed, before any write", async () => {
    const s = service(SEEDING);
    const error = await s.tasks.completeTask(TASK, { url: "https://me:secret@www.reddit.com/r/x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationFailedError);
    expect(JSON.stringify(error)).not.toContain("secret");
    expect(s.statements.some((sql) => /^\s*(INSERT|UPDATE)/u.test(sql))).toBe(false);
  });

  it("scenario 8 — an internal address is 422 unsafe_target at submit, naming the check and never the address, with no write", async () => {
    const s = service(SEEDING);
    const error = await s.tasks.completeTask(TASK, { url: "http://169.254.169.254/latest/meta-data" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeTargetError);
    expect((error as { details: unknown }).details).toEqual({ reason: "address_not_global" });
    expect(JSON.stringify(error)).not.toContain("169.254");
    expect(s.statements.some((sql) => /^\s*(INSERT|UPDATE)/u.test(sql))).toBe(false);
    s.commit();
    expect(s.enqueueTenantJob).not.toHaveBeenCalled();
  });
});

describe("STORY-055 AC6 · a submitted URL goes in_review and is verified by a job, never by the request", () => {
  it("writes in_review + a verification_submitted event, no milestone, no completed event; enqueues once, only AFTER commit", async () => {
    const s = service(SEEDING);
    await s.tasks.completeTask(TASK, { url: URL_OK });
    expect(s.statements.some((sql) => sql.includes("INSERT INTO milestones"))).toBe(false);
    expect(s.statements.some((sql) => sql.includes("'in_review'") && sql.includes("UPDATE tasks"))).toBe(true);
    expect(s.statements.some((sql) => sql.includes("'completed'") && sql.includes("INSERT INTO task_events"))).toBe(false);
    expect(s.enqueueTenantJob, "nothing is enqueued while the transaction is open").not.toHaveBeenCalled();
    s.commit();
    expect(s.enqueueTenantJob.mock.calls).toEqual([
      ["source.verify_presence", WS, { projectId: PROJECT, taskId: TASK, submissionId: SUBMISSION }, { idempotencyKey: `taskverify:${SUBMISSION}` }],
    ]);
  });

  it("the response is pending verification: a null milestone and the in_review task", async () => {
    const s = service(SEEDING);
    const out = await s.tasks.completeTask(TASK, { url: URL_OK });
    expect(out.milestone).toBeNull();
    expect(out.verification).toBeNull(); // STORY-067's scheduling, untouched; the review state is task.review
  });

  it("a task already in review with its URL still being checked is a 409 that re-queues the SAME submission's job (idempotent key), and writes nothing", async () => {
    const s = service({ ...SEEDING, status: "in_review", pending: true });
    const error = await s.tasks.completeTask(TASK, { url: URL_OK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as { details: unknown }).details).toMatchObject({ current_state: "in_review" });
    expect(s.statements.some((sql) => /^\s*(INSERT|UPDATE)/u.test(sql))).toBe(false);
    // Not deferred to after-commit: the 409 rolls the request back, and the submission itself was committed long ago.
    expect(s.enqueueTenantJob.mock.calls).toEqual([
      ["source.verify_presence", WS, { projectId: PROJECT, taskId: TASK, submissionId: SUBMISSION }, { idempotencyKey: `taskverify:${SUBMISSION}` }],
    ]);
  });

  it("the 409's re-queue failing still answers 409 (never a 500)", async () => {
    const s = service({ ...SEEDING, status: "in_review", pending: true });
    s.enqueueTenantJob.mockRejectedValue(new Error("redis down"));
    await expect(s.tasks.completeTask(TASK, { url: URL_OK })).rejects.toBeInstanceOf(ConflictError);
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("a task in review whose last check failed may be submitted again", async () => {
    const s = service({ ...SEEDING, status: "in_review", pending: false });
    await s.tasks.completeTask(TASK, { url: URL_OK });
    s.commit();
    expect(s.enqueueTenantJob).toHaveBeenCalledTimes(1);
  });

  it("a failing enqueue never fails the submission: the task is in review and the failure is logged", async () => {
    const s = service(SEEDING);
    s.enqueueTenantJob.mockRejectedValue(new Error("redis down"));
    await expect(s.tasks.completeTask(TASK, { url: URL_OK })).resolves.toMatchObject({ milestone: null });
    expect(() => s.commit()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.enqueueTenantJob).toHaveBeenCalledTimes(1);
  });
});

describe("STORY-055 · every other task completes exactly as before", () => {
  it("a content task with no playbook and no source domain completes with no body: done, milestone, no job", async () => {
    const s = service({ kind: "content", source_domain_id: null, playbook_slug: null });
    const out = await s.tasks.completeTask(TASK);
    expect(out.milestone).toMatchObject({ kind: "task_completed" });
    expect(s.statements.some((sql) => sql.includes("INSERT INTO milestones"))).toBe(true);
    s.commit();
    expect(s.enqueueTenantJob).not.toHaveBeenCalled();
  });

  it("review r3 - a URL sent for a task that is not a seeding task is a 400, never fetched, never queued", async () => {
    const s = service({ kind: "technical", source_domain_id: null, playbook_slug: null });
    await expect(s.tasks.completeTask(TASK, { url: "https://example.org/x" })).rejects.toBeInstanceOf(ValidationFailedError);
    expect(s.statements.some((sql) => /^\s*(INSERT|UPDATE)/u.test(sql))).toBe(false);
    s.commit();
    expect(s.enqueueTenantJob).not.toHaveBeenCalled();
  });
});

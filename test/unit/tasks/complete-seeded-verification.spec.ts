import { afterEach, describe, expect, it, vi } from "vitest";
import { NoopRealtimePublisher } from "../../../src/lib/cache/realtime-publisher.js";
import type { QueueProducer } from "../../../src/lib/queue/queue-producer.js";
import { TasksService } from "../../../src/modules/tasks/tasks.service.js";
import * as tenantContext from "../../../src/tenancy/tenant-context.js";

// STORY-066 AC8 — `source_seeded` fires on "completion of an authority task
// with a verified target URL" (`scoring-models.md` §13). Completion is the
// trigger: `completeTask` asks for the verification of the task's target, and
// asks only AFTER COMMIT (a job enqueued inside the transaction could run
// before the `done` row is visible, and a rolled-back completion must ask
// for nothing). The fetch itself is the job's, never the request's (KAD-06).

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "22222222-2222-7222-8222-222222222222";
const TASK = "33333333-3333-7333-8333-333333333333";
const DOMAIN_ID = "44444444-4444-7444-8444-444444444444";
const COMPLETED_AT = new Date("2026-10-20T09:15:00.000Z");

function service(task: { kind: string; source_domain_id: string | null }, completedAt: Date = COMPLETED_AT) {
  const deferred: (() => void)[] = [];
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
    context: { workspaceId: WS, actorId: "55555555-5555-7555-8555-555555555555" },
    client: {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FOR UPDATE OF t")) {
          return { rows: [{ project_id: PROJECT, status: "in_progress", title: "Contribute", in_scope: true, ...task }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO milestones")) return { rows: [{ id: "66666666-6666-7666-8666-666666666666", occurred_at: completedAt }], rowCount: 1 };
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
  return { tasks, enqueueTenantJob, commit: () => deferred.forEach((effect) => effect()) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("STORY-066 AC8 · completing an authority task requests the verification of its target", () => {
  it("an authority task on a source domain asks source.verify_presence to verify THIS task, once, only after commit", async () => {
    const s = service({ kind: "authority", source_domain_id: DOMAIN_ID });
    await s.tasks.completeTask(TASK);
    expect(s.enqueueTenantJob, "nothing is enqueued while the transaction is open").not.toHaveBeenCalled();
    s.commit();
    const verifications = s.enqueueTenantJob.mock.calls.filter(([queue]) => queue === "source.verify_presence");
    expect(verifications).toEqual([["source.verify_presence", WS, { projectId: PROJECT, taskId: TASK }, { idempotencyKey: `srcver:seeded:${TASK}:${COMPLETED_AT.getTime()}` }]]);
  });

  it("review round 3 — a task reopened and completed again asks for a SECOND verification (the key is the completion's, not the task's)", async () => {
    const keys: unknown[] = [];
    for (const at of [COMPLETED_AT, new Date("2026-10-27T10:00:00.000Z"), COMPLETED_AT]) {
      const s = service({ kind: "authority", source_domain_id: DOMAIN_ID }, at);
      await s.tasks.completeTask(TASK);
      s.commit();
      keys.push(s.enqueueTenantJob.mock.calls.find(([queue]) => queue === "source.verify_presence")![3]);
      vi.restoreAllMocks();
    }
    expect(keys[0]).not.toEqual(keys[1]); // a re-completion is a new job, not deduplicated away by the first one's id
    expect(keys[2]).toEqual(keys[0]); // the same completion (a redelivered effect) is still one job
  });

  it("a content task, or an authority task with no source domain, asks for no verification", async () => {
    for (const task of [{ kind: "content", source_domain_id: null }, { kind: "authority", source_domain_id: null }]) {
      const s = service(task);
      await s.tasks.completeTask(TASK);
      s.commit();
      expect(s.enqueueTenantJob.mock.calls.filter(([queue]) => queue === "source.verify_presence")).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it("a failing enqueue never fails the completion — the task is done and the milestone stands", async () => {
    const s = service({ kind: "authority", source_domain_id: DOMAIN_ID });
    s.enqueueTenantJob.mockRejectedValue(new Error("redis down"));
    await expect(s.tasks.completeTask(TASK)).resolves.toMatchObject({ milestone: { kind: "task_completed" } });
    expect(() => s.commit()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(s.enqueueTenantJob).toHaveBeenCalledTimes(1);
  });
});

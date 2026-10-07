import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { TasksModule } from "./tasks.module.js";
import { TasksController } from "./tasks.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · TasksModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TasksModule] }).compile();
    expect(moduleRef.get(TasksController)).toBeInstanceOf(TasksController);
    await moduleRef.close();
  });
});

// STORY-064 (step A) — GET /v1/projects/{id}/tasks wiring and observability.
import { Reflector } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { vi } from "vitest";
import { PROJECT_PARAM_KEY } from "../../api/decorators/project-param.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { taskListQuerySchema } from "../../../contracts/tasks/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { TasksService } from "./tasks.service.js";
import type { ClientBase } from "pg";
import { withTenantContext } from "../../tenancy/tenant-context.js";

/** A fake pg client: the project lookup finds `projectRows`; the task query finds nothing. */
function fakeClient(projectRows: unknown[], seen: string[]): ClientBase {
  return {
    query: async (sql: string) => {
      seen.push(sql);
      if (sql.includes("FROM projects")) return { rows: projectRows };
      return { rows: [] };
    },
  } as unknown as ClientBase;
}
const ctx = (workspaceId: string) => ({ workspaceId, actorId: "actor" });

describe("STORY-064 · project task list route", () => {
  const reflector = new Reflector();
  const handler = TasksController.prototype.list;

  it("requires task:read and binds the scope check to the :id project", () => {
    expect(reflector.get(REQUIRE_PERMISSION_KEY, handler)).toBe("task:read");
    expect(reflector.get(PROJECT_PARAM_KEY, handler)).toBe("id");
  });

  it("counts the list and logs the workspace ID, project ID and sort — never a task title", async () => {
    const logs: unknown[] = [];
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    const seen: string[] = [];
    await withTenantContext(fakeClient([{ id: "p" }], seen), ctx("ws-1"), () =>
      new TasksService().listProjectTasks("p", taskListQuerySchema.parse({ sort: "age" })),
    );
    log.mockRestore();
    expect(logs).toContainEqual({ metric: "nominara_tasks_list_total", value: 1, sort: "age" });
    const line = logs.find((l) => (l as { message?: string }).message === "project tasks listed");
    expect(line).toEqual({ message: "project tasks listed", workspace_id: "ws-1", project_id: "p", sort: "age", returned: 0 });
  });

  it("throws NotFoundError when the project lookup finds nothing, before reading any task", async () => {
    const seen: string[] = [];
    await expect(
      withTenantContext(fakeClient([], seen), ctx("ws-1"), () =>
        new TasksService().listProjectTasks("p", taskListQuerySchema.parse({})),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(seen.some((q) => q.includes("FROM tasks"))).toBe(false);
  });
});

// STORY-064 (step B) — PATCH /v1/tasks/{id} wiring and observability.
import { SCOPED_BY_QUERY_KEY } from "../../api/decorators/scoped-by-query.decorator.js";
import { AUDIT_METADATA_KEY } from "../../api/decorators/audit.decorator.js";
import { ConflictError } from "../../api/errors/domain-errors.js";
import { updateTaskRequestSchema } from "../../../contracts/tasks/index.js";

describe("STORY-064 · PATCH /tasks/{id} route", () => {
  const reflector = new Reflector();
  const handler = TasksController.prototype.update;

  it("requires task:move, is audited, and leaves scope to the service (the URL names a task, not a project)", () => {
    expect(reflector.get(REQUIRE_PERMISSION_KEY, handler)).toBe("task:move");
    expect(reflector.get(SCOPED_BY_QUERY_KEY, handler)).toBe(true);
    expect(reflector.get(AUDIT_METADATA_KEY, handler)).toMatchObject({ action: "task.updated", resourceType: "task" });
  });

  it("the request is strict: an ordering field, an unknown key, an empty body and a bad priority are all refused", () => {
    expect(updateTaskRequestSchema.safeParse({ position: 1 }).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ priority: 6 }).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ priority: 0 }).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ dismiss_reason: "x" }).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ priority: 1, assignee_id: null, due_at: null, goal_id: null }).success).toBe(true);
    expect(updateTaskRequestSchema.safeParse({ due_at: "tomorrow" }).success).toBe(false);
  });

  it("status=done is a 409 before any query runs", async () => {
    const seen: string[] = [];
    await expect(
      withTenantContext(fakeClient([], seen), ctx("ws-1"), () =>
        new TasksService().updateTask("t", updateTaskRequestSchema.parse({ status: "done" })),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(seen.some((q) => q.includes("FROM tasks"))).toBe(false);
  });

  it("an unknown task is a NotFoundError", async () => {
    await expect(
      withTenantContext(fakeClient([], []), ctx("ws-1"), () =>
        new TasksService().updateTask("t", updateTaskRequestSchema.parse({ priority: 2 })),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("logs the workspace ID, task ID and event names — never the dismissal reason — and counts each event", async () => {
    const logs: unknown[] = [];
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    const client = {
      query: async (sql: string) => {
        if (sql.includes("FOR UPDATE OF t")) {
          return { rows: [{ id: "t", project_id: "p", status: "todo", assignee_id: null, priority: 3, due_at: null, goal_id: null, dismissed_reason: null, in_scope: true }] };
        }
        if (sql.includes("FROM tasks t")) {
          return { rows: [{ id: "t", short_ref: "H-1", project_id: "p", goal_id: null, title: "T", description: "D", kind: "content", origin: "auto", status: "dismissed", severity: null,
            source_finding_id: null, source_domain_id: null, source_displacement_id: null, rule_code: null, priority: 3, impact_score: 1, effort_band: "m", assignee_id: null,
            due_at: null, dismissed_reason: "SECRET REASON", resurface_at: null, completed_at: null, affected_url: null, created_at: new Date(), updated_at: new Date() }] };
        }
        return { rows: [{ critical: "0", high: "0", medium: "0", low: "0", total: "0" }] };
      },
    } as unknown as ClientBase;
    await withTenantContext(client, ctx("ws-1"), () =>
      new TasksService().updateTask("t", updateTaskRequestSchema.parse({ status: "dismissed", dismiss_reason: "SECRET REASON" })),
    );
    log.mockRestore();
    expect(logs).toContainEqual({ metric: "nominara_tasks_events_written_total", value: 1, event: "dismissed" });
    const line = logs.find((l) => (l as { message?: string }).message === "task updated");
    expect(line).toEqual({ message: "task updated", workspace_id: "ws-1", task_id: "t", events: ["dismissed"] });
    expect(JSON.stringify(logs)).not.toContain("SECRET REASON");
  });
});

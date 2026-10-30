import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { NoopRealtimePublisher } from "../../lib/cache/realtime-publisher.js";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { TasksModule } from "./tasks.module.js";
import { TasksController } from "./tasks.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · TasksModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    // STORY-064 (step D): TasksModule now builds the realtime publisher, which validates the env eagerly.
    const originalEnv = { ...process.env };
    applyFakeApiEnv();
    const moduleRef = await Test.createTestingModule({ imports: [TasksModule] }).compile();
    expect(moduleRef.get(TasksController)).toBeInstanceOf(TasksController);
    await moduleRef.close();
    process.env = originalEnv;
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
      new TasksService(new NoopRealtimePublisher()).listProjectTasks("p", taskListQuerySchema.parse({ sort: "age" })),
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
        new TasksService(new NoopRealtimePublisher()).listProjectTasks("p", taskListQuerySchema.parse({})),
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
        new TasksService(new NoopRealtimePublisher()).updateTask("t", updateTaskRequestSchema.parse({ status: "done" })),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(seen.some((q) => q.includes("FROM tasks"))).toBe(false);
  });

  it("an unknown task is a NotFoundError", async () => {
    await expect(
      withTenantContext(fakeClient([], []), ctx("ws-1"), () =>
        new TasksService(new NoopRealtimePublisher()).updateTask("t", updateTaskRequestSchema.parse({ priority: 2 })),
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
      new TasksService(new NoopRealtimePublisher()).updateTask("t", updateTaskRequestSchema.parse({ status: "dismissed", dismiss_reason: "SECRET REASON" })),
    );
    log.mockRestore();
    expect(logs).toContainEqual({ metric: "nominara_tasks_events_written_total", value: 1, event: "dismissed" });
    const line = logs.find((l) => (l as { message?: string }).message === "task updated");
    expect(line).toEqual({ message: "task updated", workspace_id: "ws-1", task_id: "t", events: ["dismissed"] });
    expect(JSON.stringify(logs)).not.toContain("SECRET REASON");
  });
});

// STORY-064 (step C) — POST /projects/{id}/tasks, POST /tasks/{id}/comments, GET /tasks/{id}/events.
import { IDEMPOTENT_KEY } from "../../api/decorators/idempotent.decorator.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { completeTaskRequestSchema, createCommentRequestSchema, createTaskRequestSchema } from "../../../contracts/tasks/index.js";

describe("STORY-064-C · route wiring and contracts", () => {
  const reflector = new Reflector();
  const proto = TasksController.prototype as unknown as Record<string, () => void>;

  it("create: task:create, idempotent, project-scoped by :id, audited", () => {
    const h = proto.create!;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, h)).toBe("task:create");
    expect(reflector.get(IDEMPOTENT_KEY, h)).toBe(true);
    expect(reflector.get(PROJECT_PARAM_KEY, h)).toBe("id");
    expect(reflector.get(AUDIT_METADATA_KEY, h)).toMatchObject({ action: "task.created", resourceType: "task" });
    expect(reflector.get(API_CONTRACT_KEY, h)).toMatchObject({ operationId: "createProjectTask" });
  });

  it("comment: task:comment, idempotent, scope enforced by the service", () => {
    const h = proto.comment!;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, h)).toBe("task:comment");
    expect(reflector.get(IDEMPOTENT_KEY, h)).toBe(true);
    expect(reflector.get(SCOPED_BY_QUERY_KEY, h)).toBe(true);
    expect(reflector.get(API_CONTRACT_KEY, h)).toMatchObject({ operationId: "createTaskComment" });
  });

  it("events: task:read, a paginated list, scope enforced by the service", () => {
    const h = proto.events!;
    expect(reflector.get(REQUIRE_PERMISSION_KEY, h)).toBe("task:read");
    expect(reflector.get(SCOPED_BY_QUERY_KEY, h)).toBe(true);
    expect(reflector.get(API_CONTRACT_KEY, h)).toMatchObject({ operationId: "listTaskEvents", listOf: true });
  });

  it("create request is strict: an ordering field, origin, status and an empty or oversized title are refused", () => {
    expect(createTaskRequestSchema.safeParse({ title: "t" }).success).toBe(true);
    expect(createTaskRequestSchema.safeParse({ title: "t", position: 1 }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ title: "t", origin: "auto" }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ title: "t", status: "done" }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ title: "t", kind: "bogus" }).success).toBe(false);
  });

  it("comment body is 1..4000 characters and strict", () => {
    expect(createCommentRequestSchema.safeParse({ body: "" }).success).toBe(false);
    expect(createCommentRequestSchema.safeParse({ body: "a".repeat(4000) }).success).toBe(true);
    expect(createCommentRequestSchema.safeParse({ body: "a".repeat(4001) }).success).toBe(false);
    expect(createCommentRequestSchema.safeParse({ body: "x", extra: 1 }).success).toBe(false);
  });

  it("create counts the task and logs the workspace and task IDs only — never the title", async () => {
    const logs: unknown[] = [];
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    const taskRow = { id: "t", short_ref: "PRO-1", project_id: "p", goal_id: null, title: "SECRET TITLE", description: "", kind: "content", origin: "manual", status: "todo", severity: null,
      source_finding_id: null, source_domain_id: null, source_displacement_id: null, rule_code: null, priority: 3, impact_score: 0, effort_band: "m", assignee_id: null,
      due_at: null, dismissed_reason: null, resurface_at: null, completed_at: null, affected_url: null, created_at: new Date(), updated_at: new Date() };
    const client = {
      query: async (sql: string) => {
        if (sql.includes("FROM projects")) return { rows: [{ id: "p", name: "Project", in_scope: true }] };
        if (sql.includes("RETURNING next_value")) return { rows: [{ used: 1 }] };
        if (sql.includes("INSERT INTO tasks")) return { rows: [{ id: "t" }] };
        if (sql.includes("FROM tasks t")) return { rows: [taskRow] };
        return { rows: [{ critical: "0", high: "0", medium: "0", low: "0", total: "0" }] };
      },
    } as unknown as ClientBase;
    await withTenantContext(client, ctx("ws-1"), () => new TasksService(new NoopRealtimePublisher()).createTask("p", createTaskRequestSchema.parse({ title: "SECRET TITLE" })));
    log.mockRestore();
    expect(logs).toContainEqual({ metric: "nominara_tasks_created_total", value: 1, origin: "manual" });
    expect(logs.find((l) => (l as { message?: string }).message === "task created")).toEqual({ message: "task created", workspace_id: "ws-1", task_id: "t", project_id: "p" });
    expect(JSON.stringify(logs)).not.toContain("SECRET TITLE");
  });
});

// STORY-064-D checkpoint-2 — the decorators on POST /tasks/{id}/complete were
// correct but unguarded: removing @Idempotent() or weakening task:move to
// task:read left every test green. Each assertion below is pinned to one of
// those mutations.
describe("STORY-064-D · complete route wiring", () => {
  const reflector = new Reflector();
  const proto = TasksController.prototype as unknown as Record<string, () => void>;

  it("STORY-064-D AC6 · complete requires task:move", () => {
    expect(reflector.get(REQUIRE_PERMISSION_KEY, proto.complete!)).toBe("task:move");
  });

  it("STORY-064-D AC6 · complete is @Idempotent", () => {
    expect(reflector.get(IDEMPOTENT_KEY, proto.complete!)).toBe(true);
  });

  it("STORY-064-D AC6 · complete enforces project scope in the service (ScopedByQuery) and is audited as task.completed", () => {
    const h = proto.complete!;
    expect(reflector.get(SCOPED_BY_QUERY_KEY, h)).toBe(true);
    expect(reflector.get(AUDIT_METADATA_KEY, h)).toMatchObject({ action: "task.completed", resourceType: "task" });
  });

  it("STORY-064-D AC1 · complete publishes the completeTask operation with a response schema and (owner decision 30) an optional-url request body", () => {
    const contract = reflector.get(API_CONTRACT_KEY, proto.complete!) as { operationId: string; requestSchema?: unknown; responseSchema?: unknown };
    expect(contract.operationId).toBe("completeTask");
    expect(contract.responseSchema).toBeDefined();
    expect(contract.requestSchema).toBe(completeTaskRequestSchema);
  });
});

// STORY-055 (owner decision 30) — the complete body is OPTIONAL: a client that sends nothing (every non-seeding completion) still
// parses, a `url` parses, and an unknown key is a 400 rather than a silent drop.
describe("STORY-055 · complete takes an optional strict body", () => {
  function bodyPipe(): { transform: (value: unknown) => unknown } {
    const args = Reflect.getMetadata("__routeArguments__", TasksController, "complete") as Record<string, { data?: unknown; pipes: { transform: (v: unknown) => unknown }[] }>;
    const body = Object.entries(args).find(([key]) => key.startsWith("3:"))?.[1]; // RouteParamtypes.BODY = 3
    return body!.pipes[0]!;
  }

  it("no body at all is {} (a content task completes exactly as before)", () => {
    expect(bodyPipe().transform(undefined)).toEqual({});
  });

  it("a url passes through; an unknown key, an empty url, and a non-string url are refused", () => {
    expect(bodyPipe().transform({ url: "https://reddit.com/r/x" })).toEqual({ url: "https://reddit.com/r/x" });
    expect(() => bodyPipe().transform({ status: "done" })).toThrow();
    expect(() => bodyPipe().transform({ url: "" })).toThrow();
    expect(() => bodyPipe().transform({ url: 5 })).toThrow();
  });
});

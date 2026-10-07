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

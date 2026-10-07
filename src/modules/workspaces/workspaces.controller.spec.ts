import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { WorkspacesController } from "./workspaces.controller.js";
import type { RbacScopedRequest } from "../../api/guards/rbac.guard.js";

// STORY-169 review (minor) — `listActionItems` was the only route in this
// controller with no test at all reaching the controller layer: the
// integration suite (`test/integration/action-items.spec.ts`) calls
// `TasksService.listActionItems` directly, one level below
// `assertMatchesTenant`, so a broken or removed tenant check there would
// pass every existing test. Mutation evidence for the finding: replacing
// the `assertMatchesTenant` call with a no-op left `vitest run test/unit
// src contracts` fully green (2639/2639) — this file is what closes that
// gap, at the same seam `tasks.service.spec.ts` already uses (a plain
// constructor call, no `Test.createTestingModule` — nothing here does I/O).

describe("STORY-169 review · WorkspacesController.listActionItems — assertMatchesTenant", () => {
  function controllerWith(tasksListActionItems: ReturnType<typeof vi.fn>): WorkspacesController {
    const tasks = { listActionItems: tasksListActionItems } as unknown as ConstructorParameters<typeof WorkspacesController>[2];
    return new WorkspacesController(
      {} as ConstructorParameters<typeof WorkspacesController>[0],
      {} as ConstructorParameters<typeof WorkspacesController>[1],
      tasks,
      {} as ConstructorParameters<typeof WorkspacesController>[3],
    );
  }

  it("a path id that differs from the tenant's workspace throws NotFoundException and issues no query", () => {
    // `listActionItems` is not `async` — `assertMatchesTenant` throws
    // SYNCHRONOUSLY before any `Promise` is ever returned, so this asserts
    // against the call directly rather than `.rejects`.
    const listActionItems = vi.fn();
    const controller = controllerWith(listActionItems);
    const req = { tenant: { workspaceId: "ws-real", actorId: "actor-1" } } as unknown as RbacScopedRequest;

    expect(() => controller.listActionItems(req, "ws-other", { limit: 50 } as never)).toThrow(NotFoundException);
    expect(listActionItems).not.toHaveBeenCalled();
  });

  it("a path id that matches the tenant's workspace calls through to TasksService.listActionItems", async () => {
    const page = { items: [], pagination: { cursor_next: null, has_more: false, limit: 50 } };
    const listActionItems = vi.fn().mockResolvedValue(page);
    const controller = controllerWith(listActionItems);
    const req = { tenant: { workspaceId: "ws-real", actorId: "actor-1" } } as unknown as RbacScopedRequest;

    const result = await controller.listActionItems(req, "ws-real", { limit: 50 } as never);
    expect(result).toBe(page);
    expect(listActionItems).toHaveBeenCalledTimes(1);
  });
});

describe("NEW-B-2 · WorkspacesController.summary — assertMatchesTenant", () => {
  const req = { tenant: { workspaceId: "ws-real", actorId: "actor-1" } } as unknown as RbacScopedRequest;
  function controllerWith(summary: ReturnType<typeof vi.fn>): WorkspacesController {
    return new WorkspacesController(
      {} as ConstructorParameters<typeof WorkspacesController>[0],
      {} as ConstructorParameters<typeof WorkspacesController>[1],
      {} as ConstructorParameters<typeof WorkspacesController>[2],
      { summary } as unknown as ConstructorParameters<typeof WorkspacesController>[3],
    );
  }

  it("another workspace's id is refused (NotFoundException) and nothing is read", () => {
    const summary = vi.fn();
    expect(() => controllerWith(summary).summary(req, "ws-other")).toThrow(NotFoundException);
    expect(summary).not.toHaveBeenCalled();
  });

  it("the tenant's own id calls through", async () => {
    const summary = vi.fn().mockResolvedValue({ ok: true });
    await expect(controllerWith(summary).summary(req, "ws-real")).resolves.toEqual({ ok: true });
    expect(summary).toHaveBeenCalledWith("ws-real");
  });
});

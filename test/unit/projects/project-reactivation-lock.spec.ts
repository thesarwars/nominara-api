import type { ClientBase } from "pg";
import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../../../src/api/errors/domain-errors.js";
import { incrementCounter } from "../../../src/lib/telemetry/metrics.js";
import { reactivateProject } from "../../../src/modules/projects/project-reactivation.js";

vi.mock("../../../src/lib/telemetry/metrics.js", () => ({ incrementCounter: vi.fn() }));

// STORY-077, review round 2 (minor): reactivateProject reused lockWorkspaceForActivation, so a lock-wait timeout on a
// reactivation was counted as nominara_workspace_lock_wait_exceeded_total{path="prompt_activation"}. It names its own path.

const WS = "11111111-1111-7111-8111-111111111111";
const PROJECT = "33333333-3333-7333-8333-333333333333";

describe("STORY-077 · reactivateProject's lock-wait timeout", () => {
  it("is a retryable 503 counted under path=\"project_reactivation\"", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM workspaces WHERE id = $1 FOR UPDATE")) throw Object.assign(new Error("lock timeout"), { code: "55P03" });
        return { rows: [] };
      }),
    } as unknown as ClientBase;
    const error = await reactivateProject(client, { workspaceId: WS, projectId: PROJECT, actor: { type: "system", id: null, requestId: "req-1" } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("degraded");
    expect(vi.mocked(incrementCounter)).toHaveBeenCalledWith("nominara_workspace_lock_wait_exceeded_total", { path: "project_reactivation" });
    expect(vi.mocked(incrementCounter)).not.toHaveBeenCalledWith("nominara_workspace_lock_wait_exceeded_total", { path: "prompt_activation" });
  });
});

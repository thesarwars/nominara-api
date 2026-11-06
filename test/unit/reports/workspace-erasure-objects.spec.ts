import { describe, expect, it, vi } from "vitest";
import { executeWorkspaceHardDelete } from "../../../src/workers/rollup/retention.js";

// STORY-180 r5 (b) - workspace erasure deletes the workspace's report objects AFTER the cascade has committed, never inside it.

const WS = "0190aaaa-0000-7000-8000-00000000000a";

function client(opts: { failOn?: string } = {}) {
  const order: string[] = [];
  const c = {
    query: vi.fn(async (text: string) => {
      const head = text.trim().split(/\s+/).slice(0, 2).join(" ");
      order.push(head);
      if (opts.failOn !== undefined && text.includes(opts.failOn)) throw new Error("db down");
      return { rows: [], rowCount: 0 };
    }),
  };
  return { c, order };
}

describe("executeWorkspaceHardDelete · report objects", () => {
  it("calls deleteWorkspaceObjects AFTER COMMIT, with the workspace id", async () => {
    const { c, order } = client();
    const deleteWorkspaceObjects = vi.fn(async (_id: string) => void order.push("OBJECTS"));
    await executeWorkspaceHardDelete(c as never, WS, { exportComplianceRecords: async () => undefined, deleteWorkspaceObjects });
    expect(deleteWorkspaceObjects).toHaveBeenCalledWith(WS);
    expect(order.indexOf("OBJECTS")).toBeGreaterThan(order.indexOf("COMMIT"));
    expect(order.at(-1)).toBe("OBJECTS");
  });

  it("deletes NO object when the cascade rolls back (the workspace still exists)", async () => {
    const { c, order } = client({ failOn: "DELETE FROM workspaces" });
    const deleteWorkspaceObjects = vi.fn(async () => undefined);
    await expect(executeWorkspaceHardDelete(c as never, WS, { exportComplianceRecords: async () => undefined, deleteWorkspaceObjects })).rejects.toThrow("db down");
    expect(deleteWorkspaceObjects).not.toHaveBeenCalled();
    expect(order).toContain("ROLLBACK");
  });

  it("deletes no object when the compliance export fails (nothing was erased)", async () => {
    const { c } = client();
    const deleteWorkspaceObjects = vi.fn(async () => undefined);
    await expect(executeWorkspaceHardDelete(c as never, WS, { exportComplianceRecords: async () => Promise.reject(new Error("export failed")), deleteWorkspaceObjects })).rejects.toThrow("export failed");
    expect(deleteWorkspaceObjects).not.toHaveBeenCalled();
  });

  it("an object-deletion failure after the commit is a distinct, named error: the workspace IS erased, the objects are not", async () => {
    const { c } = client();
    const error = await executeWorkspaceHardDelete(c as never, WS, {
      exportComplianceRecords: async () => undefined,
      deleteWorkspaceObjects: async () => Promise.reject(new Error("s3 down")),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "WorkspaceObjectsLeftBehindError" });
  });

  it("without the hook the erasure behaves exactly as before", async () => {
    const { c, order } = client();
    await executeWorkspaceHardDelete(c as never, WS, { exportComplianceRecords: async () => undefined });
    expect(order).toContain("COMMIT");
  });
});

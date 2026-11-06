import { describe, expect, it, vi } from "vitest";
import { StorageKeyError } from "./storage-keys.js";
import type { PrefixDeletingPort } from "./storage.port.js";
import { deleteWorkspaceObjectsEverywhere } from "./workspace-purge.js";

// STORY-182 - the purge-side wrapper. It takes the purged workspace id explicitly and can only form that workspace's prefixes.

const WS = "0190aaaa-0000-7000-8000-00000000000a";

function port(failOn?: string): PrefixDeletingPort & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  return {
    calls,
    deletePrefix: vi.fn(async (bucket: string, prefix: string) => {
      calls.push([bucket, prefix]);
      if (failOn !== undefined && prefix.startsWith(failOn)) throw new Error("s3 down");
      return 1;
    }),
  } as never;
}

describe("STORY-182 · deleteWorkspaceObjectsEverywhere", () => {
  it("[STORY-182 AC2] deletes the reports, raw and crawl prefixes of exactly the named workspace", async () => {
    const p = port();
    const removed = await deleteWorkspaceObjectsEverywhere(p, "prod", WS);
    expect(p.calls).toEqual([
      ["reports", `prod/${WS}/`],
      ["raw", `prod/${WS}/`],
      ["raw", `crawl/prod/${WS}/`],
    ]);
    expect(removed).toBe(3);
  });

  it("[STORY-182 AC2] a malformed workspace id or environment forms no prefix and deletes nothing", async () => {
    for (const [env, ws] of [["prod", "*"], ["prod", ""], ["prod", WS.concat("/../x")], ["../", WS], ["crawl", WS]] as const) {
      const p = port();
      await expect(deleteWorkspaceObjectsEverywhere(p, env, ws)).rejects.toBeInstanceOf(StorageKeyError);
      expect(p.calls).toEqual([]);
    }
  });

  it("[STORY-182 AC3] a failure on one prefix does not stop the others, and is then raised (a re-run finishes the job)", async () => {
    const p = port("prod/");
    await expect(deleteWorkspaceObjectsEverywhere(p, "prod", WS)).rejects.toThrow("s3 down");
    expect(p.calls.map(([, prefix]) => prefix)).toEqual([`prod/${WS}/`, `prod/${WS}/`, `crawl/prod/${WS}/`]);
  });

  it("[STORY-182 AC3] with nothing left to delete the wrapper reports zero and succeeds", async () => {
    const p = { deletePrefix: async () => 0 } as never;
    await expect(deleteWorkspaceObjectsEverywhere(p, "prod", WS)).resolves.toBe(0);
  });
});

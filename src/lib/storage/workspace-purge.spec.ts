import { describe, expect, it, vi } from "vitest";
import { StorageKeyError } from "./storage-keys.js";
import type { PrefixDeletingPort } from "./storage.port.js";
import { deleteProjectRawObjects, deleteWorkspaceObjectsEverywhere } from "./workspace-purge.js";

// STORY-182 - the purge-side wrapper. It takes the purged workspace id explicitly and can only form that workspace's prefixes.

const WS = "0190aaaa-0000-7000-8000-00000000000a";

function port(failOn?: string): PrefixDeletingPort & { calls: [string, string][] } {
  const calls: [string, string][] = [];
  return {
    calls,
    deleteKeys: vi.fn(async (bucket: string, keys: readonly string[]) => {
      for (const k of keys) calls.push([bucket, k]);
      return keys.length;
    }),
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
      ["raw", `prod/${WS}/crawl/`],
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
    expect(p.calls.map(([, prefix]) => prefix)).toEqual([`prod/${WS}/`, `prod/${WS}/`, `prod/${WS}/crawl/`]);
  });

  it("[STORY-182 AC3] with nothing left to delete the wrapper reports zero and succeeds", async () => {
    const p = { deletePrefix: async () => 0 } as never;
    await expect(deleteWorkspaceObjectsEverywhere(p, "prod", WS)).resolves.toBe(0);
  });
});

describe("STORY-182 (decision 69(b)) · deleteProjectRawObjects", () => {
  const OTHER = "0190aaaa-0000-7000-8000-00000000000b";

  it("deletes exactly the named keys in the raw bucket, once each", async () => {
    const p = port();
    const keys = [`prod/${WS}/2026/10/a.json.gz`, `prod/${WS}/2026/11/b.json.gz`];
    await expect(deleteProjectRawObjects(p, "prod", WS, [...keys, keys[0]!])).resolves.toBe(2);
    expect(p.calls).toEqual(keys.map((k) => ["raw", k]));
  });

  it("no keys: no storage call", async () => {
    const p = port();
    await expect(deleteProjectRawObjects(p, "prod", WS, [])).resolves.toBe(0);
    expect(p.calls).toEqual([]);
  });

  it("a key outside the workspace's own raw prefix is never deleted (another workspace, another environment, a traversal), the valid keys are, and the call then fails", async () => {
    const p = port();
    const good = `prod/${WS}/2026/10/a.json.gz`;
    const bad = [`prod/${OTHER}/2026/10/x.json.gz`, `staging/${WS}/2026/10/x.json.gz`, `prod/${WS}/../${OTHER}/x.json.gz`, `crawl/prod/${WS}/x`, `prod/${WS}/crawl/x`];
    await expect(deleteProjectRawObjects(p, "prod", WS, [bad[0]!, good, ...bad.slice(1)])).rejects.toThrow();
    expect(p.calls).toEqual([["raw", good]]);
  });

  it("a malformed workspace id forms nothing and deletes nothing", async () => {
    const p = port();
    await expect(deleteProjectRawObjects(p, "prod", "*", [`prod/*/x`])).rejects.toBeInstanceOf(StorageKeyError);
    expect(p.calls).toEqual([]);
  });
});

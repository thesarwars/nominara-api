import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DegradedError } from "../../api/errors/domain-errors.js";
import { S3Adapter } from "./s3.adapter.js";
import { resolveStorageConfig } from "./storage-config.js";
import { deleteWorkspaceReports } from "./workspace-purge.js";
import type { PrefixDeletingPort } from "./storage.port.js";

// STORY-180 r5 (owner decision 60 (b)) - workspace erasure deletes {env}/{ws}/ in the reports bucket, EVERY version and delete marker.

afterEach(() => vi.restoreAllMocks());

const WS = "0190aaaa-0000-7000-8000-00000000000a";

function adapter(): S3Adapter {
  const config = resolveStorageConfig({ NODE_ENV: "test", STORAGE_BUCKET_RAW: "raw-b", STORAGE_BUCKET_REPORTS: "reports-b", STORAGE_SSE: "AES256" } as never);
  if (config === null) throw new Error("config null");
  return new S3Adapter(config);
}

type Sent = { name: string; input: Record<string, unknown> };

function fakeS3(pages: Array<{ versions?: number; markers?: number; truncated?: boolean }>, opts: { deleteErrors?: boolean } = {}) {
  const sent: Sent[] = [];
  let page = 0;
  vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
    if (command instanceof ListObjectVersionsCommand) {
      sent.push({ name: "list", input: command.input as unknown as Record<string, unknown> });
      const p = pages[page++] ?? {};
      return {
        Versions: Array.from({ length: p.versions ?? 0 }, (_, i) => ({ Key: `k${String(page)}-${String(i)}`, VersionId: `v${String(i)}` })),
        DeleteMarkers: Array.from({ length: p.markers ?? 0 }, (_, i) => ({ Key: `m${String(page)}-${String(i)}`, VersionId: `d${String(i)}` })),
        IsTruncated: p.truncated === true,
        NextKeyMarker: "nk",
        NextVersionIdMarker: "nv",
      };
    }
    if (command instanceof DeleteObjectsCommand) {
      sent.push({ name: "delete", input: command.input as unknown as Record<string, unknown> });
      return opts.deleteErrors ? { Errors: [{ Key: "k", Code: "AccessDenied" }] } : {};
    }
    return {};
  }) as never);
  return sent;
}

describe("S3Adapter.deletePrefix", () => {
  it("lists VERSIONS and delete markers under the prefix and deletes each by key and version id", async () => {
    const sent = fakeS3([{ versions: 2, markers: 1 }]);
    const n = await adapter().deletePrefix("reports", `inttest/${WS}/`);
    expect(n).toBe(3);
    expect(sent[0]).toMatchObject({ name: "list", input: { Bucket: "reports-b", Prefix: `inttest/${WS}/` } });
    const del = sent.find((s) => s.name === "delete")!.input as { Bucket: string; Delete: { Objects: Array<{ Key: string; VersionId: string }> } };
    expect(del.Bucket).toBe("reports-b");
    expect(del.Delete.Objects).toHaveLength(3);
    expect(del.Delete.Objects.every((o) => o.VersionId !== undefined)).toBe(true);
  });

  it("follows pagination until the listing is no longer truncated, passing both markers", async () => {
    const sent = fakeS3([{ versions: 1, truncated: true }, { versions: 1 }]);
    expect(await adapter().deletePrefix("reports", `inttest/${WS}/`)).toBe(2);
    const lists = sent.filter((s) => s.name === "list");
    expect(lists).toHaveLength(2);
    expect(lists[1]!.input).toMatchObject({ KeyMarker: "nk", VersionIdMarker: "nv" });
  });

  it("deletes in batches of at most 1000", async () => {
    const sent = fakeS3([{ versions: 1000, markers: 5 }]);
    await adapter().deletePrefix("reports", `inttest/${WS}/`);
    const sizes = sent.filter((s) => s.name === "delete").map((s) => (s.input as { Delete: { Objects: unknown[] } }).Delete.Objects.length);
    expect(sizes).toEqual([1000, 5]);
  });

  it("an empty prefix lists once and deletes nothing", async () => {
    const sent = fakeS3([{}]);
    expect(await adapter().deletePrefix("reports", `inttest/${WS}/`)).toBe(0);
    expect(sent.filter((s) => s.name === "delete")).toHaveLength(0);
  });

  it("a per-object delete error fails the call (503), so a purge is never reported complete over objects that remain", async () => {
    fakeS3([{ versions: 1 }], { deleteErrors: true });
    await expect(adapter().deletePrefix("reports", `inttest/${WS}/`)).rejects.toBeInstanceOf(DegradedError);
  });

  it.each(["", "inttest", "/", "inttest/ws"])("refuses the prefix %j: only a non-empty prefix that ends in / can be deleted (never a whole bucket)", async (prefix) => {
    const sent = fakeS3([{ versions: 1 }]);
    await expect(adapter().deletePrefix("reports", prefix)).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("deleteWorkspaceReports (the purge-side wrapper)", () => {
  const port = () => ({ deletePrefix: vi.fn(async () => 4) }) satisfies PrefixDeletingPort;

  it("deletes exactly the workspace's reports prefix {env}/{workspace}/ in the reports bucket, and nothing else", async () => {
    const p = port();
    await expect(deleteWorkspaceReports(p, "inttest", WS)).resolves.toBe(4);
    expect(p.deletePrefix).toHaveBeenCalledTimes(1);
    expect(p.deletePrefix).toHaveBeenCalledWith("reports", `inttest/${WS}/`);
  });

  it.each(["", "not-a-uuid", WS + "/../x", WS.toUpperCase(), "*"])("refuses the workspace id %j before any storage call", async (id) => {
    const p = port();
    await expect(deleteWorkspaceReports(p, "inttest", id)).rejects.toThrow();
    expect(p.deletePrefix).not.toHaveBeenCalled();
  });

  it("refuses a malformed environment segment (the prefix could otherwise widen)", async () => {
    const p = port();
    await expect(deleteWorkspaceReports(p, "", WS)).rejects.toThrow();
    await expect(deleteWorkspaceReports(p, "a/b", WS)).rejects.toThrow();
    expect(p.deletePrefix).not.toHaveBeenCalled();
  });
});

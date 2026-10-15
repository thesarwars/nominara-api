import { describe, expect, it } from "vitest";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { resolveStorageConfig } from "./storage-config.js";
import { buildObjectLocation, relativeKeyFromStored, StorageKeyError, StorageTenancyError } from "./storage-keys.js";
import { MAX_PRESIGN_SECONDS, TenantObjectStore } from "./tenant-object-store.js";
import type { ObjectHead, ObjectStoragePort, PutObjectRequest, StorageBucketName } from "./storage.port.js";

const WS_A = "0197a000-0000-7000-8000-00000000000a";
const WS_B = "0197a000-0000-7000-8000-00000000000b";

// A recording fake of the LOW-LEVEL port. It lets these tests see exactly which bucket and key the tenant layer hands to
// the adapter, which is the whole of the tenancy guarantee on this side of the network.
class FakePort implements ObjectStoragePort {
  readonly objects = new Map<string, Buffer>();
  readonly presigned: { bucket: StorageBucketName; key: string; expiresInSeconds: number }[] = [];
  async put(req: PutObjectRequest): Promise<void> {
    this.objects.set(`${req.bucket}/${req.key}`, Buffer.from(req.body));
  }
  async get(bucket: StorageBucketName, key: string): Promise<Buffer> {
    const found = this.objects.get(`${bucket}/${key}`);
    if (found === undefined) throw new NotFoundError({ message: "no such object" });
    return found;
  }
  async head(bucket: StorageBucketName, key: string): Promise<ObjectHead> {
    const found = this.objects.get(`${bucket}/${key}`);
    if (found === undefined) throw new NotFoundError({ message: "no such object" });
    return { contentLength: found.length, contentType: null, etag: "x", serverSideEncryption: null };
  }
  async delete(bucket: StorageBucketName, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }
  async presignGet(bucket: StorageBucketName, key: string, expiresInSeconds: number): Promise<string> {
    this.presigned.push({ bucket, key, expiresInSeconds });
    return `https://storage.invalid/${bucket}/${key}?X-Amz-Expires=${String(expiresInSeconds)}`;
  }
}

const inWorkspace = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> =>
  withTenantContext({ query: async () => ({ rows: [] }) } as never, { workspaceId, actorId: WS_A }, fn);

describe("object storage · key building", () => {
  it("OS-K1 · a raw key is {env}/{workspace}/{relative}, in the raw bucket (system-architecture.md section 7 step c)", () => {
    expect(buildObjectLocation("production", WS_A, "raw", "2026/10/abc.json.gz")).toEqual({
      bucket: "raw",
      key: `production/${WS_A}/2026/10/abc.json.gz`,
    });
  });

  it("OS-K2 · a crawl key sits under crawl/ in the raw bucket, and a report key in the reports bucket", () => {
    expect(buildObjectLocation("staging", WS_A, "crawl", "audit1/dom.gz")).toEqual({ bucket: "raw", key: `crawl/staging/${WS_A}/audit1/dom.gz` });
    expect(buildObjectLocation("staging", WS_A, "reports", "r1.pdf")).toEqual({ bucket: "reports", key: `staging/${WS_A}/r1.pdf` });
  });

  it.each([
    ["an empty key", ""],
    ["a leading slash", "/a"],
    ["a trailing slash", "a/"],
    ["an empty segment", "a//b"],
    ["a dot segment", "a/./b"],
    ["a parent segment", "../other/x"],
    ["a parent segment in the middle", "a/../../x"],
    ["a backslash", "a\\b"],
    ["a NUL byte", "a\u0000b"],
    ["a space", "a b"],
    ["a percent escape", "a%2e%2e/b"],
    ["a non-ASCII character", "café"],
    ["a key over 512 characters", "a".repeat(513)],
  ])("OS-K3 · refuses %s in the relative part", (_label, relative) => {
    expect(() => buildObjectLocation("production", WS_A, "raw", relative)).toThrow(StorageKeyError);
  });

  it.each(["not-a-uuid", "", WS_A.toUpperCase(), `${WS_A}/../${WS_B}`])("OS-K4 · refuses workspace id %j", (workspaceId) => {
    expect(() => buildObjectLocation("production", workspaceId, "raw", "a")).toThrow(StorageKeyError);
  });

  it.each(["", "Prod", "a/b", "..", "a".repeat(33)])("OS-K5 · refuses key environment %j", (env) => {
    expect(() => buildObjectLocation(env, WS_A, "raw", "a")).toThrow(StorageKeyError);
  });

  it("OS-K6 · a stored key of this workspace maps back to its relative part", () => {
    const { key } = buildObjectLocation("production", WS_A, "raw", "2026/10/abc.json.gz");
    expect(relativeKeyFromStored("production", WS_A, "raw", key)).toBe("2026/10/abc.json.gz");
  });

  it.each([
    ["another workspace", `production/${WS_B}/x`],
    ["another environment", `staging/${WS_A}/x`],
    ["the crawl prefix read as raw", `crawl/production/${WS_A}/x`],
    ["a bare prefix with no object part", `production/${WS_A}/`],
    ["a sibling workspace id that only shares a prefix", `production/${WS_A}0/x`],
    ["a traversal out of the prefix", `production/${WS_A}/../${WS_B}/x`],
  ])("OS-K7 · a stored key naming %s is refused, never mapped", (_label, stored) => {
    expect(() => relativeKeyFromStored("production", WS_A, "raw", stored)).toThrow(StorageTenancyError);
  });
});

describe("object storage · config", () => {
  const base = { STORAGE_BUCKET_RAW: "nominara-raw", STORAGE_BUCKET_REPORTS: "nominara-reports" };

  it("OS-C1 · no storage variable at all means storage is not configured (null), not a default endpoint", () => {
    expect(resolveStorageConfig({ NODE_ENV: "development" })).toBeNull();
  });

  it("OS-C2 · defaults: us-east-1, SSE-KMS (the spec), virtual-hosted style, key environment from NODE_ENV", () => {
    const config = resolveStorageConfig({ NODE_ENV: "production", ...base });
    expect(config).toMatchObject({
      region: "us-east-1",
      forcePathStyle: false,
      sse: "aws:kms",
      keyEnv: "production",
      buckets: { raw: "nominara-raw", reports: "nominara-reports" },
    });
    expect(config?.endpoint).toBeUndefined();
    expect(config?.credentials).toBeUndefined();
  });

  it("OS-C3 · the LocalStack shape: endpoint, path style, static credentials, SSE-S3 and an explicit key environment", () => {
    const config = resolveStorageConfig({
      NODE_ENV: "development",
      ...base,
      STORAGE_ENDPOINT: "http://localhost:4566",
      STORAGE_FORCE_PATH_STYLE: "true",
      STORAGE_ACCESS_KEY_ID: "test",
      STORAGE_SECRET_ACCESS_KEY: "test",
      STORAGE_SSE: "AES256",
      STORAGE_KEY_ENV: "dev",
    });
    expect(config).toMatchObject({ endpoint: "http://localhost:4566", forcePathStyle: true, sse: "AES256", keyEnv: "dev" });
    expect(config?.credentials).toEqual({ accessKeyId: "test", secretAccessKey: "test" });
  });

  it("OS-C4 · the credentials never appear when the config is stringified or logged", () => {
    const config = resolveStorageConfig({ NODE_ENV: "development", ...base, STORAGE_ACCESS_KEY_ID: "AKIAEXAMPLE", STORAGE_SECRET_ACCESS_KEY: "s3cr3t-value" });
    expect(JSON.stringify(config)).not.toMatch(/AKIAEXAMPLE|s3cr3t-value/);
    expect(String(config)).not.toMatch(/AKIAEXAMPLE|s3cr3t-value/);
  });
});

describe("object storage · the tenant layer", () => {
  const store = (port: FakePort): TenantObjectStore => new TenantObjectStore(port, "production");

  it("OS-T1 · without a tenant context nothing is read or written, and the port is never reached", async () => {
    const port = new FakePort();
    await expect(store(port).put("raw", "a", Buffer.from("x"))).rejects.toThrow(StorageTenancyError);
    await expect(store(port).get("raw", "a")).rejects.toThrow(StorageTenancyError);
    await expect(store(port).presignGet("raw", "a", { expiresInSeconds: 60 })).rejects.toThrow(StorageTenancyError);
    expect(port.objects.size).toBe(0);
    expect(port.presigned).toHaveLength(0);
  });

  it("OS-T2 · the workspace prefix comes from the tenant context: the same relative key lands under each workspace's own prefix", async () => {
    const port = new FakePort();
    await inWorkspace(WS_A, () => store(port).put("raw", "k.gz", Buffer.from("a")));
    await inWorkspace(WS_B, () => store(port).put("raw", "k.gz", Buffer.from("b")));
    expect([...port.objects.keys()].sort()).toEqual([`raw/production/${WS_A}/k.gz`, `raw/production/${WS_B}/k.gz`].sort());
  });

  it("OS-T3 · workspace B cannot read, head, delete or presign workspace A's object through the port, by relative key or by stored key", async () => {
    const port = new FakePort();
    const stored = await inWorkspace(WS_A, async () => store(port).put("raw", "secret.gz", Buffer.from("A-only")));
    expect(stored).toBe(`production/${WS_A}/secret.gz`);

    await inWorkspace(WS_B, async () => {
      // The same relative key resolves into B's own prefix, where nothing exists.
      await expect(store(port).get("raw", "secret.gz")).rejects.toThrow(NotFoundError);
      await expect(store(port).head("raw", "secret.gz")).rejects.toThrow(NotFoundError);
      // A's full stored key is refused outright rather than resolved.
      await expect(store(port).getStored("raw", stored)).rejects.toThrow(StorageTenancyError);
      await expect(store(port).headStored("raw", stored)).rejects.toThrow(StorageTenancyError);
      await expect(store(port).deleteStored("raw", stored)).rejects.toThrow(StorageTenancyError);
      await expect(store(port).presignGetStored("raw", stored, { expiresInSeconds: 60 })).rejects.toThrow(StorageTenancyError);
      // A traversal cannot reach A's prefix from B's.
      await expect(store(port).get("raw", `../${WS_A}/secret.gz`)).rejects.toThrow(StorageKeyError);
    });
    expect(port.objects.get(`raw/production/${WS_A}/secret.gz`)?.toString()).toBe("A-only");
    expect(port.presigned.every((p) => p.key.includes(WS_B))).toBe(true);
  });

  it("OS-T4 · a presign is for the context workspace's own prefix, with the lifetime given", async () => {
    const port = new FakePort();
    await inWorkspace(WS_A, () => store(port).presignGet("reports", "r.pdf", { expiresInSeconds: 60 }));
    expect(port.presigned).toEqual([{ bucket: "reports", key: `production/${WS_A}/r.pdf`, expiresInSeconds: 60 }]);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["one past the 7-day SigV4 ceiling", MAX_PRESIGN_SECONDS + 1],
  ])("OS-T5 · refuses a presign lifetime that is %s", async (_label, expiresInSeconds) => {
    const port = new FakePort();
    await expect(inWorkspace(WS_A, () => store(port).presignGet("raw", "a", { expiresInSeconds }))).rejects.toThrow(StorageKeyError);
    expect(port.presigned).toHaveLength(0);
  });

  it("OS-T6 · the boundary lifetimes 1 second and 7 days are accepted", async () => {
    const port = new FakePort();
    await inWorkspace(WS_A, () => store(port).presignGet("raw", "a", { expiresInSeconds: 1 }));
    await inWorkspace(WS_A, () => store(port).presignGet("raw", "a", { expiresInSeconds: MAX_PRESIGN_SECONDS }));
    expect(port.presigned.map((p) => p.expiresInSeconds)).toEqual([1, 604_800]);
  });

  it("OS-T7 · a presign with no stated lifetime uses the 5 minute default", async () => {
    const port = new FakePort();
    await inWorkspace(WS_A, () => store(port).presignGet("raw", "a"));
    expect(port.presigned[0]?.expiresInSeconds).toBe(300);
  });
});

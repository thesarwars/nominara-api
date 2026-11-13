import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DegradedError, NotFoundError, type DomainError } from "../../src/api/errors/domain-errors.js";
import { S3Adapter } from "../../src/lib/storage/s3.adapter.js";
import { resolveStorageConfig, type StorageConfig } from "../../src/lib/storage/storage-config.js";
import { StorageKeyError, StorageTenancyError } from "../../src/lib/storage/storage-keys.js";
import { TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";

// Group C item 3 - the S3 adapter and the tenant layer against a REAL S3 API (LocalStack, S3 only, signature
// validation on). Run under the shared docker lock.

const WS_A = "0197a000-0000-7000-8000-00000000000a";
const WS_B = "0197a000-0000-7000-8000-00000000000b";

let localstack: LocalstackFixture;
let config: StorageConfig;
let store: TenantObjectStore;
let rawS3: S3Client;

const fakeClient = { query: async () => ({ rows: [] }) } as never;
const as = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> =>
  withTenantContext(fakeClient, { workspaceId, actorId: WS_A }, fn);

function configFor(overrides: Record<string, string> = {}): StorageConfig {
  const resolved = resolveStorageConfig({
    NODE_ENV: "test",
    STORAGE_ENDPOINT: localstack.endpoint,
    STORAGE_BUCKET_RAW: "nominara-raw",
    STORAGE_BUCKET_REPORTS: "nominara-reports",
    STORAGE_ACCESS_KEY_ID: "test",
    STORAGE_SECRET_ACCESS_KEY: "test",
    STORAGE_FORCE_PATH_STYLE: "true",
    STORAGE_SSE: "AES256",
    STORAGE_KEY_ENV: "inttest",
    ...overrides,
  } as never);
  if (resolved === null) throw new Error("storage config unexpectedly null");
  return resolved;
}

beforeAll(async () => {
  localstack = await startLocalstack();
  config = configFor();
  store = new TenantObjectStore(new S3Adapter(config), config.keyEnv);
  rawS3 = new S3Client({
    region: "us-east-1",
    endpoint: localstack.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}, 240_000);

afterAll(async () => {
  rawS3?.destroy();
  await localstack?.stop();
});

describe("object storage against LocalStack", () => {
  it("OS-I1 · put then get returns the same bytes, and put returns the full workspace-prefixed key", async () => {
    const body = Buffer.from([0, 1, 2, 250, 251, 252, 255]);
    const key = await as(WS_A, () => store.put("raw", "2026/10/round-trip.bin", body, { contentType: "application/octet-stream" }));
    expect(key).toBe(`inttest/${WS_A}/2026/10/round-trip.bin`);
    const back = await as(WS_A, () => store.get("raw", "2026/10/round-trip.bin"));
    expect(Buffer.compare(back, body)).toBe(0);
  });

  it("OS-I2 · head reports size, content type and the encryption the store applied (SSE-S3 here)", async () => {
    await as(WS_A, () => store.put("raw", "head.json", '{"a":1}', { contentType: "application/json" }));
    const head = await as(WS_A, () => store.head("raw", "head.json"));
    expect(head).toMatchObject({ contentLength: 7, contentType: "application/json", serverSideEncryption: "AES256" });
    expect(head.etag).toEqual(expect.any(String));
  });

  it("OS-I4 · the reports namespace and the crawl namespace use the right bucket and prefix", async () => {
    await as(WS_A, () => store.put("reports", "r1.pdf", "pdf"));
    await as(WS_A, () => store.put("crawl", "audit1/dom.gz", "dom"));
    const reports = await rawS3.send(new ListObjectsV2Command({ Bucket: "nominara-reports", Prefix: `inttest/${WS_A}/r1` }));
    expect(reports.Contents?.map((o) => o.Key)).toEqual([`inttest/${WS_A}/r1.pdf`]);
    const crawl = await rawS3.send(new ListObjectsV2Command({ Bucket: "nominara-raw", Prefix: `inttest/${WS_A}/crawl/` }));
    expect(crawl.Contents?.map((o) => o.Key)).toEqual([`inttest/${WS_A}/crawl/audit1/dom.gz`]);
  });

  it("OS-I5 · delete removes the object, and deleting an absent object is not an error", async () => {
    await as(WS_A, () => store.put("raw", "gone.txt", "bye"));
    await as(WS_A, () => store.delete("raw", "gone.txt"));
    await expect(as(WS_A, () => store.get("raw", "gone.txt"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(as(WS_A, () => store.delete("raw", "never-existed.txt"))).resolves.toBeUndefined();
  });

  it("OS-I6 · a missing object is a typed 404 NotFoundError from get AND head, not a 503", async () => {
    const reads: Array<() => Promise<unknown>> = [() => store.get("raw", "missing.bin"), () => store.head("raw", "missing.bin")];
    for (const read of reads) {
      const error = await as(WS_A, read).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as DomainError).getStatus()).toBe(404);
    }
  });

  it("OS-I7 · a missing BUCKET or an unreachable endpoint is a 503 degraded with a fixed message that leaks neither bucket, endpoint nor secret", async () => {
    const noBucket = configFor({ STORAGE_BUCKET_RAW: "no-such-bucket" });
    const noBucketStore = new TenantObjectStore(new S3Adapter(noBucket), noBucket.keyEnv);
    const bucketError = await as(WS_A, () => noBucketStore.get("raw", "x")).catch((e: unknown) => e);
    expect(bucketError).toBeInstanceOf(DegradedError);
    expect((bucketError as DomainError).getStatus()).toBe(503);
    expect(JSON.stringify((bucketError as DomainError).getResponse())).not.toContain("no-such-bucket");

    // LocalStack does not authenticate plain requests (only presigned ones), so a refused connection is the failure it can stage.
    const badKeys = configFor({ STORAGE_ENDPOINT: "http://127.0.0.1:1", STORAGE_SECRET_ACCESS_KEY: "wrong-s3cr3t-value" });
    const badStore = new TenantObjectStore(new S3Adapter(badKeys), badKeys.keyEnv);
    const authError = await as(WS_A, () => badStore.put("raw", "x", "y")).catch((e: unknown) => e);
    expect(authError).toBeInstanceOf(DegradedError);
    expect(JSON.stringify((authError as DomainError).getResponse())).not.toContain("wrong-s3cr3t-value");
    expect(JSON.stringify((authError as DomainError).getResponse())).not.toContain("127.0.0.1");
    expect(String((authError as Error).stack)).not.toContain("wrong-s3cr3t-value");
  });

  it("OS-I8 · a presigned GET URL downloads the object without credentials", async () => {
    await as(WS_A, () => store.put("raw", "presigned.txt", "hello presign"));
    const url = await as(WS_A, () => store.presignGet("raw", "presigned.txt", { expiresInSeconds: 60 }));
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello presign");
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("60");
  });

  it("OS-I9 · a presigned URL stops working once its lifetime has passed", async () => {
    await as(WS_A, () => store.put("raw", "short-lived.txt", "brief"));
    const url = await as(WS_A, () => store.presignGet("raw", "short-lived.txt", { expiresInSeconds: 2 }));
    expect((await fetch(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 4_000));
    const expired = await fetch(url);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toMatch(/expired/i);
  }, 20_000);

  it("OS-I10 · the default presign lifetime is 300 seconds", async () => {
    const url = await as(WS_A, () => store.presignGet("raw", "presigned.txt"));
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("300");
  });

  it("OS-I11 · a presigned URL cannot be repointed at another key: the signature covers the path", async () => {
    await as(WS_A, () => store.put("raw", "a-only.txt", "A secret"));
    await as(WS_B, () => store.put("raw", "b-only.txt", "B secret"));
    const url = new URL(await as(WS_A, () => store.presignGet("raw", "a-only.txt", { expiresInSeconds: 60 })));
    url.pathname = url.pathname.replace(`/${WS_A}/a-only.txt`, `/${WS_B}/b-only.txt`);
    expect((await fetch(url)).status).toBe(403);
  });

  it("OS-I12 · workspace B cannot read, head, delete or presign workspace A's object, and A's data is untouched", async () => {
    const stored = await as(WS_A, () => store.put("raw", "tenant-a.txt", "A data"));

    // Same relative key, B's context: B's own prefix, where nothing exists.
    await expect(as(WS_B, () => store.get("raw", "tenant-a.txt"))).rejects.toBeInstanceOf(NotFoundError);
    // A's FULL key presented by B: refused before any request.
    await expect(as(WS_B, () => store.getStored("raw", stored))).rejects.toBeInstanceOf(StorageTenancyError);
    await expect(as(WS_B, () => store.headStored("raw", stored))).rejects.toBeInstanceOf(StorageTenancyError);
    await expect(as(WS_B, () => store.deleteStored("raw", stored))).rejects.toBeInstanceOf(StorageTenancyError);
    await expect(as(WS_B, () => store.presignGetStored("raw", stored, { expiresInSeconds: 60 }))).rejects.toBeInstanceOf(StorageTenancyError);
    // Traversal out of B's prefix.
    await expect(as(WS_B, () => store.get("raw", `../${WS_A}/tenant-a.txt`))).rejects.toBeInstanceOf(StorageKeyError);
    // No context at all.
    await expect(store.get("raw", "tenant-a.txt")).rejects.toBeInstanceOf(StorageTenancyError);

    expect((await as(WS_A, () => store.getStored("raw", stored))).toString()).toBe("A data");
  });

  it("OS-I13 · every key the store ever wrote lies under {env}/{workspace}/ (crawl objects under {env}/{workspace}/crawl/; nothing at the bucket root)", async () => {
    for (const bucket of ["nominara-raw", "nominara-reports"]) {
      const listed = await rawS3.send(new ListObjectsV2Command({ Bucket: bucket }));
      const keys = (listed.Contents ?? []).map((o) => o.Key ?? "");
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(key, key).toMatch(new RegExp(`^inttest/(${WS_A}|${WS_B})/`));
      }
    }
  });
});

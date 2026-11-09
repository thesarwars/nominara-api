import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DegradedError } from "../../api/errors/domain-errors.js";
import { S3Adapter } from "./s3.adapter.js";
import { resolveStorageConfig } from "./storage-config.js";

// Group C item 3 - what the adapter ASKS S3 to do. LocalStack (S3 only) cannot perform SSE-KMS, so the encryption
// contract of the production default is asserted on the request itself; the integration spec covers SSE-S3 end to end.

afterEach(() => {
  vi.restoreAllMocks();
});

function putInput(env: Record<string, string>): Record<string, unknown> {
  const config = resolveStorageConfig({ NODE_ENV: "production", STORAGE_BUCKET_RAW: "r", STORAGE_BUCKET_REPORTS: "p", ...env } as never);
  if (config === null) throw new Error("config null");
  let captured: Record<string, unknown> | undefined;
  vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
    if (command instanceof PutObjectCommand) captured = command.input as unknown as Record<string, unknown>;
    return {};
  }) as never);
  void new S3Adapter(config).put({ bucket: "raw", key: "k", body: "b" });
  return new Proxy({}, { get: (_t, prop) => captured?.[prop as string] });
}

describe("S3Adapter · every write is encrypted at rest", () => {
  it("OS-A1 · the default is SSE-KMS (system-architecture.md section 10), with the key id when configured", async () => {
    const input = putInput({ STORAGE_KMS_KEY_ID: "arn:aws:kms:us-east-1:111122223333:key/abc" });
    await new Promise((r) => setImmediate(r));
    expect(input.ServerSideEncryption).toBe("aws:kms");
    expect(input.SSEKMSKeyId).toBe("arn:aws:kms:us-east-1:111122223333:key/abc");
    expect(input.BucketKeyEnabled).toBe(true);
    expect(input.Bucket).toBe("r");
  });

  it("OS-A2 · SSE-S3 (local development) sends AES256 and no KMS key id", async () => {
    const input = putInput({ STORAGE_SSE: "AES256" });
    await new Promise((r) => setImmediate(r));
    expect(input.ServerSideEncryption).toBe("AES256");
    expect(input.SSEKMSKeyId).toBeUndefined();
    expect(input.BucketKeyEnabled).toBeUndefined();
  });

  it("OS-A3 · SSE-KMS sends a bucket key, and with no key id sends no SSEKMSKeyId (the adapter never invents a key; production boot refuses this config, see env.spec OS-E7)", async () => {
    const input = putInput({});
    await new Promise((r) => setImmediate(r));
    expect(input.ServerSideEncryption).toBe("aws:kms");
    expect(input.BucketKeyEnabled).toBe(true);
    expect(input.SSEKMSKeyId).toBeUndefined();
  });
});

describe("S3Adapter · a stalled store cannot hold its caller for ever", () => {
  it("OS-A4 · a PUT to an endpoint that accepts the connection and never answers fails as DegradedError within the request timeout", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket); // accept, read, never reply
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const config = resolveStorageConfig({
        NODE_ENV: "test",
        STORAGE_ENDPOINT: `http://127.0.0.1:${String(port)}`,
        STORAGE_BUCKET_RAW: "r",
        STORAGE_BUCKET_REPORTS: "p",
        STORAGE_ACCESS_KEY_ID: "k",
        STORAGE_SECRET_ACCESS_KEY: "s",
        STORAGE_FORCE_PATH_STYLE: "true",
        STORAGE_SSE: "AES256",
      } as never);
      if (config === null) throw new Error("config null");
      const started = Date.now();
      await expect(new S3Adapter(config, 150).put({ bucket: "raw", key: "k", body: "b" })).rejects.toBeInstanceOf(DegradedError);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20_000);
});

// STORY-111 - the purge journal's read side.
describe("S3Adapter.listKeys (STORY-111)", () => {
  it("pages through ListObjectsV2 and returns every key under the prefix", async () => {
    const { ListObjectsV2Command, S3Client } = await import("@aws-sdk/client-s3");
    const { vi } = await import("vitest");
    const seen: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(S3Client.prototype, "send").mockImplementation((async (command: unknown) => {
      if (!(command instanceof ListObjectsV2Command)) return {};
      seen.push(command.input as unknown as Record<string, unknown>);
      return seen.length === 1
        ? { Contents: [{ Key: "purge-journal/t/a.json" }], IsTruncated: true, NextContinuationToken: "tok" }
        : { Contents: [{ Key: "purge-journal/t/b.json" }], IsTruncated: false };
    }) as never);
    const { S3Adapter } = await import("./s3.adapter.js");
    const { resolveStorageConfig } = await import("./storage-config.js");
    const config = resolveStorageConfig({ NODE_ENV: "test", STORAGE_BUCKET_RAW: "raw-b", STORAGE_BUCKET_REPORTS: "reports-b", STORAGE_SSE: "AES256" } as never)!;
    const keys = await new S3Adapter(config).listKeys("raw", "purge-journal/t/");
    expect(keys).toEqual(["purge-journal/t/a.json", "purge-journal/t/b.json"]);
    expect(seen[0]).toMatchObject({ Bucket: "raw-b", Prefix: "purge-journal/t/" });
    expect(seen[1]).toMatchObject({ ContinuationToken: "tok" });
    spy.mockRestore();
    await expect(new S3Adapter(config).listKeys("raw", "")).rejects.toThrow(/non-empty prefix/);
  });
});

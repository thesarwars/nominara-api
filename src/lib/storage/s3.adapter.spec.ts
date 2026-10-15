import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
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

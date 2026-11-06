import { ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Adapter } from "../../src/lib/storage/s3.adapter.js";
import { resolveStorageConfig, type StorageConfig } from "../../src/lib/storage/storage-config.js";
import { deleteProjectObjectPrefix, deleteWorkspaceObjectsEverywhere } from "../../src/lib/storage/workspace-purge.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";

// STORY-182 - the purge-side wrapper against LocalStack with versioning ON (docker/localstack/init-buckets.sh). Run under the docker lock.

const WS_A = "0197a000-0000-7000-8000-00000000000a";
const WS_B = "0197a000-0000-7000-8000-00000000000b";
const PROJECT = "0197a000-0000-7000-8000-0000000000c1";

let localstack: LocalstackFixture;
let config: StorageConfig;
let adapter: S3Adapter;
let s3: S3Client;

beforeAll(async () => {
  localstack = await startLocalstack();
  const resolved = resolveStorageConfig({
    NODE_ENV: "test", STORAGE_ENDPOINT: localstack.endpoint, STORAGE_BUCKET_RAW: "nominara-raw", STORAGE_BUCKET_REPORTS: "nominara-reports",
    STORAGE_ACCESS_KEY_ID: "test", STORAGE_SECRET_ACCESS_KEY: "test", STORAGE_FORCE_PATH_STYLE: "true", STORAGE_SSE: "AES256", STORAGE_KEY_ENV: "inttest",
  } as never);
  if (resolved === null) throw new Error("storage config unexpectedly null");
  config = resolved;
  adapter = new S3Adapter(config);
  s3 = new S3Client({ region: "us-east-1", endpoint: localstack.endpoint, forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });
}, 240_000);

afterAll(async () => {
  s3?.destroy();
  await localstack?.stop();
});

async function put(bucket: "raw" | "reports", key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) await adapter.put({ bucket, key, body: `v${String(i)}`, contentType: "text/plain" });
}

/** Every version AND delete marker under a prefix: the recoverable copies. */
async function versions(bucket: string, prefix: string): Promise<string[]> {
  const out = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
  return [...(out.Versions ?? []), ...(out.DeleteMarkers ?? [])].map((v) => `${v.Key ?? ""}@${v.VersionId ?? ""}`);
}

describe("STORY-182 · purge deletes object prefixes in a versioned bucket", () => {
  it("[STORY-182 AC4] after the purge no version of any object under the workspace's three prefixes remains, and another workspace is untouched", async () => {
    await put("raw", `inttest/${WS_A}/2026/10/a.json.gz`, 3);
    await put("raw", `crawl/inttest/${WS_A}/audit1/dom.gz`, 2);
    await put("reports", `inttest/${WS_A}/r1.pdf`, 2);
    await put("raw", `inttest/${WS_B}/2026/10/b.json.gz`, 2);
    await put("raw", `crawl/inttest/${WS_B}/audit1/dom.gz`);
    await put("reports", `inttest/${WS_B}/r2.pdf`);
    // A delete marker (a plain delete on a versioned bucket) is a recoverable copy too.
    await adapter.delete("raw", `inttest/${WS_A}/2026/10/a.json.gz`);

    const removed = await deleteWorkspaceObjectsEverywhere(adapter, "inttest", WS_A);
    expect(removed).toBeGreaterThanOrEqual(8);

    expect(await versions("nominara-raw", `inttest/${WS_A}/`)).toEqual([]);
    expect(await versions("nominara-raw", `crawl/inttest/${WS_A}/`)).toEqual([]);
    expect(await versions("nominara-reports", `inttest/${WS_A}/`)).toEqual([]);
    expect(await versions("nominara-raw", `inttest/${WS_B}/`)).toHaveLength(2);
    expect(await versions("nominara-raw", `crawl/inttest/${WS_B}/`)).toHaveLength(1);
    expect(await versions("nominara-reports", `inttest/${WS_B}/`)).toHaveLength(1);
  });

  it("[STORY-182 AC3] a re-run after the job is done finishes cleanly and removes nothing", async () => {
    await expect(deleteWorkspaceObjectsEverywhere(adapter, "inttest", WS_A)).resolves.toBe(0);
  });

  it("[STORY-182 AC3] the project-prefix callback deletes every version under that project only", async () => {
    await put("raw", `inttest/${WS_A}/projects/${PROJECT}/x.gz`, 2);
    await put("raw", `inttest/${WS_A}/projects/${PROJECT}0/sibling.gz`);
    await deleteProjectObjectPrefix(adapter, "inttest", `inttest/${WS_A}/projects/${PROJECT}/`);
    expect(await versions("nominara-raw", `inttest/${WS_A}/projects/${PROJECT}/`)).toEqual([]);
    expect(await versions("nominara-raw", `inttest/${WS_A}/projects/${PROJECT}0/`)).toHaveLength(1);
  });
});

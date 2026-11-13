import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Adapter } from "../../src/lib/storage/s3.adapter.js";
import { resolveStorageConfig } from "../../src/lib/storage/storage-config.js";
import { StorageTenancyError } from "../../src/lib/storage/storage-keys.js";
import { BoundObjectStore, TenantObjectStore } from "../../src/lib/storage/tenant-object-store.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { startLocalstack, type LocalstackFixture } from "../support/localstack-fixture.js";
import { getAssertionContext } from "./support/context.js";
import { classifyObjectKeys, type ObjectKeyRef } from "./support/live-keys.js";
import { connectAsRole } from "./support/runtime-roles.js";
import { isRunnableForCurrentTarget } from "./support/target-guard.js";

// STORY-012 AC8 / ISO-14, the live half: what a REAL object store (LocalStack, S3 only, the compose file's own image and bucket init) holds after three tenants
// write through TenantObjectStore, the only door feature code has. The source scanner (iso-14) reads how keys are BUILT; this reads what LANDED.
//
// What it cannot do: the specification's second clause, "an IAM policy evaluation confirms a task role restricted by prefix cannot read another prefix", needs the
// infrastructure repository's roles (STORY-003). The tenant layer's own refusal of a key outside the workspace's prefix is asserted here instead.
const ENV = "isotest";

describe.skipIf(!isRunnableForCurrentTarget("ISO-14"))("STORY-012 AC8 · ISO-14 live: object keys land under {env}/{workspace}/ and cannot be reached across tenants", () => {
  const { fixture } = getAssertionContext();
  const tenants = [fixture.a, fixture.b, fixture.c];
  let localstack: LocalstackFixture;
  let adapter: S3Adapter;
  let s3: S3Client;
  let store: TenantObjectStore;
  const bound = new Map<string, BoundObjectStore>();
  const written = new Map<string, string[]>(); // workspace -> full keys returned by put()

  async function listAll(bucket: string): Promise<ObjectKeyRef[]> {
    const out: ObjectKeyRef[] = [];
    let token: string | undefined;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ...(token === undefined ? {} : { ContinuationToken: token }) }));
      for (const object of page.Contents ?? []) out.push({ bucket: bucket === "nominara-reports" ? "reports" : "raw", key: object.Key! });
      token = page.NextContinuationToken;
    } while (token !== undefined);
    return out;
  }

  const everything = async (): Promise<ObjectKeyRef[]> => [...(await listAll("nominara-raw")), ...(await listAll("nominara-reports"))];
  const judge = (objects: ObjectKeyRef[]) => classifyObjectKeys(objects, { env: ENV, tenantIds: tenants.map((t) => t.workspaceId), reportsBucket: "reports" });

  beforeAll(async () => {
    localstack = await startLocalstack();
    const config = resolveStorageConfig({
      NODE_ENV: "test", STORAGE_ENDPOINT: localstack.endpoint, STORAGE_BUCKET_RAW: "nominara-raw", STORAGE_BUCKET_REPORTS: "nominara-reports",
      STORAGE_ACCESS_KEY_ID: "test", STORAGE_SECRET_ACCESS_KEY: "test", STORAGE_FORCE_PATH_STYLE: "true", STORAGE_SSE: "AES256", STORAGE_KEY_ENV: ENV,
    } as never);
    if (config === null) throw new Error("storage config unexpectedly null");
    adapter = new S3Adapter(config);
    store = new TenantObjectStore(adapter, ENV);
    s3 = new S3Client({ region: "us-east-1", endpoint: localstack.endpoint, forcePathStyle: true, credentials: { accessKeyId: "test", secretAccessKey: "test" } });

    // The workspace comes from the tenant context, exactly as in a request: bind() inside it, write after.
    const app = await connectAsRole(getAssertionContext().target, "nominara_app");
    try {
      for (const tenant of tenants) {
        bound.set(tenant.workspaceId, await withTenantContext(app, { workspaceId: tenant.workspaceId, actorId: SYSTEM_ACTOR_ID }, async () => store.bind()));
      }
    } finally {
      await app.end();
    }
    for (const tenant of tenants) {
      const writer = bound.get(tenant.workspaceId)!;
      const keys = [
        await writer.put("raw", `2026/11/${tenant.label}-capture.json.gz`, `raw-${tenant.label}`),
        await writer.put("raw", `2026/11/${tenant.label}-second.json.gz`, `raw2-${tenant.label}`),
        await writer.put("crawl", `audit-1/${tenant.label}-dom.gz`, `crawl-${tenant.label}`),
        await writer.put("reports", `${tenant.label}-report.pdf`, `report-${tenant.label}`),
      ];
      written.set(tenant.workspaceId, keys);
    }
  }, 300_000);

  afterAll(async () => {
    s3?.destroy();
    await localstack?.stop();
  });

  it("every object three tenants wrote sits under {env}/{workspace}/ (crawl objects under {env}/{workspace}/crawl/), and each tenant's prefix holds exactly what that tenant wrote", async () => {
    const objects = await everything();
    expect(objects.length, "the store holds what was written").toBe(tenants.length * 4);
    const report = judge(objects);
    expect(report.violations).toEqual([]);
    for (const tenant of tenants) {
      expect(
        (report.byWorkspace.get(tenant.workspaceId) ?? []).map((o) => o.key).sort(),
        `tenant ${tenant.label}'s prefix`,
      ).toEqual([...written.get(tenant.workspaceId)!].sort());
    }
  });

  it("a tenant's bound store refuses another tenant's stored key on every verb, and the other tenant's object is untouched", async () => {
    const a = bound.get(fixture.a.workspaceId)!;
    const foreignKey = written.get(fixture.b.workspaceId)![0]!;
    await expect(a.getStored("raw", foreignKey)).rejects.toBeInstanceOf(StorageTenancyError);
    await expect(a.headStored("raw", foreignKey)).rejects.toBeInstanceOf(StorageTenancyError);
    await expect(a.presignGetStored("raw", foreignKey)).rejects.toBeInstanceOf(StorageTenancyError);
    await expect(a.deleteStored("raw", foreignKey)).rejects.toBeInstanceOf(StorageTenancyError);
    const stillThere = await bound.get(fixture.b.workspaceId)!.getStored("raw", foreignKey);
    expect(stillThere.toString()).toBe(`raw-${fixture.b.label}`);
  });

  it("a relative key cannot walk out of the prefix: traversal and a foreign workspace id as a path segment are refused, and nothing is written", async () => {
    const a = bound.get(fixture.a.workspaceId)!;
    const before = (await everything()).length;
    await expect(a.put("raw", `../${fixture.b.workspaceId}/x.gz`, "x")).rejects.toThrow();
    await expect(a.put("raw", `..`, "x")).rejects.toThrow();
    expect((await everything()).length).toBe(before);
  });

  it("the judge can fail: an object planted outside the namespace (segments reversed, workspace missing) is reported by the same classifier", async () => {
    await adapter.put({ bucket: "raw", key: `${fixture.a.workspaceId}/${ENV}/misplaced.gz`, body: "x" });
    await adapter.put({ bucket: "raw", key: `${ENV}/misplaced-no-workspace.gz`, body: "x" });
    // The OLD crawl layout (owner decision 106(e)) must fail the live judge.
    await adapter.put({ bucket: "raw", key: `crawl/${ENV}/${fixture.a.workspaceId}/audit1/old-layout.gz`, body: "x" });
    const report = judge(await everything());
    expect(report.violations.map((v) => v.reason).sort()).toEqual([
      "no workspace id where the prefix puts one",
      "the key does not open with the deployment namespace",
      "the old crawl layout (crawl/{env}/{workspace}/): crawl objects live under {env}/{workspace}/crawl/",
    ]);
  });
});

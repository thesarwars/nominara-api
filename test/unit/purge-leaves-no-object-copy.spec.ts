import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/env.schema.js";
import { COMPLIANCE_EXPORT_CLASSES } from "../../src/lib/compliance/storage-adapters.js";
import { workspacePrefix } from "../../src/lib/storage/storage-keys.js";
import { deleteProjectRawObjects, deleteWorkspaceObjectsEverywhere } from "../../src/lib/storage/workspace-purge.js";
import { InMemoryObjectStore } from "../support/in-memory-object-store.js";

// STORY-111 AC15 (carried as STORY-205) - "No purge path copies customer content to a second location. Asserted: after a hard delete, a search
// across every bucket ... for the purged workspace's ... returns nothing." The tables half is S17 (test/integration/compliance-retention.spec.ts);
// this is the OBJECT half, through the real purge wrapper the retention job wires (`deleteWorkspaceObjectsEverywhere`), against a store that models
// both buckets and every prefix the workspace's objects are written under: raw (dated keys), crawl (inside the raw bucket's workspace prefix since
// decision 106(e)) and reports. A real bucket with versioning is test/integration/workspace-purge-objects.spec.ts (LocalStack).

const ENV = "prod";
const WS = "0190aaaa-0000-7000-8000-00000000000a";
const OTHER = "0190aaaa-0000-7000-8000-00000000000b";

function seed(store: InMemoryObjectStore, ws: string): void {
  store.put("raw", `${ENV}/${ws}/2026/10/capture-1.json.gz`, 3);
  store.put("raw", `${ENV}/${ws}/2026/11/capture-2.json.gz`);
  store.put("raw", `${ENV}/${ws}/crawl/audit-1/dom.gz`, 2);
  store.put("raw", `${ENV}/${ws}/crawl/audit-1/rendered.gz`);
  store.put("reports", `${ENV}/${ws}/monthly-2026-10.pdf`, 2);
  store.put("reports", `${ENV}/${ws}/monthly-2026-11.pdf`);
}

describe("STORY-111 AC15 - a hard delete leaves no object under any prefix the workspace used", () => {
  it("[STORY-111 AC15] a search of every bucket for the purged workspace returns nothing, after the same purge call the retention job makes", async () => {
    const store = new InMemoryObjectStore();
    seed(store, WS);
    expect(store.search(WS)).toHaveLength(6);

    const removed = await deleteWorkspaceObjectsEverywhere(store, ENV, WS);

    expect(removed).toBe(10);
    expect(store.search(WS)).toEqual([]);
    expect(store.keys("raw")).toEqual([]);
    expect(store.keys("reports")).toEqual([]);
  });

  it("[STORY-111 AC15] listing each of the workspace's three prefixes individually is empty too (raw, crawl, reports)", async () => {
    const store = new InMemoryObjectStore();
    seed(store, WS);
    await deleteWorkspaceObjectsEverywhere(store, ENV, WS);
    for (const [bucket, namespace] of [["raw", "raw"], ["raw", "crawl"], ["reports", "reports"]] as const) {
      const prefix = workspacePrefix(ENV, WS, namespace);
      expect(store.keys(bucket).filter((key) => key.startsWith(prefix)), `${bucket} ${prefix}`).toEqual([]);
    }
  });

  it("[STORY-111 AC15] another workspace's objects, in the same buckets, are untouched", async () => {
    const store = new InMemoryObjectStore();
    seed(store, WS);
    seed(store, OTHER);
    await deleteWorkspaceObjectsEverywhere(store, ENV, WS);
    expect(store.search(WS)).toEqual([]);
    expect(store.search(OTHER)).toHaveLength(6);
  });

  it("[STORY-111 AC15] the assertion can fail: if the stack deleted only the reports prefix (the old stub), the search finds the raw and crawl objects", async () => {
    const store = new InMemoryObjectStore();
    seed(store, WS);
    await store.deletePrefix("reports", workspacePrefix(ENV, WS, "reports"));
    expect(store.search(WS)).toHaveLength(4);
    expect(store.search(WS).every((hit) => hit.startsWith(`raw/${ENV}/${WS}/`))).toBe(true);
  });

  it("[STORY-111 AC15] a purged PROJECT's raw captures are removed by exact key and nothing else under the workspace is", async () => {
    const store = new InMemoryObjectStore();
    seed(store, WS);
    const gone = `${ENV}/${WS}/2026/10/capture-1.json.gz`;
    await deleteProjectRawObjects(store, ENV, WS, [gone]);
    expect(store.keys("raw")).not.toContain(gone);
    expect(store.search(WS)).toHaveLength(5);
  });

  // EVERY BUCKET THE CONFIGURATION CAN NAME, enumerated from the env schema rather than from a list in this file: a bucket added tomorrow has no
  // entry below, so this fails until someone decides whether the purge reaches it. The default for a new bucket is "searched", never "skipped".
  const MODELLED: Readonly<Record<string, string>> = { STORAGE_BUCKET_RAW: "raw", STORAGE_BUCKET_REPORTS: "reports" };
  const DELIBERATE_EXCEPTIONS: Readonly<Record<string, string>> = {
    AUDIT_EXPORT_BUCKET:
      "the nightly audit export (security-and-tenancy.md section 12): S3 Object Lock COMPLIANCE, 7-year retention. Nothing, including the account root, can delete an object in it before then, so a purge cannot and must not try. It holds audit rows (identifiers, actions, hashes), which the compliance-retention rules keep for seven years.",
  };

  it("[STORY-111 AC15] every bucket the environment configuration can name is either searched by this test or a documented, deliberate exception", () => {
    const configured = Object.keys(envSchema.shape).filter((name) => /BUCKET/.test(name) && name !== "ENGINE_TOKEN_BUCKETS");
    expect(configured.sort()).toEqual([...Object.keys(MODELLED), ...Object.keys(DELIBERATE_EXCEPTIONS)].sort());
    for (const reason of Object.values(DELIBERATE_EXCEPTIONS)) expect(reason.length).toBeGreaterThan(40);
    // The store models exactly the buckets marked as modelled, so the search below covers each of them.
    expect(new InMemoryObjectStore().bucketNames().sort()).toEqual(Object.values(MODELLED).sort());
  });

  it("[STORY-111 AC15] the compliance and retention exports are the other deliberate exception: they sit in the raw bucket under a pseudonym, outlive the purge, and are not found by searching for the workspace id", async () => {
    const store = new InMemoryObjectStore();
    seed(store, WS);
    const surviving = `${COMPLIANCE_EXPORT_CLASSES.audit_log}${ENV}/pseudonym-not-the-workspace-id/2026-11-06T00-00-00.000Z-x.json`;
    store.put("raw", surviving);
    await deleteWorkspaceObjectsEverywhere(store, ENV, WS);
    // 7-year compliance exports (storage-adapters.ts, retention class audit-log-7y / financial-7y) are written BEFORE the cascade and kept on purpose.
    expect(store.keys("raw")).toEqual([surviving]);
    expect(store.search(WS)).toEqual([]);
  });
});

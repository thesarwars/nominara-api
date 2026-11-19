import { describe, expect, it } from "vitest";
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
});

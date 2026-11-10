import { describe, expect, it, vi } from "vitest";
import { CATEGORY_CLASSIFICATION_SOURCE } from "../categories/classify.js";
import { discover, type DiscoverDeps } from "./discover.js";

// STORY-195 AC6 — discovery reports each field as it is found, instead of once at the end. `onFields` is called with a SNAPSHOT of the fields
// obtained so far: first the document-derived ones (before the slow category classification), then again once the category is known.

const PAGE = `<!doctype html><html lang="en-US"><head>
  <title>Acme CRM | Sell more</title>
  <meta name="description" content="Pipeline and contact management for sales teams.">
</head><body><h1>Close deals faster</h1></body></html>`;

const BASE = { rootUrl: "https://acme.example", rootDomain: "acme.example", fieldsSupplied: [] as string[] };

function deps(extra: Partial<DiscoverDeps>, html = PAGE): DiscoverDeps {
  return { fetch: vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from(html), finalUrl: "https://acme.example/" })), now: () => Date.now(), ...extra };
}

describe("STORY-195 · discovery reports fields as they are found", () => {
  it("STORY-195-AC6 the document fields are reported BEFORE the category classification finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const snapshots: string[][] = [];
    const classify = vi.fn(async () => {
      // While classification is still pending, the first snapshot must already have been delivered.
      expect(snapshots.length).toBe(1);
      await gate;
      return { slug: "crm", confidence: 0.9, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 1 };
    });
    const onFields = vi.fn(async (fields: Record<string, unknown>) => void snapshots.push(Object.keys(fields)));
    const pending = discover(BASE, deps({ classify, onFields }));
    await vi.waitFor(() => expect(classify).toHaveBeenCalled());
    expect(snapshots[0]).toEqual(expect.arrayContaining(["brand_name", "description", "locale"]));
    expect(snapshots[0]).not.toContain("category");
    release();
    await pending;
    expect(snapshots.at(-1)).toContain("category");
  });

  it("STORY-195-AC6 a snapshot is a copy: later fields never appear in an earlier one", async () => {
    const snapshots: Record<string, unknown>[] = [];
    const classify = vi.fn(async () => ({ slug: "crm", confidence: 0.9, source: CATEGORY_CLASSIFICATION_SOURCE, tokens: 1 }));
    await discover(BASE, deps({ classify, onFields: async (fields) => void snapshots.push(fields) }));
    expect(snapshots).toHaveLength(2);
    expect("category" in snapshots[0]!).toBe(false);
  });

  it("STORY-195-AC6 each reported field carries its confidence and source", async () => {
    const snapshots: Record<string, { confidence: number; source: string; user_edited: boolean }>[] = [];
    await discover(BASE, deps({ onFields: async (fields) => void snapshots.push(fields as never) }));
    const brand = snapshots[0]!.brand_name!;
    expect(typeof brand.confidence).toBe("number");
    expect(brand.source).not.toBe("");
    expect(brand.user_edited).toBe(false);
  });

  it("STORY-195-AC6 a supplied field is never reported (supplied wins)", async () => {
    const snapshots: string[][] = [];
    await discover({ ...BASE, fieldsSupplied: ["name", "description"] }, deps({ onFields: async (f) => void snapshots.push(Object.keys(f)) }));
    for (const keys of snapshots) {
      expect(keys).not.toContain("brand_name");
      expect(keys).not.toContain("description");
    }
  });

  it("STORY-195-AC6 an unreachable site reports nothing mid-pass and the pass still ends partial or failed", async () => {
    const onFields = vi.fn(async () => undefined);
    const result = await discover(BASE, { fetch: vi.fn(async () => { throw new Error("refused"); }), now: () => Date.now(), onFields });
    expect(onFields).not.toHaveBeenCalled();
    expect(["partial", "failed"]).toContain(result.discovery_status);
  });

  it("STORY-195-AC6 a failing reporter never fails the pass: the final payload is unchanged", async () => {
    const baseline = await discover(BASE, deps({}));
    const result = await discover(BASE, deps({ onFields: async () => { throw new Error("db down"); } }));
    expect(result.fields).toEqual(baseline.fields);
    expect(result.discovery_status).toBe(baseline.discovery_status);
  });
});

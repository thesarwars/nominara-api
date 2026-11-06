import { readFileSync } from "node:fs";
import type { Job } from "bullmq";
import { describe, expect, it } from "vitest";
import { CATALOG_ROWS } from "../../../../test/support/aux-rules.js";
import { readSiteFilesCache, siteFilesCacheKey, SITE_FILES_CACHE_TTL_MS, writeSiteFilesCache } from "../../aux/site-files-cache.js";
import { InMemoryCacheAdapter } from "../../cache/in-memory-cache.adapter.js";
import type { GuardedResponse } from "../../net/guarded-fetch.js";
import type { QueueHandlerContext } from "../handlers.js";
import { createAuxAuditToolPhases } from "./aux-audit-tool.handler.js";

// STORY-082 - the worker half, run phase only (no database): the per-host cache and the fetch path. Scenario numbers are the story's table.

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const reply = (status: number, body: string): GuardedResponse => ({ status, headers: {}, body: Buffer.from(body), finalUrl: "https://acme.example/" });
const CATALOG = CATALOG_ROWS.map((r) => ({ code: r.code, category: r.category, title: r.title, weight: r.weight, rule_version: r.ruleVersion, thresholds: r.thresholds, task_threshold: r.taskThreshold, auto_fixable: r.autoFixable, rationale: r.rationale }));

function harness(cache: InMemoryCacheAdapter) {
  const fetched: string[] = [];
  const phases = createAuxAuditToolPhases({ pool: {}, env: {} } as unknown as QueueHandlerContext, {
    cache,
    audit: {
      fetch: async (url) => {
        fetched.push(new URL(url).pathname);
        return new URL(url).pathname === "/robots.txt" ? reply(200, "User-agent: GPTBot\nDisallow: /\n") : reply(404, "");
      },
      sleep: async () => undefined,
    },
  });
  const payload = { tool: "aux_audit" as const, toolRunId: RUN, mode: "site_files" as const, targetUrl: "https://acme.example/", pages: null, credits: 0, startedAt: "2026-11-06T10:00:00.000Z", workspaceId: WORKSPACE };
  return { fetched, run: async () => await phases.run({ payload, verified: false, catalog: CATALOG }, {} as Job) };
}

describe("STORY-082 · the AUX audit worker (site-files mode)", () => {
  it("scenario 2 - a site-files check writes the host's reading to the cache; a second reader finds it", async () => {
    const cache = new InMemoryCacheAdapter();
    const h = harness(cache);
    const out = await h.run();
    expect(out.outcome.kind).toBe("done");
    const hit = await readSiteFilesCache(cache, "test", "acme.example");
    expect(hit?.agents.find((a) => a.agent === "GPTBot")?.access).toBe("blocked");
    expect(hit?.files.map((f) => f.file)).toEqual(["robots.txt", "llms.txt", "sitemap"]);
  });

  it("the cache holds the AI-agent reading and no tenant identifier: one platform-wide key per host, with a bounded lifetime", async () => {
    const key = siteFilesCacheKey("test", "ACME.example");
    expect(key).toBe("test:global:aux-site-files:acme.example");
    expect(key).not.toContain(WORKSPACE);
    expect(SITE_FILES_CACHE_TTL_MS).toBeGreaterThan(0);
  });

  it("a cached value that no longer parses is a miss, not an answer", async () => {
    const cache = new InMemoryCacheAdapter();
    await cache.set(siteFilesCacheKey("test", "acme.example"), JSON.stringify({ summary: "x" }), { ttlMs: 60_000 });
    expect(await readSiteFilesCache(cache, "test", "acme.example")).toBeNull();
    await cache.set(siteFilesCacheKey("test", "acme.example"), "not json", { ttlMs: 60_000 });
    expect(await readSiteFilesCache(cache, "test", "acme.example")).toBeNull();
  });

  it("a written value round-trips", async () => {
    const cache = new InMemoryCacheAdapter();
    const h = harness(cache);
    const out = await h.run();
    if (out.outcome.kind !== "done") throw new Error("expected a result");
    await writeSiteFilesCache(cache, "test", "other.example", out.outcome.result.site_files);
    expect(await readSiteFilesCache(cache, "test", "other.example")).toEqual(out.outcome.result.site_files);
  });

  it("scenario 12 - the worker has no fetch path of its own: the guarded fetcher is the only way out", () => {
    const worker = readFileSync(new URL("./aux-audit-tool.handler.ts", import.meta.url), "utf8");
    const core = readFileSync(new URL("../../tools/aux-audit-run.ts", import.meta.url), "utf8");
    for (const source of [worker, core]) expect(source).not.toMatch(/node:https?|undici|\bfetch\(|axios|got\(/u);
    expect(core).toMatch(/from "\.\.\/net\/guarded-fetch\.js"/u);
  });
});

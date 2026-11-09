import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprintResponseSchema, FINGERPRINT_BUDGET_MS } from "../../../contracts/projects/index.js";
import { UnsafeTargetError } from "../../api/errors/domain-errors.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { IS_PUBLIC_KEY } from "../../api/decorators/public.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { SKIP_TENANT_CONTEXT_KEY } from "../../api/decorators/skip-tenant-context.decorator.js";
import { RATE_LIMIT_CLASS_KEY } from "../../api/rate-limit/route-class.js";
import { GuardedFetchRefusal, type GuardedResponse } from "../../lib/net/guarded-fetch.js";
import type { UrlGuard } from "../../lib/net/url-guard.service.js";
import type { Pool } from "pg";
import { LOW_CONFIDENCE_THRESHOLD } from "../../../contracts/projects/index.js";
import type { TextEmbedder } from "../../lib/categories/classify.js";
import { discover } from "../../lib/discovery/discover.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { ProjectFingerprintController } from "./project-fingerprint.controller.js";
import { ProjectFingerprintService } from "./project-fingerprint.service.js";

// POST /projects/fingerprint: a pre-creation, free, tenant-less read of one page. Hazards: an unsafe URL is refused BEFORE any fetch; a slow or dead
// site is an ANSWER (unavailable, with a reason), never an error and never a hang; nothing is charged; no tenant transaction is open across the fetch.

const ok = (html: string, over: Partial<GuardedResponse> = {}): GuardedResponse =>
  ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(html), finalUrl: "https://a.test/", ...over }) as GuardedResponse;
const guard = (impl?: () => Promise<{ rootDomain: string }>) => ({ validateAndNormalize: vi.fn(impl ?? (async () => ({ rootDomain: "a.test" }))) }) as unknown as UrlGuard & { validateAndNormalize: ReturnType<typeof vi.fn> };
const WP = '<html><head><meta name="generator" content="WordPress 6"></head></html>';

describe("POST /projects/fingerprint · service", () => {
  afterEach(() => vi.useRealTimers());

  it("FP-1 a readable site yields its platform with a confidence, the not-derived fields named, and a zero charge", async () => {
    const fetch = vi.fn(async () => ok(WP));
    const res = await new ProjectFingerprintService(guard(), fetch).fingerprint({ root_url: "https://a.test/" });
    expect(fingerprintResponseSchema.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ status: "complete", reason: null, platform: { value: "wordpress", confidence: 0.95 }, category: null, verticals: [], not_derived: ["category", "verticals"], credits_charged: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("FP-2 a readable site with no recognised platform is complete with platform null, which is not the same as unavailable", async () => {
    const res = await new ProjectFingerprintService(guard(), async () => ok("<html><title>Acme</title></html>")).fingerprint({ root_url: "https://a.test/" });
    expect(res).toMatchObject({ status: "complete", reason: null, platform: null });
  });

  it("FP-3 an unsafe URL is refused 422 unsafe_target BEFORE any fetch", async () => {
    const fetch = vi.fn(async () => ok(WP));
    const refusing = guard(async () => {
      throw new GuardedFetchRefusal("address_not_global");
    });
    await expect(new ProjectFingerprintService(refusing, fetch).fingerprint({ root_url: "http://10.0.0.1/" })).rejects.toBeInstanceOf(UnsafeTargetError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("FP-4 a fetch that is refused or fails answers unavailable with a short reason, never the underlying message", async () => {
    const dead = new ProjectFingerprintService(guard(), async () => {
      throw new Error("connect ECONNREFUSED 93.184.216.34:443");
    });
    const res = await dead.fingerprint({ root_url: "https://a.test/" });
    expect(res).toMatchObject({ status: "unavailable", reason: "unreachable", platform: null });
    expect(JSON.stringify(res)).not.toContain("93.184");
    const refused = await new ProjectFingerprintService(guard(), async () => {
      throw new GuardedFetchRefusal("address_not_global");
    }).fingerprint({ root_url: "https://a.test/" });
    expect(refused).toMatchObject({ status: "unavailable", reason: "unreachable" });
  });

  it("FP-5 an HTTP error and a non-HTML answer are unavailable with their own reason", async () => {
    expect(await new ProjectFingerprintService(guard(), async () => ok("", { status: 503 })).fingerprint({ root_url: "https://a.test/" })).toMatchObject({ status: "unavailable", reason: "http_error" });
    expect(await new ProjectFingerprintService(guard(), async () => ok("{}", { headers: { "content-type": "application/json" } })).fingerprint({ root_url: "https://a.test/" })).toMatchObject({ status: "unavailable", reason: "not_html" });
  });

  it("FP-6 a site that never answers is cut off at the budget and answers unavailable (budget_exceeded), not a hang", async () => {
    vi.useFakeTimers();
    const pending = new ProjectFingerprintService(guard(), () => new Promise<GuardedResponse>(() => undefined)).fingerprint({ root_url: "https://a.test/" });
    await vi.advanceTimersByTimeAsync(FINGERPRINT_BUDGET_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toMatchObject({ status: "unavailable", reason: "budget_exceeded" });
  });

  it("FP-10 a name that does not resolve is an ANSWER (unavailable), not a 422, while a real address refusal stays 422", async () => {
    const fetch = vi.fn(async () => ok(WP));
    const nxdomain = guard(async () => {
      throw new GuardedFetchRefusal("dns_resolution_failed", "ENOTFOUND");
    });
    const res = await new ProjectFingerprintService(nxdomain, fetch).fingerprint({ root_url: "https://nope.test/" });
    expect(fingerprintResponseSchema.safeParse(res).success).toBe(true);
    expect(res).toMatchObject({ status: "unavailable", reason: "unreachable", platform: null });
    expect(fetch).not.toHaveBeenCalled();
    for (const reason of ["address_not_global", "port_not_allowed", "scheme_not_allowed"] as const) {
      const refusing = guard(async () => {
        throw new GuardedFetchRefusal(reason);
      });
      await expect(new ProjectFingerprintService(refusing, fetch).fingerprint({ root_url: "http://x.test/" })).rejects.toBeInstanceOf(UnsafeTargetError);
    }
  });

  it("FP-11 a DNS lookup that never returns shares the 8 s budget with the fetch: unavailable (budget_exceeded), and no fetch starts late", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => ok(WP));
    const pending = new ProjectFingerprintService(guard(() => new Promise(() => undefined)), fetch).fingerprint({ root_url: "https://a.test/" });
    await vi.advanceTimersByTimeAsync(FINGERPRINT_BUDGET_MS + 1);
    expect(await pending).toMatchObject({ status: "unavailable", reason: "budget_exceeded" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("FP-12 time spent resolving is deducted from the fetch: one deadline, not two", async () => {
    vi.useFakeTimers();
    const slowDns = guard(() => new Promise((resolve) => setTimeout(() => resolve({ rootDomain: "a.test" }), FINGERPRINT_BUDGET_MS - 1_000)));
    const pending = new ProjectFingerprintService(slowDns, () => new Promise<GuardedResponse>(() => undefined)).fingerprint({ root_url: "https://a.test/" });
    await vi.advanceTimersByTimeAsync(FINGERPRINT_BUDGET_MS + 1);
    expect(await pending).toMatchObject({ status: "unavailable", reason: "budget_exceeded" });
  });

  it("FP-7 the fetch is the guarded one and identifies itself, with a truncated body allowed (a page is evidence even when huge)", async () => {
    const fetch = vi.fn(async (_url: string, _init?: unknown) => ok(WP));
    await new ProjectFingerprintService(guard(), fetch).fingerprint({ root_url: "https://a.test/" });
    expect(fetch.mock.calls[0]![1]).toMatchObject({ truncateAtCap: true, headers: expect.objectContaining({ "user-agent": expect.stringContaining("Nominara") }) });
  });

  it("FP-8 emits a span, a metric and a log line with no URL, host or page text", async () => {
    const { Logger } = await import("@nestjs/common");
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    try {
      await new ProjectFingerprintService(guard(), async () => ok(WP)).fingerprint({ root_url: "https://secret-brand.test/" });
    } finally {
      spy.mockRestore();
    }
    expect(logs).toContainEqual(expect.objectContaining({ metric: "nominara_projects_fingerprint_total", status: "complete" }));
    const line = logs.find((l) => (l as { event?: string }).event === "project.fingerprint") as Record<string, unknown>;
    expect(line).toMatchObject({ status: "complete", platform: "wordpress" });
    expect(JSON.stringify(logs)).not.toContain("secret-brand");
  });
});

// STORY-195 / owner decisions 87b, 88, 92: the category suggestion is the taxonomy nearest match discovery uses, inside the endpoint's ONE deadline,
// with no transaction open. Below the 0.60 line there is no category value; a failure or the deadline leaves the category absent, never an error.
const TAXONOMY = [
  { slug: "crm", name: "CRM software", description: "sales pipeline and contacts" },
  { slug: "bakery", name: "Bakery", description: "bread and cakes" },
];
const CRM_PAGE = "<html><head><title>Acme CRM</title><meta name=\"description\" content=\"sales pipeline for teams\"></head></html>";
const NEUTRAL_PAGE = "<html><head><title>Acme</title><meta name=\"description\" content=\"anything at all\"></head></html>";
let modelSeq = 0;
// One axis per category. Category text and site text that mention the pipeline sit on the first axis; "anything" sits equally between both.
const vectorOf = (text: string): number[] => (/pipeline|CRM/i.test(text) ? [1, 0] : /anything/i.test(text) ? [1, 1] : [0, 1]);
const embedder = (over: Partial<TextEmbedder> = {}): TextEmbedder & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    model: `fp-test-model-${String(++modelSeq)}`,
    async embed(texts) {
      calls.push([...texts]);
      return { vectors: texts.map(vectorOf), totalTokens: texts.length };
    },
    ...over,
    calls,
  };
};
const taxonomyPool = (rows: unknown[] = TAXONOMY) => ({ query: vi.fn(async () => ({ rows, rowCount: rows.length })) }) as unknown as Pool & { query: ReturnType<typeof vi.fn> };
const withCategory = (e: TextEmbedder, pool: Pool = taxonomyPool(), html = CRM_PAGE) => new ProjectFingerprintService(guard(), async () => ok(html), pool, e);

describe("POST /projects/fingerprint · category (STORY-195, decisions 87b/88/92)", () => {
  afterEach(() => vi.useRealTimers());

  it("FP-13 a confident nearest match fills the category with its slug and confidence and takes it out of not_derived; verticals stay not derived", async () => {
    const res = await withCategory(embedder()).fingerprint({ root_url: "https://a.test/" });
    expect(fingerprintResponseSchema.safeParse(res).success).toBe(true);
    expect(res.category).toMatchObject({ value: "crm" });
    expect(res.category!.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE_THRESHOLD);
    expect(res.not_derived).toEqual(["verticals"]);
    expect(res.verticals).toEqual([]);
    expect(res).toMatchObject({ status: "complete", credits_charged: 0 });
  });

  it("FP-14 below the 0.60 low-confidence line there is no category value, and it is not claimed to be underivable either", async () => {
    const res = await withCategory(embedder(), taxonomyPool(), NEUTRAL_PAGE).fingerprint({ root_url: "https://a.test/" });
    expect(res.category).toBeNull();
    expect(res.not_derived).toEqual(["verticals"]);
  });

  it("FP-15 a provider failure leaves the category absent (still not derived), never an error, and the platform is kept", async () => {
    const failing = embedder({
      embed: async () => {
        throw new Error("provider down 10.0.0.9");
      },
    });
    const res = await new ProjectFingerprintService(guard(), async () => ok(WP + CRM_PAGE), taxonomyPool(), failing).fingerprint({ root_url: "https://a.test/" });
    expect(res).toMatchObject({ status: "complete", reason: null, category: null, platform: { value: "wordpress" }, not_derived: ["category", "verticals"] });
    expect(JSON.stringify(res)).not.toContain("10.0.0.9");
  });

  it("FP-16 an embedding that outlives the shared deadline is cut off at it: complete, category absent, the platform kept, and no second budget", async () => {
    vi.useFakeTimers();
    const hanging = embedder({ embed: () => new Promise(() => undefined) });
    const slowFetch = () => new Promise<GuardedResponse>((resolve) => setTimeout(() => resolve(ok(WP + CRM_PAGE)), FINGERPRINT_BUDGET_MS - 1_000));
    const pending = new ProjectFingerprintService(guard(), slowFetch, taxonomyPool(), hanging).fingerprint({ root_url: "https://a.test/" });
    await vi.advanceTimersByTimeAsync(FINGERPRINT_BUDGET_MS - 1_000);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(501);
    expect(await pending).toMatchObject({ status: "complete", category: null, platform: { value: "wordpress" }, not_derived: ["category", "verticals"] });
  });

  it("FP-17 a site that could not be read spends no embedding and reads no taxonomy", async () => {
    const e = embedder();
    const pool = taxonomyPool();
    const res = await new ProjectFingerprintService(guard(), async () => ok("", { status: 503 }), pool, e).fingerprint({ root_url: "https://a.test/" });
    expect(res).toMatchObject({ status: "unavailable", category: null });
    expect(e.calls).toHaveLength(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("FP-18 the taxonomy read and the embedding run with no tenant transaction in scope (nothing waits on the provider inside one)", async () => {
    const seen: unknown[] = [];
    const e = embedder({
      embed: async (texts) => {
        seen.push(currentTenantStore());
        return { vectors: texts.map(vectorOf), totalTokens: 1 };
      },
    });
    const pool = taxonomyPool();
    pool.query.mockImplementation(async () => {
      seen.push(currentTenantStore());
      return { rows: TAXONOMY, rowCount: TAXONOMY.length };
    });
    await withCategory(e, pool).fingerprint({ root_url: "https://a.test/" });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((store) => store === undefined)).toBe(true);
  });

  it("FP-19 classifies the SAME site text discovery does for the same page (one nearest-match, not a second reading)", async () => {
    const page = `<html lang="en"><head><title>Acme CRM | Sell more</title><meta name="description" content="Pipeline for sales teams."></head><body><nav><ul><li><a href="/p">Products</a><ul><li><a href="/s">Sales Cloud</a></li></ul></li></ul></nav><h1>Close deals faster</h1><p>Everything your sellers need in one place.</p></body></html>`;
    let discoveryText = "";
    await discover(
      { rootUrl: "https://a.test", rootDomain: "a.test", fieldsSupplied: [] },
      {
        fetch: async () => ok(page),
        now: () => 0,
        classify: async (text) => {
          discoveryText = text;
          return null;
        },
      },
    );
    const e = embedder();
    await withCategory(e, taxonomyPool(), page).fingerprint({ root_url: "https://a.test/" });
    expect(discoveryText).not.toBe("");
    expect(e.calls.flat()).toContain(discoveryText);
  });

  it("FP-20 an empty taxonomy is a fault the answer names (category stays not derived); a page with no text is found-nothing and spends no embedding", async () => {
    const empty = await withCategory(embedder(), taxonomyPool([])).fingerprint({ root_url: "https://a.test/" });
    expect(empty).toMatchObject({ category: null, not_derived: ["category", "verticals"] });
    const e = embedder();
    const blank = await withCategory(e, taxonomyPool(), "<html></html>").fingerprint({ root_url: "https://a.test/" });
    expect(blank).toMatchObject({ category: null, not_derived: ["verticals"] });
    expect(e.calls).toHaveLength(0);
  });

  it("FP-21 emits a classification span's metric and a log line carrying the outcome, never the slug, the URL or page text", async () => {
    const { Logger } = await import("@nestjs/common");
    const logs: unknown[] = [];
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void logs.push(m));
    try {
      await withCategory(embedder()).fingerprint({ root_url: "https://secret-brand.test/" });
    } finally {
      spy.mockRestore();
    }
    expect(logs).toContainEqual(expect.objectContaining({ metric: "nominara_projects_fingerprint_category_total", outcome: "proposed" }));
    const line = logs.find((l) => (l as { event?: string }).event === "project.fingerprint") as Record<string, unknown>;
    expect(line).toMatchObject({ category_outcome: "proposed" });
    expect(JSON.stringify(logs)).not.toContain("secret-brand");
    expect(JSON.stringify(line)).not.toContain("crm");
  });
});

describe("POST /projects/fingerprint · controller", () => {
  const proto = ProjectFingerprintController.prototype as unknown as { fingerprint: (...a: never[]) => unknown };
  it("FP-9 is tenant-less (no ambient transaction can span the fetch), carries no permission, is rate-limited, and is contracted", () => {
    expect(Reflect.getMetadata(SKIP_TENANT_CONTEXT_KEY, proto.fingerprint)).toBe(true);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto.fingerprint)).toBeUndefined();
    // Session-authenticated: NOT @Public(), so an anonymous caller cannot make the server fetch a URL.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.fingerprint) ?? Reflect.getMetadata(IS_PUBLIC_KEY, ProjectFingerprintController)).toBeUndefined();
    expect(Reflect.getMetadata(RATE_LIMIT_CLASS_KEY, proto.fingerprint)).toBe("tool_site_files");
    expect(Reflect.getMetadata(API_CONTRACT_KEY, proto.fingerprint)).toMatchObject({ operationId: "fingerprintProject" });
  });
});

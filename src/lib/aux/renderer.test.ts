import { describe, expect, it } from "vitest";
import { GuardedFetchRefusal } from "../net/guarded-fetch.js";
import { createRenderRequestGuard, RendererUnavailable, unavailableRenderer } from "./renderer.js";

const resolvesPublic = async (_url: string): Promise<void> => undefined;
const refusesInternal = async (url: string): Promise<void> => {
  if (/127\.0\.0\.1|169\.254|localhost|10\.0\.0/.test(url)) throw new GuardedFetchRefusal("address_not_global");
};

describe("STORY-049 AC10 · the renderer's request guard (scenario 12: no network beyond the target)", () => {
  const guard = createRenderRequestGuard("https://www.acme.com/pricing", { assertSafe: refusesInternal });

  it("allows the target and its own subdomains and sibling hosts on the same registrable domain", async () => {
    expect((await guard("https://www.acme.com/app.js")).allow).toBe(true);
    expect((await guard("https://cdn.acme.com/x.css")).allow).toBe(true);
    expect((await guard("https://acme.com/")).allow).toBe(true);
  });

  it("refuses any other registrable domain, so a third-party script or beacon is never fetched", async () => {
    expect(await guard("https://analytics.example.net/t.js")).toEqual({ allow: false, reason: "foreign_site" });
    expect(await guard("https://acme.com.evil.example/")).toEqual({ allow: false, reason: "foreign_site" });
  });

  it("refuses an internal address even on the target's own name: assertSafeUrl runs on EVERY request, not once", async () => {
    const g = createRenderRequestGuard("https://acme.com/", { assertSafe: refusesInternal });
    expect(await g("http://127.0.0.1:8080/admin")).toEqual({ allow: false, reason: "foreign_site" }); // IP literal: not the target's domain
    const sameNameInternal = createRenderRequestGuard("https://acme.com/", {
      assertSafe: async () => {
        throw new GuardedFetchRefusal("address_not_global");
      },
    });
    expect(await sameNameInternal("https://cdn.acme.com/x")).toEqual({ allow: false, reason: "address_not_global" });
  });

  it("refuses file:, ftp:, chrome: and javascript: (no filesystem, no other protocol), and allows data: and about:blank (no network)", async () => {
    for (const url of ["file:///etc/passwd", "ftp://acme.com/x", "chrome://settings", "javascript:alert(1)", "blob:https://acme.com/1"]) {
      expect((await guard(url)).allow).toBe(false);
    }
    expect((await guard("data:image/png;base64,AAAA")).allow).toBe(true);
    expect((await guard("about:blank")).allow).toBe(true);
  });

  it("refuses an unparseable URL, and never puts a resolved address or the request URL into the reason", async () => {
    expect(await guard("::::")).toEqual({ allow: false, reason: "invalid_url" });
    const r = await guard("https://analytics.example.net/t.js?token=SECRET");
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("stops allowing requests past the per-render cap, so one page cannot become a crawl of its own", async () => {
    const g = createRenderRequestGuard("https://acme.com/", { assertSafe: resolvesPublic, maxRequests: 3 });
    expect((await g("https://acme.com/1")).allow).toBe(true);
    expect((await g("https://acme.com/2")).allow).toBe(true);
    expect((await g("https://acme.com/3")).allow).toBe(true);
    expect(await g("https://acme.com/4")).toEqual({ allow: false, reason: "request_cap" });
  });

  it("a target that is not http(s) cannot be rendered at all", () => {
    expect(() => createRenderRequestGuard("file:///etc/passwd", { assertSafe: resolvesPublic })).toThrow();
  });
});

describe("STORY-049 AC6/AC10 · the renderer that is not available", () => {
  it("says so with a typed error rather than returning an empty page that would read as 'no JavaScript content'", async () => {
    await expect(unavailableRenderer.render("https://acme.com/", async () => ({ allow: true }))).rejects.toBeInstanceOf(RendererUnavailable);
  });
});

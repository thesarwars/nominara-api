import { Controller, Get, Req } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { fastifyServerOptions, parseTrustedProxyCidrs } from "../../src/api/fastify-options.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-026 audit fix — BOTH DIRECTIONS, because getting this wrong in either
// direction is a security bug and they are opposite bugs.
//
//   Too little trust: every client behind a load balancer shares one IP
//   bucket, so §12's `auth` row becomes thirty sign-ins per minute for the
//   entire platform. A denial of service against every tenant at once.
//
//   Too much trust (`trustProxy: true`): any caller can prepend a forged
//   `X-Forwarded-For` and land in a fresh bucket. Free, silent evasion of
//   every per-IP limit in §12 — worse than the first, because nobody notices.
//
// A hop count is what distinguishes them, and neither test alone would catch
// the other's failure.

@Controller("probe")
class IpProbeController {
  // Reads what RateLimitGuard reads, from the same request object, rather than
  // re-deriving it — so this test cannot pass while the guard sees something
  // else.
  @Get("ip")
  ip(@Req() request: { ip: string }): { ip: string } {
    return { ip: request.ip };
  }
}

async function appWith(hops: string | undefined, cidrs?: string): Promise<NestFastifyApplication> {
  applyFakeApiEnv();
  if (hops === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = hops;
  if (cidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = cidrs;

  const moduleRef = await Test.createTestingModule({ controllers: [IpProbeController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(fastifyServerOptions()));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/** The address the request object carries — the exact value RateLimitGuard keys its IP buckets on. */
function observedIp(app: NestFastifyApplication): (headers: Record<string, string>) => Promise<string> {
  return async (headers) => {
    const response = await app.inject({
      method: "GET",
      url: "/probe/ip",
      headers,
      remoteAddress: "10.0.0.5",
    });
    return (response.json() as { ip: string }).ip;
  };
}

describe("STORY-026 · request.ip behind a proxy", () => {
  let app: NestFastifyApplication;
  const originalEnv = { ...process.env };

  afterEach(async () => {
    await app.close();
    process.env = { ...originalEnv };
  });

  it("with no configured proxy, uses the peer address and ignores X-Forwarded-For", async () => {
    // The safe default. Nothing in front means the peer IS the client, and
    // honouring a header here would hand every caller their own bucket key.
    app = await appWith(undefined);
    const ip = await observedIp(app);
    expect(await ip({ "x-forwarded-for": "203.0.113.9" })).toBe("10.0.0.5");
  });

  it("with one trusted hop, three clients through one balancer get three DIFFERENT addresses", async () => {
    // The bug this exists to prevent: all three collapsing to 10.0.0.5, so
    // §12's auth row becomes thirty sign-ins per minute platform-wide.
    app = await appWith("1");
    const ip = await observedIp(app);

    const seen = [
      await ip({ "x-forwarded-for": "203.0.113.1" }),
      await ip({ "x-forwarded-for": "203.0.113.2" }),
      await ip({ "x-forwarded-for": "203.0.113.3" }),
    ];
    expect(new Set(seen).size, "one bucket for every client is a platform-wide outage").toBe(3);
    expect(seen).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
  });

  it("with one trusted hop, a caller cannot forge extra hops to reach a fresh bucket", async () => {
    // The opposite failure. Under `trustProxy: true` the leftmost entry wins
    // and this returns 198.51.100.99 — a bucket key of the caller's choosing,
    // and every per-IP limit in §12 becomes free to evade. With a hop count,
    // only the address the trusted proxy itself appended is believed.
    app = await appWith("1");
    const ip = await observedIp(app);

    const forged = await ip({ "x-forwarded-for": "198.51.100.99, 203.0.113.7" });
    expect(forged, "only the hop our own proxy appended may be believed").toBe("203.0.113.7");
    expect(forged).not.toBe("198.51.100.99");
  });

  // ⚠ STORY-148 — THE COUNTING RULE ITSELF, which nothing pinned and which
  // the documentation got WRONG in the forgery direction.
  //
  // nominara-app relays the chain it received verbatim; it does not append to
  // it. `proxy-addr` starts its walk at the SOCKET PEER, and that peer is
  // nominara-app — so a relaying hop is already accounted for and consumes no
  // count. The rule "count the proxies you operate, including this server"
  // gives 2 for the topology below, and 2 is the caller's own value.
  //
  // This is the shape that makes it dangerous: under honest traffic 1 and 2
  // agree, so a staging environment set to 2 looks perfect.
  describe("the counting rule — browser → ingress(appends) → nominara-app(relays) → api", () => {
    // What arrives at the api: the ingress appended the browser's real
    // address to whatever the browser sent, and nominara-app passed it on
    // untouched.
    const FORGED = "198.51.100.99, 203.0.113.9";
    const HONEST = "203.0.113.9";

    it("ONE appending hop means 1 — and 1 is the only value that resists a prepended entry", async () => {
      app = await appWith("1");
      const ip = await observedIp(app);
      expect(await ip({ "x-forwarded-for": HONEST })).toBe("203.0.113.9");
      expect(await ip({ "x-forwarded-for": FORGED }), "the ingress-appended entry, not the caller's").toBe("203.0.113.9");
    });

    it("RED — counting the relaying hop as well gives 2, and 2 returns whatever the caller prepended", async () => {
      app = await appWith("2");
      const ip = await observedIp(app);
      expect(await ip({ "x-forwarded-for": FORGED })).toBe("198.51.100.99");
    });

    it("⚠ and 2 is INDISTINGUISHABLE from 1 under honest traffic — why this was never noticed", async () => {
      app = await appWith("2");
      const ip = await observedIp(app);
      expect(await ip({ "x-forwarded-for": HONEST })).toBe("203.0.113.9");
    });

    it("with NOTHING appending in front, any value at all hands the caller their own bucket key", async () => {
      // The topology an operator reaching for this variable most likely has:
      // nominara-app exposed directly, or behind an L4 balancer that does not
      // touch X-Forwarded-For. There is no trustworthy entry in the chain,
      // so the only safe setting is unset.
      app = await appWith("1");
      const ip = await observedIp(app);
      expect(await ip({ "x-forwarded-for": "9.9.9.9" })).toBe("9.9.9.9");

      await app.close();
      app = await appWith(undefined);
      const unsetIp = await observedIp(app);
      expect(await unsetIp({ "x-forwarded-for": "9.9.9.9" }), "unset is the only safe setting here").toBe("10.0.0.5");
    });
  });

  it("is off unless configured — an operator opts in to trusting a header", async () => {
    app = await appWith(undefined);
    expect(fastifyServerOptions()).toEqual({});
    process.env.TRUST_PROXY_HOPS = "2";
    // fastify >= 5.12.2 fails a numeric trustProxy closed, so the option is a trust FUNCTION that trusts the first N hops from
    // the socket peer (batch 18, owner decision 108(c)). The behaviour is what the HTTP tests above pin; this pins its shape.
    const { trustProxy } = fastifyServerOptions();
    expect(typeof trustProxy).toBe("function");
    const trusts = trustProxy as (address: string, hop: number) => boolean;
    expect([0, 1, 2, 3].map((hop) => trusts("10.0.0.5", hop))).toEqual([true, true, false, false]);
  });

  // Batch 19 (follow-up to owner decision 108(k)) - TRUSTED_PROXY_CIDRS: trust a forwarded hop only when it comes from a listed range. This removes
  // the "only the proxy can reach the API" precondition for the address check itself: a direct caller outside the ranges is not believed.
  describe("TRUSTED_PROXY_CIDRS - an allow-list of proxy ranges", () => {
    it("a peer inside a listed range is trusted: the forwarded client address is used", async () => {
      app = await appWith(undefined, "10.0.0.0/8");
      expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
    });

    it("a peer OUTSIDE every listed range is not trusted: X-Forwarded-For is ignored, and the peer address is the client", async () => {
      app = await appWith(undefined, "192.168.0.0/16");
      expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("10.0.0.5");
    });

    it("a caller cannot prepend an address to reach a fresh bucket: only the right-hand run of listed hops is skipped", async () => {
      app = await appWith(undefined, "10.0.0.0/8");
      expect(await observedIp(app)({ "x-forwarded-for": "198.51.100.99, 203.0.113.7" })).toBe("203.0.113.7");
    });

    it("a listed hop further left in the chain is walked past, an unlisted one stops the walk", async () => {
      app = await appWith(undefined, "10.0.0.0/8, 172.16.0.0/12");
      const ip = observedIp(app);
      expect(await ip({ "x-forwarded-for": "203.0.113.9, 172.16.4.4" })).toBe("203.0.113.9");
      expect(await ip({ "x-forwarded-for": "198.51.100.99, 203.0.113.9, 172.16.4.4" })).toBe("203.0.113.9");
    });

    it("takes precedence over TRUST_PROXY_HOPS: the hop count would have trusted this peer, the allow-list does not", async () => {
      app = await appWith("1", "192.168.0.0/16");
      expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("10.0.0.5");
    });

    it("a single address (no prefix) is a valid entry, and surrounding whitespace is ignored", async () => {
      app = await appWith(undefined, "  10.0.0.5  ");
      expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
    });

    it("a bad entry is dropped and the good ones still apply - boot is not broken", async () => {
      app = await appWith(undefined, "not-a-cidr, 10.0.0.0/33, 10.0.0.0/8, 300.1.1.1/8");
      expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
    });

    it("EVERY entry bad: nobody is trusted (fail closed), even when TRUST_PROXY_HOPS is set - it does not fall back to the broader rule", async () => {
      app = await appWith("1", "garbage, 10.0.0.0/99");
      expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("10.0.0.5");
    });

    it("blank or whitespace-only is the same as unset: the hop rule applies as before", async () => {
      app = await appWith("1", "   ");
      expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
      await app.close();
      app = await appWith(undefined, "");
      expect(fastifyServerOptions()).toEqual({});
    });

    it("never throws on any value, so a mistyped variable cannot stop the API booting", () => {
      applyFakeApiEnv();
      for (const value of ["", ",", ",,,", "/", "::/129", "1.2.3.4/-1", "1.2.3.4/8/8", "\u0000", "fe80::1%eth0/10", "10.0.0.0/8,"]) {
        process.env.TRUSTED_PROXY_CIDRS = value;
        expect(() => fastifyServerOptions()).not.toThrow();
      }
    });

    // Batch 19 fix - a catch-all range makes every peer a trusted proxy, which is `trustProxy: true` by another spelling: any caller can forge
    // X-Forwarded-For and choose their own rate-limit bucket. It is refused, loudly, and the rest of the list still applies.
    it("0.0.0.0/0 and ::/0 are refused as catch-all ranges (and counted apart from malformed entries); any other prefix, including /1, is not", () => {
      expect(parseTrustedProxyCidrs("0.0.0.0/0")).toEqual({ valid: [], dropped: 0, catchAll: 1 });
      expect(parseTrustedProxyCidrs("::/0")).toEqual({ valid: [], dropped: 0, catchAll: 1 });
      expect(parseTrustedProxyCidrs("10.1.2.3/0, ::/00, 0.0.0.0/000")).toEqual({ valid: [], dropped: 0, catchAll: 3 });
      expect(parseTrustedProxyCidrs("0.0.0.0/1, ::/1, 0.0.0.0, 10.0.0.0/8")).toEqual({ valid: ["0.0.0.0/1", "::/1", "0.0.0.0", "10.0.0.0/8"], dropped: 0, catchAll: 0 });
      expect(parseTrustedProxyCidrs("0.0.0.0/0, junk, 10.0.0.0/8")).toEqual({ valid: ["10.0.0.0/8"], dropped: 1, catchAll: 1 });
    });

    it("a catch-all entry alone trusts nobody (the peer is the client), warns, and does not fall back to TRUST_PROXY_HOPS", async () => {
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      try {
        app = await appWith("1", "0.0.0.0/0");
        expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("10.0.0.5");
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: "trusted_proxy_cidrs_catch_all_refused", refused: 1 }));
      } finally {
        warn.mockRestore();
      }
    });

    it("a catch-all entry beside a real range: the catch-all is refused, the real range still applies, and the warning names the count only", async () => {
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      try {
        app = await appWith(undefined, "::/0, 10.0.0.0/8");
        expect(await observedIp(app)({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
        expect(fastifyServerOptions().trustProxy).toEqual(["10.0.0.0/8"]);
        const logged = JSON.stringify(warn.mock.calls);
        expect(logged).toContain("trusted_proxy_cidrs_catch_all_refused");
        expect(logged).not.toContain("::/0");
      } finally {
        warn.mockRestore();
      }
    });

    it("IPv6 ranges are accepted", async () => {
      process.env.TRUSTED_PROXY_CIDRS = "fd00::/8,10.0.0.0/8";
      app = await appWith(undefined, "fd00::/8,10.0.0.0/8");
      expect(Array.isArray(fastifyServerOptions().trustProxy)).toBe(true);
      expect(fastifyServerOptions().trustProxy).toEqual(["fd00::/8", "10.0.0.0/8"]);
    });
  });
});

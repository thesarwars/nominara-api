import { Controller, Get, Req } from "@nestjs/common";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { fastifyServerOptions } from "../../src/api/fastify-options.js";
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

async function appWith(hops: string | undefined): Promise<NestFastifyApplication> {
  applyFakeApiEnv();
  if (hops === undefined) delete process.env.TRUST_PROXY_HOPS;
  else process.env.TRUST_PROXY_HOPS = hops;

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
    expect(fastifyServerOptions()).toEqual({ trustProxy: 2 });
  });
});

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

  it("is off unless configured — an operator opts in to trusting a header", async () => {
    app = await appWith(undefined);
    expect(fastifyServerOptions()).toEqual({});
    process.env.TRUST_PROXY_HOPS = "2";
    expect(fastifyServerOptions()).toEqual({ trustProxy: 2 });
  });
});

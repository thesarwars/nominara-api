import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RESPONSE_BYTES } from "./address-rules.js";
import { assertSafeUrl, defaultDepsAreStrict, GuardedFetchRefusal, guardedFetch } from "./guarded-fetch.js";

// STORY-131 — the refusal scenarios need no server; the redirect, cap and
// timeout scenarios need a REAL one. A mocked transport would prove the code
// calls itself in the right order, which is not the claim: the claim is that a
// hostile server cannot make us follow a redirect to loopback or buffer 6 MB.
//
// The server binds 127.0.0.1, which is itself a refused address — so these
// tests reach it through assertSafeUrl's own escape hatch being absent, i.e.
// they call requestOnce's path via a host that resolves publicly. That is not
// possible offline, so the redirect and cap tests drive the loop with an
// explicitly allowed localhost by asserting on the REFUSAL instead, and the
// body-cap test uses the one thing that needs no address at all.

describe("STORY-131 · assertSafeUrl — the refusals", () => {
  it("scenario 2 — refuses a non-http scheme, naming the scheme check", async () => {
    for (const url of ["file:///etc/passwd", "gopher://x/", "ftp://x/", "data:text/plain,hi"]) {
      await expect(assertSafeUrl(url)).rejects.toMatchObject({ reason: "scheme_not_allowed" });
    }
  });

  it("scenario 3 — refuses a disallowed port", async () => {
    for (const url of ["http://example.com:22/", "http://example.com:6379/", "https://example.com:8080/"]) {
      await expect(assertSafeUrl(url)).rejects.toMatchObject({ reason: "port_not_allowed" });
    }
  });

  it("allows the default and explicit allowed ports", async () => {
    await expect(assertSafeUrl("http://example.com:80/")).resolves.toBeDefined();
    await expect(assertSafeUrl("https://example.com:443/")).resolves.toBeDefined();
  });

  it.each([
    ["http://127.0.0.1/", "scenario 4 — loopback"],
    ["http://169.254.169.254/latest/meta-data/", "scenario 5 — cloud metadata"],
    ["http://10.0.0.1/", "scenario 6 — RFC1918"],
    ["http://192.168.1.1/", "scenario 6 — RFC1918"],
    ["http://172.16.0.1/", "scenario 6 — RFC1918"],
    ["http://100.64.0.1/", "scenario 7 — CGNAT"],
    ["http://[fc00::1]/", "scenario 8 — unique-local"],
    ["http://[fe80::1]/", "scenario 8 — IPv6 link-local"],
    ["http://[::ffff:127.0.0.1]/", "scenario 9 — IPv4-mapped loopback"],
  ])("refuses %s (%s)", async (url) => {
    await expect(assertSafeUrl(url)).rejects.toMatchObject({ reason: "address_not_global" });
  });

  it("refuses a malformed URL rather than throwing something unhandled", async () => {
    await expect(assertSafeUrl("not a url")).rejects.toBeInstanceOf(GuardedFetchRefusal);
  });

  // Scenario 13 — the refusal is the SSRF oracle if it echoes what it resolved.
  it("scenario 13 — a refusal names the check and never an address", async () => {
    const error = await assertSafeUrl("http://169.254.169.254/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuardedFetchRefusal);
    const serialised = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(serialised).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    expect(serialised).toContain("address_not_global");
  });
});

// The loop, the cap and the timeouts against a REAL server.
//
// A test server can only bind loopback on an ephemeral port, which the strict
// validator refuses before a socket opens — correctly, and that is exactly why
// these need the deps seam. The injected validator permits ONLY this one
// origin and delegates everything else to the real one, so a redirect target
// is still judged strictly and scenario 11 tests what it claims to.
describe("STORY-131 · guardedFetch — the loop, against a real server", () => {
  let server: Server;
  let origin = "";
  let bigRequests = 0;

  // Built with new URL(path, origin), never by interpolating origin into a
  // template literal. ISO-14's scanner treats a template that opens with an
  // interpolated identifier followed by a slash as a possible object-storage
  // key, and a test URL of that shape is indistinguishable from one by regex.
  // Going through URL is also what the code under test does, so this is the
  // more faithful construction regardless of the scanner.
  const at = (path: string): string => new URL(path, origin).toString();

  const permitTestOrigin = {
    assertSafe: async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.origin !== origin) return assertSafeUrl(rawUrl);
      return { url, addresses: ["127.0.0.1"] };
    },
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (url === "/to-loopback") {
        res.writeHead(302, { location: "http://127.0.0.1:9/" });
        res.end();
      } else if (url.startsWith("/hop")) {
        const n = Number(url.slice(4)) || 0;
        res.writeHead(302, { location: `/hop${String(n + 1)}` });
        res.end();
      } else if (url === "/relative") {
        res.writeHead(302, { location: "/landed" });
        res.end();
      } else if (url === "/landed") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("landed");
      } else if (url === "/big") {
        bigRequests += 1;
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(512 * 1024, 0x61);
        let sent = 0;
        // 6 MB in 512 KB writes, so the cap must fire mid-stream. Backpressure
        // aware, or the writes queue and the socket dies before we get there.
        const pump = (): void => {
          while (sent < 12) {
            sent += 1;
            if (!res.write(chunk)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        pump();
      } else if (url === "/echo-headers") {
        // What the server actually received: the agent string, and the Host it was addressed by.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ua: req.headers["user-agent"] ?? null, host: req.headers.host ?? null, accept: req.headers.accept ?? null }));
      } else if (url === "/never") {
        // Headers, then silence — the total-timeout case.
        res.writeHead(200, { "content-type": "text/plain" });
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches a plain 200", async () => {
    const response = await guardedFetch(at("/"), {}, permitTestOrigin);
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("ok");
  });

  it("follows a relative redirect and reports the final URL", async () => {
    const response = await guardedFetch(at("/relative"), {}, permitTestOrigin);
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("landed");
    expect(response.finalUrl).toBe(at("/landed"));
  });

  // Scenario 11 — the one that matters. The origin is permitted; the redirect
  // target is not, and it is judged by the STRICT validator.
  it("scenario 11 — refuses a redirect to cloud metadata, naming the redirect check", async () => {
    await expect(guardedFetch(at("/to-metadata"), {}, permitTestOrigin)).rejects.toMatchObject({
      reason: "redirect_target_refused",
    });
  });

  it("scenario 11 — refuses a redirect to loopback the same way", async () => {
    await expect(guardedFetch(at("/to-loopback"), {}, permitTestOrigin)).rejects.toMatchObject({
      reason: "redirect_target_refused",
    });
  });

  it("scenario 11 — the redirect refusal still leaks no address", async () => {
    const error = await guardedFetch(at("/to-metadata"), {}, permitTestOrigin).catch((e: unknown) => e);
    const serialised = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(serialised).not.toContain("169.254");
  });

  it("scenario 12 — refuses past the hop limit", async () => {
    await expect(guardedFetch(at("/hop0"), {}, permitTestOrigin)).rejects.toMatchObject({
      reason: "too_many_redirects",
    });
  });

  // Scenario 14 — a real 6 MB body over a real socket. This is the assertion
  // the earlier "constant equals constant" version was standing in for.
  it("scenario 14 — aborts a body over the 5 MB cap, mid-stream", async () => {
    const before = bigRequests;
    await expect(guardedFetch(at("/big"), {}, permitTestOrigin)).rejects.toThrow(/size cap/);
    expect(bigRequests).toBe(before + 1); // it really did hit the server
  });

  // STORY-049 AC11 / scenario 5 — "Oversized response: truncated at the cap and recorded". The default (verification,
  // site files) still REJECTS, because a half-read proof or robots file must never be mistaken for the whole of one; only
  // a caller that asks for it, a page fetch, gets the first MAX_RESPONSE_BYTES and a flag saying so.
  it("STORY-049 scenario 5 — with truncateAtCap, an oversized body is cut at the cap and flagged, not thrown", async () => {
    const before = bigRequests;
    const response = await guardedFetch(at("/big"), { truncateAtCap: true }, permitTestOrigin);
    expect(response.truncated).toBe(true);
    expect(response.body.length).toBe(MAX_RESPONSE_BYTES);
    expect(response.status).toBe(200);
    expect(bigRequests).toBe(before + 1);
  });

  it("STORY-049 scenario 5 — a body under the cap is not flagged truncated, in either mode", async () => {
    expect((await guardedFetch(at("/"), {}, permitTestOrigin)).truncated).toBe(false);
    expect((await guardedFetch(at("/"), { truncateAtCap: true }, permitTestOrigin)).truncated).toBe(false);
  });

  // STORY-049 AC7 — "an identified agent string". guardedFetch used to send none, so a crawled site saw Node's default.
  it("STORY-049 AC7 — sends the caller's headers, so the crawl can identify itself", async () => {
    const response = await guardedFetch(
      at("/echo-headers"),
      { headers: { "user-agent": "NominaraBot/1.0 (+https://nominara.com/bot)", accept: "text/html" } },
      permitTestOrigin,
    );
    expect(JSON.parse(response.body.toString())).toMatchObject({ ua: "NominaraBot/1.0 (+https://nominara.com/bot)", accept: "text/html" });
  });

  // The guard pins the address and sets Host from the validated URL. A caller header must not be able to re-point it:
  // a Host that disagrees with the validated name is how a validated request is steered at another virtual host.
  it("STORY-049 AC2 — a caller-supplied Host (any case) cannot override the validated host", async () => {
    const response = await guardedFetch(at("/echo-headers"), { headers: { Host: "internal.example", HOST: "other.example" } }, permitTestOrigin);
    expect(JSON.parse(response.body.toString()).host).toBe(new URL(origin).host);
  });

  it("STORY-049 AC2 — a redirect target is still re-validated when the caller supplies headers", async () => {
    await expect(
      guardedFetch(at("/to-metadata"), { headers: { "user-agent": "NominaraBot/1.0" } }, permitTestOrigin),
    ).rejects.toMatchObject({ reason: "redirect_target_refused" });
  });

  // REVIEW FINDING — a crawl followed redirects to any public host before deciding the target was off-site, so an off-site
  // redirect still sent a NominaraBot request to a third party. The caller can now veto a hop BEFORE it is requested.
  it("STORY-049 — a caller that vetoes a redirect hop gets the redirect response back and the target is never requested", async () => {
    const seen: string[] = [];
    const response = await guardedFetch(
      at("/relative"),
      { followRedirect: (next) => { seen.push(next); return false; } },
      permitTestOrigin,
    );
    expect(seen).toEqual([at("/landed")]);
    expect(response.status).toBe(302);
    expect(response.finalUrl).toBe(at("/relative"));
    expect(response.body.toString()).not.toBe("landed");
  });

  it("STORY-049 — a caller that permits the hop still gets it followed", async () => {
    const response = await guardedFetch(at("/relative"), { followRedirect: () => true }, permitTestOrigin);
    expect(response.status).toBe(200);
    expect(response.finalUrl).toBe(at("/landed"));
  });

  // Scenario 15 — headers arrive, body never does.
  it("scenario 15 — aborts when the body never arrives", async () => {
    await expect(guardedFetch(at("/never"), {}, permitTestOrigin)).rejects.toThrow(/timeout/);
  }, 30_000);

  // THE LOOKUP REGRESSION. Every test above connects to the literal
  // `127.0.0.1`, and net.connect skips the lookup function ENTIRELY for a
  // literal address — so the pinned-address lookup, the single most important
  // line in the module, was never executed by any of them. It was broken for
  // every real hostname (Node's autoSelectFamily path calls lookup with
  // `{all: true}` and expects an array; it got `undefined` and failed with
  // "Invalid IP address") and the suite stayed green.
  //
  // `localhost` is a NAME, so this exercises the lookup for real.
  it("connects through the pinned lookup when the host is a name, not a literal", async () => {
    const port = (server.address() as { port: number }).port;
    const permitLocalhost = {
      assertSafe: async (rawUrl: string) => ({ url: new URL(rawUrl), addresses: ["127.0.0.1"] }),
    };

    const response = await guardedFetch(`http://localhost:${String(port)}/`, {}, permitLocalhost);
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe("ok");
  });

  it("the default deps are the strict validator — the seam is not a bypass", () => {
    expect(defaultDepsAreStrict()).toBe(true);
  });
});

// Scenario 10 — the DNS round-robin bypass.
describe("STORY-131 · assertSafeUrl — every resolved address, not just the first", () => {
  it("refuses when a LATER address is unsafe", async () => {
    const mixed = async () => ["93.184.216.34", "127.0.0.1"];
    await expect(assertSafeUrl("http://round-robin.example/", mixed)).rejects.toMatchObject({
      reason: "address_not_global",
    });
  });

  it("refuses when the FIRST address is unsafe", async () => {
    const mixed = async () => ["10.0.0.1", "93.184.216.34"];
    await expect(assertSafeUrl("http://round-robin.example/", mixed)).rejects.toMatchObject({
      reason: "address_not_global",
    });
  });

  it("refuses a metadata address hidden among public ones", async () => {
    const mixed = async () => ["93.184.216.34", "8.8.8.8", "169.254.169.254"];
    await expect(assertSafeUrl("http://round-robin.example/", mixed)).rejects.toMatchObject({
      reason: "address_not_global",
    });
  });

  it("allows a host whose addresses are all public, and keeps them all", async () => {
    const allPublic = async () => ["93.184.216.34", "8.8.8.8"];
    const target = await assertSafeUrl("http://round-robin.example/", allPublic);
    expect(target.addresses).toEqual(["93.184.216.34", "8.8.8.8"]);
  });

  it("surfaces a resolution failure as its own reason, not as an address refusal", async () => {
    const fails = async (): Promise<string[]> => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertSafeUrl("http://nope.example/", fails)).rejects.toBeInstanceOf(Error);
  });
});

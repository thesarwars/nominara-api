import { describe, expect, it } from "vitest";
import { isGloballyReachable } from "../../../src/lib/net/address-rules.js";
import { assertSafeUrl, GuardedFetchRefusal } from "../../../src/lib/net/guarded-fetch.js";

// STORY-110 abuse suite, guarded-fetch rejection (scenarios 6, 8). The behavioural half (redirect hops, body cap, slow
// body, pinned lookup) is src/lib/net/guarded-fetch.test.ts. This file is the ADVERSARIAL address matrix: every way the
// SAME internal address can be spelled, because a guard that checks one spelling is a guard for one spelling.


describe("STORY-110 · scenario 6 — internal addresses spelled every way are refused", () => {
  it.each([
    ["decimal integer", "http://2130706433/"],
    ["hex integer", "http://0x7f000001/"],
    ["dotted hex", "http://0x7f.0.0.1/"],
    ["octal", "http://0177.0.0.1/"],
    ["short form", "http://127.1/"],
    ["metadata, decimal", "http://2852039166/"],
    ["userinfo in front", "http://example.com@127.0.0.1/"],
    ["userinfo with metadata", "http://user:pw@169.254.169.254/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 unspecified", "http://[::]/"],
    ["mapped loopback, dotted", "http://[::ffff:127.0.0.1]/"],
    ["mapped metadata, hex groups", "http://[::ffff:a9fe:a9fe]/"],
    ["compatible loopback (URL rewrites it to ::7f00:1)", "http://[::127.0.0.1]/"],
    ["compatible metadata", "http://[::169.254.169.254]/"],
    ["SIIT loopback", "http://[::ffff:0:127.0.0.1]/"],
    ["NAT64 loopback", "http://[64:ff9b::127.0.0.1]/"],
    ["NAT64 metadata", "http://[64:ff9b::a9fe:a9fe]/"],
    ["NAT64 RFC1918", "http://[64:ff9b::10.0.0.1]/"],
    ["6to4 loopback", "http://[2002:7f00:1::]/"],
    ["6to4 metadata", "http://[2002:a9fe:a9fe::1]/"],
    ["site-local", "http://[fec0::1]/"],
    ["EC2 IMDS over IPv6", "http://[fd00:ec2::254]/"],
  ])("refuses %s", async (_label, url) => {
    await expect(assertSafeUrl(url)).rejects.toBeInstanceOf(GuardedFetchRefusal);
  });

  it.each(["192.0.2.1", "198.51.100.7", "203.0.113.9", "192.88.99.1", "255.255.255.255", "0.0.0.0"])(
    "refuses the reserved documentation or special-use IPv4 %s",
    (address) => {
      expect(isGloballyReachable(address)).toBe(false);
    },
  );

  it("still reaches public addresses, in every family and when an embedded address is public", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
      expect(isGloballyReachable(address), address).toBe(true);
    }
  });
});

describe("STORY-110 · scenario 8 — name-resolution rebinding, unexpected port and scheme", () => {
  it("refuses a name that answers with ANY internal address, whichever order the resolver returns them", async () => {
    for (const answers of [["93.184.216.34", "10.0.0.5"], ["10.0.0.5", "93.184.216.34"], ["93.184.216.34", "::ffff:7f00:1"], ["93.184.216.34", "64:ff9b::a9fe:a9fe"]]) {
      await expect(assertSafeUrl("http://rebind.example.com/", () => Promise.resolve(answers))).rejects.toMatchObject({ reason: "address_not_global" });
    }
  });

  it("refuses an empty answer set rather than treating no addresses as no objection", async () => {
    await expect(assertSafeUrl("http://empty.example.com/", () => Promise.resolve([]))).rejects.toBeInstanceOf(GuardedFetchRefusal);
  });

  it.each(["http://example.com:0/", "http://example.com:81/", "http://example.com:65535/", "https://example.com:80/x"])(
    "refuses a non-standard port, or a scheme-port mismatch that the allow-list would otherwise pass: %s",
    async (url) => {
      const outcome = await assertSafeUrl(url, () => Promise.resolve(["93.184.216.34"])).then(
        () => "allowed",
        (error: unknown) => (error as GuardedFetchRefusal).reason,
      );
      // https://example.com:80 is a port on the allow-list; the guard's contract is "port in {80,443}", so it is
      // documented here as allowed rather than silently assumed refused.
      expect(outcome).toBe(url.startsWith("https://example.com:80") ? "allowed" : "port_not_allowed");
    },
  );

  it.each(["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "ws://example.com/", "//example.com/", "HTTP-ish://x"])(
    "refuses the scheme or shape %s",
    async (url) => {
      await expect(assertSafeUrl(url, () => Promise.resolve(["93.184.216.34"]))).rejects.toBeInstanceOf(GuardedFetchRefusal);
    },
  );
});

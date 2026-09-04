import { describe, expect, it } from "vitest";
import { isGloballyReachable, unwrapIpv4Mapped } from "./address-rules.js";

// STORY-131 scenarios 4-9. Pure address decisions, no socket and no DNS — the
// whole reason these rules live apart from the fetcher.
describe("STORY-131 · address rules", () => {
  it("allows ordinary public addresses", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isGloballyReachable(address), address).toBe(true);
    }
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback, not just .0.1"],
    ["0.0.0.0", "unspecified"],
    ["10.0.0.1", "RFC1918"],
    ["172.16.0.1", "RFC1918"],
    ["172.31.255.254", "RFC1918 upper bound"],
    ["192.168.1.1", "RFC1918"],
    ["100.64.0.1", "CGNAT"],
    ["100.127.255.254", "CGNAT upper bound"],
    ["169.254.1.1", "link-local"],
    ["169.254.169.254", "cloud metadata — the one that matters most"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ])("refuses %s (%s)", (address) => {
    expect(isGloballyReachable(address)).toBe(false);
  });

  it.each([
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["fe80::1", "IPv6 link-local"],
    ["ff02::1", "IPv6 multicast"],
    ["fd00:ec2::254", "EC2 IMDS over IPv6"],
  ])("refuses %s (%s)", (address) => {
    expect(isGloballyReachable(address)).toBe(false);
  });

  // Scenario 9 — the standard bypass for a filter that checks the two families
  // separately. ::ffff:127.0.0.1 matches no IPv6 block and is not an IPv4
  // string, so without unwrapping it sails through both halves of the check.
  it("unwraps IPv4-mapped IPv6 and refuses the address inside", () => {
    expect(unwrapIpv4Mapped("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(unwrapIpv4Mapped("::ffff:169.254.169.254")).toBe("169.254.169.254");
    expect(isGloballyReachable("::ffff:127.0.0.1")).toBe(false);
    expect(isGloballyReachable("::ffff:169.254.169.254")).toBe(false);
    expect(isGloballyReachable("::ffff:10.0.0.1")).toBe(false);
  });

  it("unwraps the IPv4-compatible form too", () => {
    expect(isGloballyReachable("::127.0.0.1")).toBe(false);
  });

  it("still allows a mapped PUBLIC address — unwrapping must not refuse everything", () => {
    expect(isGloballyReachable("::ffff:93.184.216.34")).toBe(true);
  });

  it("strips an IPv6 zone id before checking", () => {
    expect(isGloballyReachable("fe80::1%eth0")).toBe(false);
  });

  it("refuses anything that is not an address at all", () => {
    expect(isGloballyReachable("not-an-ip")).toBe(false);
    expect(isGloballyReachable("")).toBe(false);
  });
});

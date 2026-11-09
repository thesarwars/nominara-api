import { BlockList, isIPv4, isIPv6 } from "node:net";

// STORY-131 — security-and-tenancy.md §9's address allow-list, as data.
//
// Separated from guarded-fetch.ts because these rules are pure and exhaustively
// testable without a socket, a DNS resolver, or a server. The fetcher's job is
// sequencing (resolve, check, connect, re-check); this file's job is deciding
// whether one address is reachable. Mixing them makes the address table
// testable only through an HTTP round trip, which is how a range quietly goes
// missing.

/**
 * The reason an address, scheme, or port was refused.
 *
 * An ENUM, not prose: `details.reason` is customer-visible on three surfaces
 * (project root URL, audit target, beacon origin — api-specification.md §3), and
 * free text drifts between them. It names the CHECK, never the address —
 * echoing the resolved IP turns this error into the SSRF oracle the guard
 * exists to deny.
 */
export type UnsafeTargetReason =
  | "scheme_not_allowed"
  | "port_not_allowed"
  | "hostname_missing"
  | "dns_resolution_failed"
  | "address_not_global"
  | "redirect_target_refused"
  | "too_many_redirects";

export const ALLOWED_SCHEMES: readonly string[] = ["http:", "https:"];
export const ALLOWED_PORTS: readonly number[] = [80, 443];
export const MAX_REDIRECTS = 3;
export const CONNECT_TIMEOUT_MS = 10_000;
export const TOTAL_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// BlockList rather than hand-written integer comparisons: it is Node's own
// range matcher, it takes CIDR directly so each entry reads as the RFC that
// defines it, and it cannot get an off-by-one at a range boundary the way
// `ip >= start && ip <= end` arithmetic can.
const BLOCKED = new BlockList();

// --- IPv4 -------------------------------------------------------------------
BLOCKED.addSubnet("0.0.0.0", 8, "ipv4"); // RFC 1122 "this host on this network"
BLOCKED.addSubnet("10.0.0.0", 8, "ipv4"); // RFC 1918 private
BLOCKED.addSubnet("100.64.0.0", 10, "ipv4"); // RFC 6598 carrier-grade NAT
BLOCKED.addSubnet("127.0.0.0", 8, "ipv4"); // RFC 1122 loopback
BLOCKED.addSubnet("169.254.0.0", 16, "ipv4"); // RFC 3927 link-local — includes 169.254.169.254
BLOCKED.addSubnet("172.16.0.0", 12, "ipv4"); // RFC 1918 private
BLOCKED.addSubnet("192.0.0.0", 24, "ipv4"); // RFC 6890 IETF protocol assignments
BLOCKED.addSubnet("192.168.0.0", 16, "ipv4"); // RFC 1918 private
BLOCKED.addSubnet("198.18.0.0", 15, "ipv4"); // RFC 2544 benchmarking
BLOCKED.addSubnet("224.0.0.0", 4, "ipv4"); // RFC 5771 multicast
BLOCKED.addSubnet("240.0.0.0", 4, "ipv4"); // RFC 1112 reserved, includes 255.255.255.255
BLOCKED.addSubnet("192.0.2.0", 24, "ipv4"); // RFC 5737 documentation (TEST-NET-1)
BLOCKED.addSubnet("198.51.100.0", 24, "ipv4"); // RFC 5737 documentation (TEST-NET-2)
BLOCKED.addSubnet("203.0.113.0", 24, "ipv4"); // RFC 5737 documentation (TEST-NET-3)
BLOCKED.addSubnet("192.88.99.0", 24, "ipv4"); // RFC 7526 deprecated 6to4 relay anycast

// --- IPv6 -------------------------------------------------------------------
BLOCKED.addAddress("::", "ipv6"); // unspecified
BLOCKED.addAddress("::1", "ipv6"); // loopback
BLOCKED.addSubnet("fc00::", 7, "ipv6"); // RFC 4193 unique-local
BLOCKED.addSubnet("fe80::", 10, "ipv6"); // RFC 4291 link-local
BLOCKED.addSubnet("fec0::", 10, "ipv6"); // RFC 3879 deprecated site-local
BLOCKED.addSubnet("64:ff9b:1::", 48, "ipv6"); // RFC 8215 local-use NAT64: operator-chosen mapping, never public
BLOCKED.addSubnet("ff00::", 8, "ipv6"); // multicast
BLOCKED.addSubnet("fd00:ec2::", 32, "ipv6"); // EC2 IMDS over IPv6
BLOCKED.addSubnet("2001:db8::", 32, "ipv6"); // RFC 3849 documentation

/**
 * Unwraps the IPv4-mapped (`::ffff:127.0.0.1`) and IPv4-compatible (`::127.0.0.1`)
 * IPv6 forms to the IPv4 address inside.
 *
 * Without this, `http://[::ffff:127.0.0.1]/` reaches loopback: it is a
 * syntactically valid IPv6 address that matches no IPv6 block above, and the
 * IPv4 rules never see it because the string is not IPv4. It is the standard
 * bypass for an SSRF filter that checks the two families separately, and it is
 * scenario 9 in this story for that reason.
 */
export function unwrapIpv4Mapped(address: string): string {
  const match = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match ? match[1]! : address;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. Handles `::` and a dotted-quad tail. */
function ipv6Groups(address: string): number[] | null {
  if (!isIPv6(address)) return null;
  let text = address.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail !== null) {
    const octets = tail[1]!.split(".").map(Number);
    text = `${text.slice(0, -tail[1]!.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? [] : new Array<string>(8 - front.length - back.length).fill("0");
  const groups = [...front, ...fill, ...back].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * The IPv4 address an IPv6 address carries inside it, for every embedding that routes TO that IPv4 address:
 * IPv4-compatible `::a.b.c.d`, IPv4-mapped `::ffff:a.b.c.d`, SIIT `::ffff:0:a.b.c.d`, NAT64 `64:ff9b::a.b.c.d`
 * (RFC 6052) and 6to4 `2002:AABB:CCDD::` (RFC 3056). `URL` rewrites a dotted tail to hex groups, so the dotted-only
 * regex in `unwrapIpv4Mapped` never sees what a URL actually carries. Null when the address embeds none.
 */
export function embeddedIpv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (g === null) return null;
  const low = (a: number, b: number): string => `${String(a >> 8)}.${String(a & 255)}.${String(b >> 8)}.${String(b & 255)}`;
  const zeros = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (zeros(6)) return low(g[6]!, g[7]!); // ::/96
  if (zeros(5) && g[5] === 0xffff) return low(g[6]!, g[7]!); // ::ffff:0:0/96
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return low(g[6]!, g[7]!); // ::ffff:0:0:0/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return low(g[6]!, g[7]!);
  if (g[0] === 0x2002) return low(g[1]!, g[2]!);
  return null;
}

/** True when the address is one a user-supplied URL may reach. */
export function isGloballyReachable(address: string): boolean {
  const candidate = unwrapIpv4Mapped(address.replace(/%.*$/, "")); // strip any zone id
  if (!isIPv4(candidate) && !isIPv6(candidate)) return false;
  const embedded = isIPv6(candidate) ? embeddedIpv4(candidate) : null;
  if (embedded !== null && !isGloballyReachable(embedded)) return false;
  return !BLOCKED.check(candidate, isIPv4(candidate) ? "ipv4" : "ipv6");
}

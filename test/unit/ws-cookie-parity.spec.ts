import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCookieHeader } from "../../src/gateway/ws-execution-context.js";

// STORY-026 G26 — the socket path parses the `Cookie` header itself, because a
// handshake has the raw header and no `@fastify/cookie`. Two implementations of
// one format is a divergence waiting to happen, and one already had:
// `decodeURIComponent` THROWS on a malformed escape and the HTTP path returns
// the raw string instead.
//
// The throw escaped `requestFromHandshake`, which ran OUTSIDE the guard loop's
// try/catch, so a handshake carrying `__Host-nominara-access=a%b` got a generic
// exception frame rather than the 4403 contract, STAYED CONNECTED, and
// incremented no refusal metric — the enumeration oracle `joinWorkspace`'s own
// comment forbids, reachable with one character. Found by the dangerous-area
// audit and reproduced end to end.
//
// Parity is asserted against a REAL FASTIFY REQUEST rather than against a
// restatement of what this parser happens to do — a test written from our own
// behaviour cannot catch a divergence from someone else's. It needs no new
// dependency: `@fastify/cookie`'s exported `parse` requires an instance
// context, and the instance is the thing worth comparing to anyway.

const CASES: [string, string][] = [
  ["a plain value", "__Host-nominara-access=abc123"],
  ["a percent-encoded value", "__Host-nominara-access=a%20b"],
  ["a MALFORMED percent-escape", "__Host-nominara-access=a%b"],
  ["a bare trailing percent", "__Host-nominara-access=100%"],
  ["a duplicated name", "sid=first; sid=second"],
  ["several cookies", "__Host-nominara-access=tok; other=1; third=x%2Cy"],
  ["surrounding whitespace", "  __Host-nominara-access=tok  ; other=1"],
  ["an empty value", "__Host-nominara-access="],
];

const app = Fastify();

beforeAll(async () => {
  await app.register(fastifyCookie);
  app.get("/", (request, reply) => reply.send(request.cookies));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** What the HTTP path actually puts on `req.cookies` for this header. */
async function overHttp(cookie: string): Promise<Record<string, string | undefined>> {
  const response = await app.inject({ method: "GET", url: "/", headers: { cookie } });
  return response.json<Record<string, string | undefined>>();
}

describe("STORY-026 · the handshake cookie parser matches the HTTP path's", () => {
  for (const [name, header] of CASES) {
    it(`agrees with a real fastify request on ${name}`, async () => {
      expect(parseCookieHeader(header)).toEqual(await overHttp(header));
    });
  }

  it("never throws, whatever the header says", () => {
    // The property that actually mattered. Whatever the answer is, producing
    // it must not escape as an exception into a path with no refusal handling.
    for (const [, header] of CASES) {
      expect(() => parseCookieHeader(header), header).not.toThrow();
    }
  });
});

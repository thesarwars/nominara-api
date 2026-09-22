import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { canonicalUuid } from "../../src/api/canonical-uuid.js";
import { CanonicalParamsGuard, canonicaliseParams } from "../../src/api/guards/canonical-params.guard.js";
import { routeIdentity } from "../../src/api/idempotency/key.js";

const UPPER = "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11";
const LOWER = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

function httpContext(params: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => ({ params }) }),
  } as unknown as ExecutionContext;
}

describe("STORY-150 · canonicalUuid", () => {
  it("lowercases a uuid, which denotes the same id by RFC 4122", () => {
    expect(canonicalUuid(UPPER)).toBe(LOWER);
    expect(canonicalUuid(LOWER)).toBe(LOWER);
  });

  // ⚠ THE NARROWNESS IS THE POINT. Path params are also slugs, provider names
  // and share tokens; lowercasing one of those changes what it identifies.
  // A uuid is the only value we have licence to respell.
  it("leaves anything that is not a whole uuid exactly alone", () => {
    for (const value of [
      "Acme-Corp",
      "GOOGLE",
      "ShareTokenABC123",
      `${UPPER}x`,
      `x${UPPER}`,
      `${UPPER}/nested`,
      "A0EEBC99-9C0B-4EF8-BB6D",
      "",
    ]) {
      expect(canonicalUuid(value), `must not respell ${JSON.stringify(value)}`).toBe(value);
    }
  });
});

describe("STORY-150 · CanonicalParamsGuard", () => {
  it("rewrites the params object the guards and handler will read", () => {
    const params: Record<string, unknown> = { id: UPPER, slug: "Acme-Corp" };
    expect(new CanonicalParamsGuard().canActivate(httpContext(params))).toBe(true);
    expect(params).toEqual({ id: LOWER, slug: "Acme-Corp" });
  });

  // ⚠ IT REFUSES NOTHING, DELIBERATELY. A uuid in the wrong case is a valid
  // uuid; rejecting it would break a correct client to fix our inconsistency.
  it("admits a request it had nothing to change", () => {
    const params: Record<string, unknown> = { id: LOWER };
    expect(new CanonicalParamsGuard().canActivate(httpContext(params))).toBe(true);
    expect(params).toEqual({ id: LOWER });
  });

  it("survives a request with no params at all", () => {
    const context = { getType: () => "http", switchToHttp: () => ({ getRequest: () => ({}) }) } as unknown as ExecutionContext;
    expect(new CanonicalParamsGuard().canActivate(context)).toBe(true);
  });

  // The realtime gateway builds its own `request.params` and does not run this
  // chain; a non-http context has no request of this shape to reach into.
  it("does not reach into a non-http context", () => {
    const context = {
      getType: () => "ws",
      switchToHttp: () => {
        throw new Error("CanonicalParamsGuard touched a ws context");
      },
    } as unknown as ExecutionContext;
    expect(new CanonicalParamsGuard().canActivate(context)).toBe(true);
  });

  it("leaves non-string values be", () => {
    // It used to return a "did I change anything" boolean that `canActivate`
    // discarded, and this asserted it — an assertion whose subject production
    // threw away. What matters is the object, so that is what is asserted.
    const mixed: Record<string, unknown> = { id: 7, other: null, real: UPPER };
    canonicaliseParams(mixed);
    expect(mixed).toEqual({ id: 7, other: null, real: LOWER });
  });

  // ⚠ REJECTED, NOT NORMALISED. Postgres accepts all three of these as the
  // same uuid, so leaving them through meant two strings naming one row — two
  // idempotency fingerprints and two executions on a credit route, a 404 from
  // `assertMatchesTenant`, and a 500 from the audit interceptor. Widening
  // `canonicalUuid` to swallow them would reimplement Postgres's parser in
  // Node, which is the drift STORY-149 refused to introduce.
  it("REFUSES a uuid spelling Postgres would accept but we will not", () => {
    const spellings = [
      `{${LOWER}}`,
      "a0eebc999c0b4ef8bb6d6bb9bd380a11",
      "a0ee-bc99-9c0b-4ef8-bb6d-6bb9bd380a11", // hyphens in the WRONG places
      "a0eebc99-9c0b4ef8-bb6d-6bb9bd380a11", // a hyphen simply missing
      "a".repeat(32), // 32 bare hex digits IS a uuid to Postgres
    ];
    for (const spelling of spellings) {
      expect(() => canonicaliseParams({ id: spelling }), spelling).toThrow(/canonical/i);
    }
  });

  it("does not refuse an ordinary slug that happens to contain hex and hyphens", () => {
    // Nothing here reduces to 32 hex digits, which is the only test applied.
    for (const ok of ["acme-corp", "a0ee-bc99", "google", "deadbeef", "a".repeat(31), "a".repeat(33), "z".repeat(32)]) {
      expect(() => canonicaliseParams({ slug: ok }), ok).not.toThrow();
    }
  });
});

// ⚠ THE IDEMPOTENCY FINGERPRINT IS A SEPARATE FIX, because `routeIdentity`
// reads the raw URL and never sees `req.params` — so the guard above does not
// reach it. Two spellings of one path produced two scope fingerprints, two
// records and two executions, on routes that spend credits.
describe("STORY-150 · routeIdentity canonicalises the path", () => {
  const RUNS = "/v1/projects/:id/runs";

  it("gives one identity to one operation, whatever case the caller typed", () => {
    expect(routeIdentity("POST", `/v1/projects/${UPPER}/runs`, RUNS, { id: UPPER })).toBe(
      routeIdentity("POST", `/v1/projects/${LOWER}/runs`, RUNS, { id: LOWER }),
    );
  });

  // ⚠ THE ONE THE FIRST ATTEMPT MISSED. Fastify DECODES `params` and does not
  // decode `request.url`, so this request is identical everywhere it is
  // observed — every guard, the handler, the audit row — and differed only
  // here. Three spellings claimed three records and spent three debits.
  it("is unmoved by percent-encoding, which the url-based form could not be", () => {
    const encoded = "/v1/projects/%610eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/runs";
    expect(routeIdentity("POST", encoded, RUNS, { id: LOWER })).toBe(
      routeIdentity("POST", `/v1/projects/${LOWER}/runs`, RUNS, { id: LOWER }),
    );
  });

  it("canonicalises every param, not just the first", () => {
    const pattern = "/v1/workspaces/:workspaceId/members/:memberId";
    const other = "11111111-2222-4333-8444-555555555555";
    expect(
      routeIdentity("PATCH", "/ignored", pattern, { workspaceId: UPPER, memberId: other.toUpperCase() }),
    ).toBe(routeIdentity("PATCH", "/ignored", pattern, { workspaceId: LOWER, memberId: other }));
  });

  it("still distinguishes two different ids, two methods and two routes", () => {
    const a = routeIdentity("POST", `/v1/projects/${LOWER}/runs`, RUNS, { id: LOWER });
    const other = "11111111-2222-4333-8444-555555555555";
    expect(a).not.toBe(routeIdentity("POST", `/v1/projects/${other}/runs`, RUNS, { id: other }));
    expect(a).not.toBe(routeIdentity("GET", `/v1/projects/${LOWER}/runs`, RUNS, { id: LOWER }));
    expect(a).not.toBe(
      routeIdentity("POST", `/v1/projects/${LOWER}/prompts`, "/v1/projects/:id/prompts", { id: LOWER }),
    );
  });

  // A slug in the path must survive: two agencies' portals are not one route.
  it("does not respell a non-uuid param", () => {
    expect(routeIdentity("GET", "/ignored", "/v1/p/:slug/overview", { slug: "Acme-Corp" })).toContain("Acme-Corp");
  });

  it("still canonicalises the query string, and keeps its values verbatim", () => {
    expect(routeIdentity("GET", `/v1/projects/${UPPER}?b=2&a=Mixed`, "/v1/projects/:id", { id: UPPER })).toBe(
      `GET /v1/projects/${LOWER}?a=Mixed&b=2`,
    );
  });

  // ⚠ THE FALLBACK STILL HAS TO WORK, because every unit caller uses it and
  // an adapter that surfaces no matched route must not silently stop
  // canonicalising. It is per-SEGMENT, and it cannot fix percent-encoding —
  // which is precisely why the matched route is preferred rather than optional.
  describe("with no matched route to key on", () => {
    it("falls back to canonicalising each path segment", () => {
      expect(routeIdentity("POST", `/v1/projects/${UPPER}/runs`)).toBe(
        routeIdentity("POST", `/v1/projects/${LOWER}/runs`),
      );
    });

    it("produces the byte-identical string the url-based version did, so records in flight stay reachable", () => {
      expect(routeIdentity("POST", `/v1/projects/${LOWER}/runs`)).toBe(`POST /v1/projects/${LOWER}/runs`);
      expect(routeIdentity("POST", `/v1/projects/${LOWER}/runs`, RUNS, { id: LOWER })).toBe(
        `POST /v1/projects/${LOWER}/runs`,
      );
    });

    it("falls back when the pattern is a wildcard or names a param the router did not supply", () => {
      expect(routeIdentity("GET", `/v1/files/${LOWER}/x`, "/v1/files/*", {})).toBe(`GET /v1/files/${LOWER}/x`);
      expect(routeIdentity("GET", `/v1/files/${UPPER}`, "/v1/files/:id", {})).toBe(`GET /v1/files/${LOWER}`);
    });
  });
});

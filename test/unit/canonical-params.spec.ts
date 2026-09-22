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

  it("reports whether it changed anything, and leaves non-string values be", () => {
    expect(canonicaliseParams({ id: UPPER })).toBe(true);
    expect(canonicaliseParams({ id: LOWER })).toBe(false);
    const mixed: Record<string, unknown> = { id: 7, other: null };
    expect(canonicaliseParams(mixed)).toBe(false);
    expect(mixed).toEqual({ id: 7, other: null });
  });
});

// ⚠ THE IDEMPOTENCY FINGERPRINT IS A SEPARATE FIX, because `routeIdentity`
// reads the raw URL and never sees `req.params` — so the guard above does not
// reach it. Two spellings of one path produced two scope fingerprints, two
// records and two executions, on routes that spend credits.
describe("STORY-150 · routeIdentity canonicalises the path", () => {
  it("gives one identity to one operation, whatever case the caller typed", () => {
    expect(routeIdentity("POST", `/v1/projects/${UPPER}/runs`)).toBe(
      routeIdentity("POST", `/v1/projects/${LOWER}/runs`),
    );
  });

  it("canonicalises every uuid segment, not just the first", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    expect(routeIdentity("PATCH", `/v1/workspaces/${UPPER}/members/${other.toUpperCase()}`)).toBe(
      routeIdentity("PATCH", `/v1/workspaces/${LOWER}/members/${other}`),
    );
  });

  it("still distinguishes two different ids, two methods and two routes", () => {
    const a = routeIdentity("POST", `/v1/projects/${LOWER}/runs`);
    expect(a).not.toBe(routeIdentity("POST", "/v1/projects/11111111-2222-4333-8444-555555555555/runs"));
    expect(a).not.toBe(routeIdentity("GET", `/v1/projects/${LOWER}/runs`));
    expect(a).not.toBe(routeIdentity("POST", `/v1/projects/${LOWER}/prompts`));
  });

  // A slug in the path must survive: two agencies' portals are not one route.
  it("does not respell a non-uuid segment", () => {
    expect(routeIdentity("GET", "/v1/p/Acme-Corp/overview")).toContain("Acme-Corp");
  });

  it("still canonicalises the query string, and keeps its values verbatim", () => {
    expect(routeIdentity("GET", `/v1/projects/${UPPER}?b=2&a=Mixed`)).toBe(
      `GET /v1/projects/${LOWER}?a=Mixed&b=2`,
    );
  });
});

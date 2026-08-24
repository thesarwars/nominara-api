import { describe, expect, it } from "vitest";
import {
  PAGINATION_LIMIT_DEFAULT,
  PAGINATION_LIMIT_MAX,
  paginationRequestSchema,
} from "../../contracts/common/pagination.schema.js";
import {
  assertNoOffsetPagination,
  buildParameters,
  type OpenApiOperation,
  type OpenApiParameter,
} from "../../src/contracts/generate.js";
import type { DiscoveredContractRoute } from "../../src/contracts/discover-routes.js";

// STORY-024 T11 — AC6's forward guard, and the proof that it BITES.
//
// AC6 ("Offset pagination exists on no time-series endpoint") is vacuously
// true in this repo today: there is no list endpoint, so there is nothing to
// paginate by offset. A criterion satisfied by the absence of the thing it
// governs is not a criterion — it is a criterion that will be violated
// silently by whichever story ships the first list route.
//
// assertNoOffsetPagination() runs inside `contracts:generate`, so a
// violating route fails the BUILD and with it `contracts:check`. This file
// exercises it against synthetic operations, because no real route can
// exercise it yet — and every negative case is paired with a positive one,
// since "it threw" proves nothing about WHY it threw.
function routeFor(contract: Partial<DiscoveredContractRoute["contract"]> & { operationId: string }): DiscoveredContractRoute {
  return {
    controllerName: "SyntheticController",
    methodName: "handler",
    httpMethod: "get",
    fullPath: "things",
    httpStatus: 200,
    envelopeExempt: false,
    contract,
  } as DiscoveredContractRoute;
}

function operationWith(parameters: OpenApiParameter[]): OpenApiOperation {
  return { operationId: "listThings", parameters, responses: {} };
}

/** The parameters a route gets by extending paginationRequestSchema — not a hand-built imitation of them. */
function realPaginationParameters(): OpenApiParameter[] {
  return buildParameters(paginationRequestSchema, "query", "things");
}

describe("STORY-024 · AC6 — offset pagination cannot enter the contract", () => {
  it.each(["offset", "page", "page_number", "skip"])("refuses a query parameter named %s", (name) => {
    expect(() =>
      assertNoOffsetPagination(
        routeFor({ operationId: "listThings" }),
        operationWith([{ name, in: "query", required: false, schema: { type: "integer" } }]),
      ),
    ).toThrow(/offset pagination/i);
  });

  it("refuses an offset hidden in a request BODY rather than a query parameter", () => {
    const operation: OpenApiOperation = {
      operationId: "searchThings",
      responses: {},
      requestBody: {
        content: {
          "application/json": {
            schema: { type: "object", properties: { query: { type: "string" }, offset: { type: "integer" } } },
          },
        },
      },
    };
    expect(() => assertNoOffsetPagination(routeFor({ operationId: "searchThings" }), operation)).toThrow(
      /offset pagination/i,
    );
  });

  // The positive control for every case above: an ordinary route with
  // ordinary parameters must pass, or the assertions prove only that the
  // function throws for everything.
  it("passes an ordinary route whose parameters are nothing to do with pagination", () => {
    expect(() =>
      assertNoOffsetPagination(
        routeFor({ operationId: "getThing" }),
        operationWith([{ name: "id", in: "path", required: true, schema: { type: "string" } }]),
      ),
    ).not.toThrow();
  });
});

describe("STORY-024 · AC6 — a listOf operation must page with the shared cursor contract", () => {
  it("accepts an operation carrying paginationRequestSchema's own parameters", () => {
    expect(() =>
      assertNoOffsetPagination(routeFor({ operationId: "listThings", listOf: true }), operationWith(realPaginationParameters())),
    ).not.toThrow();
  });

  it("refuses a listOf operation that declares no cursor", () => {
    const withoutCursor = realPaginationParameters().filter((parameter) => parameter.name !== "cursor");
    expect(() =>
      assertNoOffsetPagination(routeFor({ operationId: "listThings", listOf: true }), operationWith(withoutCursor)),
    ).toThrow(/cursor/);
  });

  // The bound must come from paginationRequestSchema, not from a number a
  // route re-derived — a route capping at 1000 would page 5x the reference's
  // cap while every other gate stayed green.
  it("refuses a listOf operation whose limit re-derives the bounds", () => {
    const rederived: OpenApiParameter[] = [
      { name: "cursor", in: "query", required: false, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 1000, default: 25 } },
    ];
    expect(() =>
      assertNoOffsetPagination(routeFor({ operationId: "listThings", listOf: true }), operationWith(rederived)),
    ).toThrow(new RegExp(`${PAGINATION_LIMIT_MAX}`));
  });

  it("the bounds the guard enforces are the reference's, read from the schema rather than restated here", () => {
    const limit = realPaginationParameters().find((parameter) => parameter.name === "limit");
    expect(limit?.schema.maximum).toBe(PAGINATION_LIMIT_MAX);
    expect(limit?.schema.default).toBe(PAGINATION_LIMIT_DEFAULT);
  });
});

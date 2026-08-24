import { describe, expect, it } from "vitest";
import { problemDetailsSchema } from "../../contracts/common/problem-details.schema.js";
import { validationFailedDetailsSchema } from "../../contracts/common/error-details.schema.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-024 T8 (RED step) — story scenarios 1 and 3, AC1 and AC4, over the
// REAL pipeline. Genuinely red today: src/api/filters/problem.filter.ts is
// still STORY-022's stub. It emits `code`/`details` FLAT at the top level,
// carries no `error` extension member and no `request_id`, and sends
// application/json rather than application/problem+json — so every
// assertion below fails against the shape actually on the wire, which is
// the correct and expected failure until T9 rewrites the filter to D2's
// dual shape.
//
// Only errors reachable WITHOUT a credential are driven here: an
// unauthenticated read, an unknown path, and a malformed body on a
// @Public() route. Codes that need a session, a workspace or a wallet
// (insufficient_credits, entitlement_exceeded, workspace_mismatch…) are
// covered as typed classes in test/unit/error-taxonomy.spec.ts instead —
// this file's job is the WIRE SHAPE the filter produces, not breadth.
describe("STORY-024 · the problem+json wire shape over the real pipeline", () => {
  const harness = useApiHarness();

  async function errorResponse(method: "GET" | "POST", url: string, payload?: Record<string, unknown>) {
    const response = payload
      ? await harness.app().inject({ method, url, payload })
      : await harness.app().inject({ method, url });
    return { response, body: response.json<Record<string, unknown>>() };
  }

  it("AC1 — an error is served as application/problem+json, never application/json", async () => {
    const { response } = await errorResponse("GET", apiUrl("/workspaces"));

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      response.headers["content-type"],
      "api-specification.md §1/§2: error responses are served as application/problem+json",
    ).toContain("application/problem+json");
  });

  // The whole point of decision D2's dual shape: RFC 9457's members for a
  // generic client, plus the `error` member a Nominara client renders from.
  it("AC1 — the body carries RFC 9457's members AND the `error` extension member", async () => {
    const { response, body } = await errorResponse("GET", apiUrl("/workspaces"));

    const parsed = problemDetailsSchema.safeParse(body);
    expect(
      parsed.success,
      `body does not satisfy problemDetailsSchema: ${JSON.stringify(body)}`,
    ).toBe(true);
    expect(body.status).toBe(response.statusCode);
    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("details");
  });

  // §2 puts `request_id` inside the `error` member, and NFR-API-08 is why:
  // a support ticket quotes the error body and must resolve to one trace.
  it("every error body carries error.request_id", async () => {
    const { body } = await errorResponse("GET", apiUrl("/workspaces"));
    const error = body.error as Record<string, unknown> | undefined;

    expect(error?.request_id, "an error a user can screenshot must identify its own request").toBeTruthy();
  });

  it("an unknown path is 404 not_found in the taxonomy's own vocabulary", async () => {
    const { response, body } = await errorResponse("GET", apiUrl("/no-such-resource"));

    expect(response.statusCode).toBe(404);
    expect((body.error as Record<string, unknown>).code).toBe("not_found");
  });

  // Scenario 3's assertion is "Names the permission; **not a not-found**".
  // Both halves matter: a 404 to hide existence would be defensible in some
  // designs and api-specification.md §2 explicitly rules it out here, because
  // 404 means "absent WITHIN the caller's tenant" and a permission failure is
  // a different fact.
  it("AC4 — a permission denial names the permission and is NEVER a not-found", async () => {
    const { response, body } = await errorResponse("GET", apiUrl("/workspaces"));
    const error = body.error as Record<string, unknown>;

    if (response.statusCode === 403) {
      expect(error.code).toBe("forbidden");
      expect(
        (error.details as Record<string, unknown> | undefined)?.required_permission,
        "a 403 must name the permission the caller lacks",
      ).toBeTruthy();
    }
    expect(response.statusCode, "a permission or credential failure must never be disguised as 404").not.toBe(404);
  });

  it("a malformed body on a @Public() route is 400 validation_failed with details.issues[]", async () => {
    const { response, body } = await errorResponse("POST", apiUrl("/auth/passkey/options"), { purpose: "nonsense" });
    const error = body.error as Record<string, unknown>;

    expect(response.statusCode).toBe(400);
    expect(error.code).toBe("validation_failed");
    expect(
      validationFailedDetailsSchema.safeParse(error.details).success,
      `validation details must carry issues[] with path and message: ${JSON.stringify(error.details)}`,
    ).toBe(true);
  });
});

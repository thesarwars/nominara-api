import { describe, expect, it } from "vitest";
import { envelopeMetaSchema } from "../../contracts/common/envelope.schema.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-024 T8 (RED step) — story scenario 8 and AC5/AC9. Red until T10
// adds the response-envelope interceptor: no route wraps its body today.
//
// *** NFR-API-08 / AC9 — THE REQUEST IDENTIFIER IS THE TRACE IDENTIFIER ***
// `meta.request_id` is the 32-hex OpenTelemetry trace id of the request's
// server span (owner decision 2026-10-13); an inbound `X-Request-Id` or
// `traceparent` does not choose it. That the value equals the ACTIVE span's
// trace id is proved in test/unit/request-trace-id.spec.ts; this file proves
// the same over a real stack: shape, echo on the response, uniqueness.
//
//   Also not covered here: that `meta.request_id` equals the value
//   AuditInterceptor writes to `audit_log.request_id`. That correlation
//   needs an audited mutation and therefore a real session; it belongs with
//   test/integration/workspace-mutations-audit.spec.ts, which already has
//   that machinery, and T10 extends it there rather than duplicating a
//   hundred lines of credential setup into this file.
//
// POST /v1/auth/otp/request is the vehicle: a @Public() route that returns a
// 200 body, so a SUCCESS envelope can be observed without minting a token.
describe("STORY-024 · scenario 8 — every response carries the request identifier", () => {
  const harness = useApiHarness();

  const otpRequest = (headers: Record<string, string> = {}) =>
    harness.app().inject({
      method: "POST",
      url: apiUrl("/auth/otp/request"),
      payload: { email: `envelope-${Date.now()}@example.com` },
      headers,
    });

  it("AC5 — a success response is wrapped in the envelope with a valid meta", async () => {
    const response = await otpRequest();
    expect(response.statusCode).toBeLessThan(400);

    const body = response.json<Record<string, unknown>>();
    expect(body, "api-specification.md §1: every response carries the envelope").toHaveProperty("data");
    expect(body).toHaveProperty("meta");

    const parsed = envelopeMetaSchema.safeParse(body.meta);
    expect(parsed.success, `meta does not satisfy envelopeMetaSchema: ${JSON.stringify(body.meta)}`).toBe(true);
  });

  it("the payload the route used to return is now under `data`, unchanged", async () => {
    const body = (await otpRequest()).json<{ data: Record<string, unknown> }>();
    expect(body.data.status, "wrapping must not alter the resource itself").toBe("sent");
  });

  it("a single-resource response carries no pagination member at all", async () => {
    const body = (await otpRequest()).json<Record<string, unknown>>();
    expect(body, "pagination is present only on list endpoints — never as a null placeholder").not.toHaveProperty(
      "pagination",
    );
  });

  // Owner decision 2026-10-13 #2 — a caller cannot choose the identifier a
  // support ticket quotes. Their X-Request-Id is a span attribute only.
  it("an inbound X-Request-Id is NOT the identifier", async () => {
    const supplied = "req-from-the-caller-0001";
    const response = await otpRequest({ "x-request-id": supplied });
    const body = response.json<{ meta: { request_id: string } }>();

    expect(body.meta.request_id).not.toBe(supplied);
    expect(body.meta.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers["x-request-id"], "the trace id is what is echoed").toBe(body.meta.request_id);
  });

  it("a request identifier is generated when the caller supplies none, and echoed", async () => {
    const response = await otpRequest();
    const body = response.json<{ meta: { request_id: string } }>();

    expect(body.meta.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers["x-request-id"]).toBe(body.meta.request_id);
  });

  it("two requests receive different generated identifiers", async () => {
    const first = (await otpRequest()).json<{ meta: { request_id: string } }>();
    const second = (await otpRequest()).json<{ meta: { request_id: string } }>();

    expect(first.meta.request_id).not.toBe(second.meta.request_id);
  });
});

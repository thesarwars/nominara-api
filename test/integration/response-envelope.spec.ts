import { describe, expect, it } from "vitest";
import { envelopeMetaSchema } from "../../contracts/common/envelope.schema.js";
import { apiUrl } from "../support/api-url.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-024 T8 (RED step) — story scenario 8 and AC5/AC8. Red until T10
// adds the response-envelope interceptor: no route wraps its body today.
//
// *** NFR-API-08 IS SPLIT, AND THIS FILE PROVES ONLY ONE HALF ***
// AC8 reads "The request identifier IS the trace identifier, so a support
// ticket resolves to a single trace with no lookup step."
//
//   Provable here: every response carries `meta.request_id`; an inbound
//   `X-Request-Id` (§1's optional header) is honoured rather than replaced;
//   one is generated when absent; and the value is echoed back on the
//   response so a client can quote it.
//
//   NOT provable here, and deliberately not claimed: that the value IS an
//   OpenTelemetry trace identifier. This repository has no OpenTelemetry —
//   no `@opentelemetry/*` dependency, no trace_id anywhere in src/, and
//   src/lib/telemetry/metrics.ts is a Logger shim whose own comment says no
//   metrics library exists. `req.id` is Fastify's `req-N` counter. That half
//   of AC8 is pending STORY-005 (telemetry, unmerged) and must be reported
//   as pending — never ticked off the back of a green run of this file.
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

  // §1: "`X-Request-Id` — optional. Echoed in responses and logs; generated
  // if absent." Honouring an inbound value is what lets a caller correlate
  // its own log with the API's without a lookup step.
  it("an inbound X-Request-Id is honoured, not replaced", async () => {
    const supplied = "req-from-the-caller-0001";
    const response = await otpRequest({ "x-request-id": supplied });
    const body = response.json<{ meta: { request_id: string } }>();

    expect(body.meta.request_id).toBe(supplied);
    expect(response.headers["x-request-id"], "the identifier must be echoed on the response").toBe(supplied);
  });

  it("a request identifier is generated when the caller supplies none, and echoed", async () => {
    const response = await otpRequest();
    const body = response.json<{ meta: { request_id: string } }>();

    expect(body.meta.request_id).toBeTruthy();
    expect(response.headers["x-request-id"]).toBe(body.meta.request_id);
  });

  it("two requests receive different generated identifiers", async () => {
    const first = (await otpRequest()).json<{ meta: { request_id: string } }>();
    const second = (await otpRequest()).json<{ meta: { request_id: string } }>();

    expect(first.meta.request_id).not.toBe(second.meta.request_id);
  });
});

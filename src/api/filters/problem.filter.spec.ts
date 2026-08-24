import type { ArgumentsHost } from "@nestjs/common";
import { HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { problemDetailsSchema } from "../../../contracts/common/problem-details.schema.js";
import {
  EmailNotVerifiedException,
  EmailOtpInvalidException,
  EntitlementStaleException,
  NotAMemberException,
  OauthFailedException,
  TenantContextMissingError,
  WorkspaceSuspendedException,
} from "../../tenancy/errors.js";
import { InsufficientCreditsError, StepUpRequiredError } from "../errors/domain-errors.js";
import { ProblemFilter } from "./problem.filter.js";

const REQUEST_ID = "req-42";

function makeHost(headers: Record<string, string> = {}): {
  host: ArgumentsHost;
  status: ReturnType<typeof vi.fn>;
  header: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const header = vi.fn(() => ({ send }));
  const status = vi.fn(() => ({ header, send }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ id: REQUEST_ID, headers }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, header, send };
}

function bodyFrom(exception: unknown, headers?: Record<string, string>): Record<string, unknown> {
  const { host, send, header } = makeHost(headers);
  new ProblemFilter().catch(exception, host);
  expect(header).toHaveBeenCalledWith("content-type", "application/problem+json; charset=utf-8");
  return send.mock.calls[0]![0] as Record<string, unknown>;
}

// STORY-024 T9 — decision D2's dual shape, replacing STORY-022's flat stub.
describe("STORY-024 · ProblemFilter emits RFC 9457 plus the `error` extension member", () => {
  it("a domain error produces a body satisfying problemDetailsSchema", () => {
    const body = bodyFrom(
      new StepUpRequiredError({ message: "re-authenticate to continue", details: { methods: ["passkey"] } }),
    );

    const parsed = problemDetailsSchema.safeParse(body);
    expect(parsed.success, `body must satisfy the published contract: ${JSON.stringify(body)}`).toBe(true);
    expect(body.status).toBe(401);
    expect((body.error as Record<string, unknown>).code).toBe("step_up_required");
  });

  it("§2's title convention — the code in title case, not the HTTP status name", () => {
    const body = bodyFrom(new InsufficientCreditsError({ message: "not enough credits" }));
    expect(body.title).toBe("Insufficient Credits");
  });

  it("code and details live under `error`, never flat at the top level", () => {
    const body = bodyFrom(new StepUpRequiredError({ details: { methods: ["passkey"] } }));

    expect(body).not.toHaveProperty("code");
    expect(body).not.toHaveProperty("details");
    expect((body.error as Record<string, unknown>).details).toEqual({ methods: ["passkey"] });
  });

  it("carries the request identifier, honouring an inbound X-Request-Id", () => {
    expect((bodyFrom(new StepUpRequiredError()).error as Record<string, unknown>).request_id).toBe(REQUEST_ID);
    expect(
      (bodyFrom(new StepUpRequiredError(), { "x-request-id": "from-caller" }).error as Record<string, unknown>)
        .request_id,
    ).toBe("from-caller");
  });

  it("carries the code's remediation so a client can act without a second request", () => {
    const error = bodyFrom(new InsufficientCreditsError()).error as Record<string, unknown>;
    expect(error.remediation).toEqual({ kind: "purchase_credits" });
  });
});

// The six codes thrown inside src/ that §2 does not contain. Mapped at this
// boundary so the guards and their existing tests keep their own vocabulary.
describe("STORY-024 · decision D12 — out-of-taxonomy codes are mapped on the way out", () => {
  const CASES = [
    { name: "NotAMemberException", make: () => new NotAMemberException(), code: "forbidden", reason: "not_a_member" },
    {
      name: "WorkspaceSuspendedException",
      make: () => new WorkspaceSuspendedException(),
      code: "forbidden",
      reason: "workspace_suspended",
    },
    {
      name: "EntitlementStaleException",
      make: () => new EntitlementStaleException(),
      code: "unauthenticated",
      reason: "entitlement_stale",
    },
    {
      name: "EmailNotVerifiedException",
      make: () => new EmailNotVerifiedException(),
      code: "forbidden",
      reason: "email_not_verified",
    },
    {
      name: "OauthFailedException",
      make: () => new OauthFailedException("req-1"),
      code: "validation_failed",
      reason: "oauth_failed",
    },
    {
      name: "EmailOtpInvalidException",
      make: () => new EmailOtpInvalidException(),
      code: "validation_failed",
      reason: "otp_invalid",
    },
  ] as const;

  it.each(CASES)("$name goes out as $code, keeping reason=$reason", ({ make, code, reason }) => {
    const error = bodyFrom(make()).error as Record<string, unknown>;

    expect(error.code).toBe(code);
    expect((error.details as Record<string, unknown>).reason, "the original condition must survive").toBe(reason);
  });

  it("the class itself is untouched — it still throws its own vocabulary", () => {
    const thrown = new NotAMemberException().getResponse() as { code: string };
    expect(thrown.code, "src/tenancy/errors.ts must keep working unchanged").toBe("not_a_member");
  });

  it("merges reason into details the thrower already supplied rather than replacing them", () => {
    const error = bodyFrom(new OauthFailedException("req-9")).error as Record<string, unknown>;
    expect(error.details).toEqual({ request_id: "req-9", reason: "oauth_failed" });
  });
});

describe("STORY-024 · errors outside the taxonomy", () => {
  // §2's table has no row for an unexpected 5xx, so there is no code to put
  // in an `error` member. Such a response carries RFC 9457's members plus a
  // top-level request_id — a 500 is exactly when a user needs a reference to
  // quote, so the identifier stays even though the taxonomy code cannot.
  it("a generic Error is a 500 that leaks no internal message but still identifies the request", () => {
    const body = bodyFrom(new Error("raw internal detail"));

    expect(body).toEqual({
      type: "about:blank",
      title: "INTERNAL_SERVER_ERROR",
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: "internal server error",
      request_id: REQUEST_ID,
    });
  });

  it("TenantContextMissingError (a plain Error, not an HttpException) is a well-formed 500", () => {
    const body = bodyFrom(new TenantContextMissingError("req.tenant is unset"));
    expect(body.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.detail).toBe("internal server error");
  });

  // A framework-raised HttpException predates the taxonomy and still has to
  // land on a §2 code, because §2 is the only vocabulary the wire has.
  it("a bare HttpException is given the taxonomy code its status implies", () => {
    const error = bodyFrom(new HttpException("nope", HttpStatus.FORBIDDEN)).error as Record<string, unknown>;
    expect(error.code).toBe("forbidden");
  });
});

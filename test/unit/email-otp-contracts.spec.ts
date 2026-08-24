import { describe, expect, it } from "vitest";
import { emailOtpRequestSchema } from "../../contracts/identity/email-otp-request.schema.js";
import { emailOtpVerifyRequestSchema } from "../../contracts/identity/email-otp-verify-request.schema.js";
import { emailOtpRequestResponseSchema } from "../../contracts/identity/email-otp-request-response.schema.js";

describe("STORY-016 · emailOtpRequestSchema", () => {
  it("accepts a well-formed request", () => {
    expect(emailOtpRequestSchema.safeParse({ email: "user@example.com" }).success).toBe(true);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(emailOtpRequestSchema.safeParse({ email: "user@example.com", extra: "x" }).success).toBe(false);
  });

  it("rejects an invalid email", () => {
    expect(emailOtpRequestSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  it("rejects a missing email", () => {
    expect(emailOtpRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts an email with surrounding whitespace and mixed case", () => {
    expect(emailOtpRequestSchema.safeParse({ email: " User@Example.com " }).success).toBe(true);
  });
});

describe("STORY-016 · emailOtpVerifyRequestSchema", () => {
  const valid = { email: "user@example.com", code: "12345678" };

  it("accepts a well-formed verify request with an 8-digit code", () => {
    expect(emailOtpVerifyRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(emailOtpVerifyRequestSchema.safeParse({ ...valid, extra: "x" }).success).toBe(false);
  });

  it("rejects an invalid email", () => {
    expect(emailOtpVerifyRequestSchema.safeParse({ ...valid, email: "not-an-email" }).success).toBe(false);
  });

  it("rejects a 7-digit code", () => {
    expect(emailOtpVerifyRequestSchema.safeParse({ ...valid, code: "1234567" }).success).toBe(false);
  });

  it("rejects a 9-digit code", () => {
    expect(emailOtpVerifyRequestSchema.safeParse({ ...valid, code: "123456789" }).success).toBe(false);
  });

  it("rejects a non-numeric 8-character code", () => {
    expect(emailOtpVerifyRequestSchema.safeParse({ ...valid, code: "1234abcd" }).success).toBe(false);
  });

  it("accepts an email with surrounding whitespace and mixed case", () => {
    expect(
      emailOtpVerifyRequestSchema.safeParse({ ...valid, email: " User@Example.com " }).success,
    ).toBe(true);
  });
});

describe("STORY-016 · emailOtpRequestResponseSchema", () => {
  const valid = { status: "sent", expires_in_seconds: 600 } as const;

  it("accepts the fixed uniform body", () => {
    expect(emailOtpRequestResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(emailOtpRequestResponseSchema.safeParse({ ...valid, request_id: "x" }).success).toBe(false);
  });

  it("rejects a status other than 'sent'", () => {
    expect(emailOtpRequestResponseSchema.safeParse({ ...valid, status: "queued" }).success).toBe(false);
  });

  it("rejects an expires_in_seconds other than 600", () => {
    expect(emailOtpRequestResponseSchema.safeParse({ ...valid, expires_in_seconds: 300 }).success).toBe(false);
  });
});

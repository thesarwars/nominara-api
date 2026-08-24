import { Logger } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoggingEmailSenderAdapter } from "../../src/modules/identity/adapters/logging-email-sender.adapter.js";

const ENV = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  DATABASE_URL_POOLED: "postgres://u:p@localhost:6432/db",
  WEBAUTHN_RP_ID: "localhost",
  WEBAUTHN_RP_NAME: "Nominara",
  WEBAUTHN_ORIGIN: "http://localhost:3000",
  AUTH_TOKEN_ED25519_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEIDBtSyhPpdvfpMewjjRZhs0QItLs53aiIaned1RhI6d1",
  AUTH_TOKEN_ED25519_PUBLIC_KEY: "MCowBQYDK2VwAyEAYbvU26OMhfsHxRMPLxXokTTSWtx06/lxhf1L0gnFBoM=",
  AUTH_TOKEN_ED25519_KID: "test-kid-1",
  CSRF_SECRET: "test-csrf-secret",
  WORKSPACE_DEK_WRAPPING_KEY: Buffer.alloc(32, 7).toString("base64"),
  OAUTH_REDIRECT_BASE_URL: "https://api.example.com",
  OAUTH_STATE_SECRET: "test-oauth-state-secret",
  OTP_EMAIL_HASH_PEPPER: "test-otp-email-hash-pepper",
  OTP_EMAIL_FROM: "Nominara <no-reply@nominara.test>",
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GITHUB_OAUTH_CLIENT_ID: "github-client-id",
  MICROSOFT_OAUTH_CLIENT_ID: "microsoft-client-id",
};

describe("STORY-016 · LoggingEmailSenderAdapter — never logs the code or body", () => {
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });

  it("the logged output never contains the plaintext code passed through the port", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const adapter = new LoggingEmailSenderAdapter();
    const plaintextCode = "48213907";

    await adapter.send({
      to: "user@example.com",
      subject: "Your Nominara sign-in code",
      textBody: `Your sign-in code is ${plaintextCode}. It expires in 10 minutes.`,
    });

    expect(logSpy).toHaveBeenCalled();
    for (const call of logSpy.mock.calls) {
      const serialized = call.map((arg) => String(arg)).join(" ");
      expect(serialized).not.toContain(plaintextCode);
      expect(serialized).not.toContain("user@example.com");
    }
    logSpy.mockRestore();
  });

  // STORY-016 fix 4 (code-reviewer finding) — OTP_EMAIL_FROM was required
  // and unit-tested for presence in env.schema.ts but never actually read
  // anywhere; the logged line should reflect what a real send would use.
  it("the logged output includes OTP_EMAIL_FROM as the from address", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const adapter = new LoggingEmailSenderAdapter();

    await adapter.send({
      to: "user@example.com",
      subject: "Your Nominara sign-in code",
      textBody: "Your sign-in code is 12345678. It expires in 10 minutes.",
    });

    expect(logSpy).toHaveBeenCalled();
    const serialized = logSpy.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
    expect(serialized).toContain(ENV.OTP_EMAIL_FROM);
    logSpy.mockRestore();
  });
});

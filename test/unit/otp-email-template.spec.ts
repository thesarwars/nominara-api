import { describe, expect, it } from "vitest";
import { renderOtpEmail } from "../../src/modules/identity/otp-email-template.js";

describe("STORY-016 · renderOtpEmail", () => {
  const rendered = renderOtpEmail({ code: "48213907", expiresInMinutes: 10 });

  it("contains the code", () => {
    expect(rendered.textBody).toContain("48213907");
  });

  it("states the expiry", () => {
    expect(rendered.textBody).toMatch(/10 minutes/);
  });

  it("does not contain a UUID (user id / session id / workspace id)", () => {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(rendered.subject).not.toMatch(uuidPattern);
    expect(rendered.textBody).not.toMatch(uuidPattern);
  });

  it("does not contain a sign-in link or URL", () => {
    expect(rendered.subject).not.toMatch(/https?:\/\//i);
    expect(rendered.textBody).not.toMatch(/https?:\/\//i);
  });

  it("does not contain account-status wording", () => {
    const accountStatusPattern = /account (does not|doesn't) exist|no account|active account|suspended|unverified|verified/i;
    expect(rendered.textBody).not.toMatch(accountStatusPattern);
  });

  it("does not contain a workspace-name placeholder", () => {
    expect(rendered.textBody.toLowerCase()).not.toContain("workspace");
  });
});

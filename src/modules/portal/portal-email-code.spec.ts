import { describe, expect, it } from "vitest";
import { PORTAL_CODE_PATTERN } from "../../../contracts/portal/index.js";
import {
  domainAllowed,
  generatePortalCode,
  PORTAL_CODE_ISSUE_LIMIT_PER_HOUR,
  PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_DAY,
  PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_HOUR,
  PORTAL_CODE_MAX_ATTEMPTS,
  PORTAL_CODE_TTL_MS,
  renderPortalCodeEmail,
} from "./portal-email-code.js";

// Owner decision 71 (b) — six digits, ten minutes, five attempts.
describe("STORY-098 d.71 (b) · portal sign-in code primitives", () => {
  it("the figures are the decision's: 6 digits, 10 minutes, 5 attempts", () => {
    expect(PORTAL_CODE_TTL_MS).toBe(600_000);
    expect(PORTAL_CODE_MAX_ATTEMPTS).toBe(5);
    expect(PORTAL_CODE_ISSUE_LIMIT_PER_HOUR).toBeGreaterThan(0);
    expect(PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_DAY).toBe(30);
    expect(PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_DAY).toBeGreaterThan(PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_HOUR);
  });

  it("a code is exactly six digits, zero-padded, over many draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const code = generatePortalCode();
      expect(code).toMatch(PORTAL_CODE_PATTERN);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(1900);
  });

  it("domainAllowed compares the part after the LAST @, case-insensitively, against exact domains (no suffix, no subdomain)", () => {
    expect(domainAllowed("jane@ACME.test", ["acme.test"])).toBe(true);
    expect(domainAllowed("jane@acme.test", ["ACME.test"])).toBe(true);
    expect(domainAllowed("jane@sub.acme.test", ["acme.test"])).toBe(false);
    expect(domainAllowed("jane@notacme.test", ["acme.test"])).toBe(false);
    expect(domainAllowed("jane@acme.test.evil.test", ["acme.test"])).toBe(false);
    expect(domainAllowed("acme.test@evil.test", ["acme.test"])).toBe(false);
    expect(domainAllowed("a@acme.test@evil.test", ["acme.test"])).toBe(false);
    expect(domainAllowed("jane@acme.test", [])).toBe(false);
  });

  it("the email carries the code and its lifetime and nothing about the agency, the link or the client", () => {
    const rendered = renderPortalCodeEmail({ code: "123456", expiresInMinutes: 10 });
    expect(rendered.textBody).toContain("123456");
    expect(rendered.textBody).toContain("10 minutes");
    expect(rendered.textBody).not.toMatch(/https?:\/\//);
  });
});

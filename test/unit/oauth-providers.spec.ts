import { describe, expect, it } from "vitest";
import {
  OAUTH_PROVIDER_ENDPOINTS,
  resolveGithubVerifiedEmail,
  resolveGoogleVerifiedEmail,
  resolveMicrosoftVerifiedEmail,
} from "../../src/lib/auth/oauth-providers.js";

// QA-ADDED: src/lib/auth/oauth-providers.ts had ZERO test coverage. These
// three resolvers ARE the AC4 fail-closed decision.
describe("STORY-015 · resolveGoogleVerifiedEmail — threshold/below/above", () => {
  it("email_verified === true -> verified", () => {
    expect(resolveGoogleVerifiedEmail({ email: "a@example.com", email_verified: true })).toEqual({
      email: "a@example.com",
      emailVerified: true,
    });
  });
  it("email_verified === false -> unverified", () => {
    expect(resolveGoogleVerifiedEmail({ email: "a@example.com", email_verified: false }).emailVerified).toBe(false);
  });
  it("email_verified ABSENT -> unverified (fails closed)", () => {
    expect(resolveGoogleVerifiedEmail({ email: "a@example.com" }).emailVerified).toBe(false);
  });
  it('email_verified as the STRING "true" -> unverified (no truthiness coercion)', () => {
    expect(
      resolveGoogleVerifiedEmail({ email: "a@example.com", email_verified: "true" as unknown as boolean })
        .emailVerified,
    ).toBe(false);
  });
  it("email absent -> null email, unverified", () => {
    expect(resolveGoogleVerifiedEmail({})).toEqual({ email: null, emailVerified: false });
  });
});

describe("STORY-015 · resolveMicrosoftVerifiedEmail — threshold/below/above", () => {
  it("xms_edov === true -> verified", () => {
    expect(resolveMicrosoftVerifiedEmail({ email: "a@example.com", xms_edov: true }).emailVerified).toBe(true);
  });
  it("xms_edov ABSENT -> unverified (documented Microsoft default)", () => {
    expect(resolveMicrosoftVerifiedEmail({ email: "a@example.com" }).emailVerified).toBe(false);
  });
  it("xms_edov === false -> unverified", () => {
    expect(resolveMicrosoftVerifiedEmail({ email: "a@example.com", xms_edov: false }).emailVerified).toBe(false);
  });
  it("email_verified === true WITHOUT xms_edov -> STILL unverified (Microsoft's claim must not count)", () => {
    expect(resolveMicrosoftVerifiedEmail({ email: "a@example.com", email_verified: true }).emailVerified).toBe(false);
  });
});

describe("STORY-015 · resolveGithubVerifiedEmail — threshold/below/above", () => {
  it("primary && verified -> that email, verified", () => {
    expect(
      resolveGithubVerifiedEmail([
        { email: "alt@example.com", primary: false, verified: true },
        { email: "main@example.com", primary: true, verified: true },
      ]),
    ).toEqual({ email: "main@example.com", emailVerified: true });
  });
  it("primary but NOT verified -> that email, unverified", () => {
    expect(resolveGithubVerifiedEmail([{ email: "main@example.com", primary: true, verified: false }])).toEqual({
      email: "main@example.com",
      emailVerified: false,
    });
  });
  it("verified but NOT primary -> unverified (never promoted to verified)", () => {
    expect(resolveGithubVerifiedEmail([{ email: "alt@example.com", primary: false, verified: true }])).toEqual({
      email: "alt@example.com",
      emailVerified: false,
    });
  });
  it("empty list -> null email, unverified", () => {
    expect(resolveGithubVerifiedEmail([])).toEqual({ email: null, emailVerified: false });
  });
  it("a verified non-primary entry never leaks past an UNVERIFIED primary", () => {
    const result = resolveGithubVerifiedEmail([
      { email: "attacker@example.com", primary: false, verified: true },
      { email: "victim@example.com", primary: true, verified: false },
    ]);
    expect(result).toEqual({ email: "victim@example.com", emailVerified: false });
  });
});

describe("STORY-015 · OAUTH_PROVIDER_ENDPOINTS — no http:// and every provider covered", () => {
  it("all three providers present, every endpoint https", () => {
    const urls: string[] = [];
    for (const key of ["google", "github", "microsoft"] as const) {
      const e = OAUTH_PROVIDER_ENDPOINTS[key];
      expect(e, key).toBeDefined();
      urls.push(e.authorizationEndpoint);
      if (e.isOidc) urls.push(e.issuerUrl);
      else urls.push(e.serverMetadata.token_endpoint, e.userEndpoint, e.userEmailsEndpoint);
    }
    for (const url of urls) expect(url.startsWith("https://"), url).toBe(true);
  });
  it("google requests the email scope; microsoft too; github requests user:email", () => {
    expect(OAUTH_PROVIDER_ENDPOINTS.google.scope).toContain("email");
    expect(OAUTH_PROVIDER_ENDPOINTS.microsoft.scope).toContain("email");
    expect(OAUTH_PROVIDER_ENDPOINTS.github.scope).toContain("user:email");
  });
});

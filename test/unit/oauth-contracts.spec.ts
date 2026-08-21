import { describe, expect, it } from "vitest";
import { oauthProviderSchema } from "../../contracts/identity/oauth-provider.schema.js";
import { oauthStartResponseSchema } from "../../contracts/identity/oauth-start-response.schema.js";
import { oauthCallbackQuerySchema } from "../../contracts/identity/oauth-callback-query.schema.js";
import { oauthCallbackResponseSchema } from "../../contracts/identity/oauth-callback-response.schema.js";

const NOW_ISO = "2026-08-21T00:00:00.000Z";

describe("STORY-015 · oauthProviderSchema", () => {
  it("accepts each of the three supported providers", () => {
    for (const provider of ["google", "github", "microsoft"]) {
      expect(oauthProviderSchema.safeParse(provider).success, provider).toBe(true);
    }
  });

  it("rejects an unknown provider", () => {
    expect(oauthProviderSchema.safeParse("facebook").success).toBe(false);
  });
});

describe("STORY-015 · oauthStartResponseSchema", () => {
  const valid = {
    authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
    state_expires_at: NOW_ISO,
  };

  it("accepts a well-formed start response", () => {
    expect(oauthStartResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(oauthStartResponseSchema.safeParse({ ...valid, code_verifier: "x" }).success).toBe(false);
  });

  it("rejects a non-URL authorization_url", () => {
    expect(oauthStartResponseSchema.safeParse({ ...valid, authorization_url: "not-a-url" }).success).toBe(false);
  });
});

describe("STORY-015 · oauthCallbackQuerySchema", () => {
  it("accepts a minimal successful callback (state + code)", () => {
    expect(oauthCallbackQuerySchema.safeParse({ state: "s", code: "c" }).success).toBe(true);
  });

  it("rejects a callback missing state", () => {
    expect(oauthCallbackQuerySchema.safeParse({ code: "c" }).success).toBe(false);
  });

  it("tolerates an unknown extra query param — providers append params we don't model (scope, authuser, prompt, hd, session_state)", () => {
    const result = oauthCallbackQuerySchema.safeParse({
      state: "s",
      code: "c",
      scope: "email profile",
      authuser: "0",
      prompt: "consent",
      hd: "example.com",
      session_state: "abc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a provider-error callback carrying error/error_description instead of code", () => {
    const result = oauthCallbackQuerySchema.safeParse({
      state: "s",
      error: "access_denied",
      error_description: "the user denied the request",
    });
    expect(result.success).toBe(true);
  });
});

describe("STORY-015 · oauthCallbackResponseSchema", () => {
  it("accepts every outcome/user_status combination", () => {
    for (const outcome of ["signed_in", "linked"] as const) {
      for (const user_status of ["active", "unverified"] as const) {
        expect(oauthCallbackResponseSchema.safeParse({ outcome, user_status }).success).toBe(true);
      }
    }
  });

  it("rejects an unrecognized key (.strict())", () => {
    expect(
      oauthCallbackResponseSchema.safeParse({ outcome: "signed_in", user_status: "active", request_id: "x" }).success,
    ).toBe(false);
  });

  it("rejects an unknown outcome value", () => {
    expect(oauthCallbackResponseSchema.safeParse({ outcome: "created", user_status: "active" }).success).toBe(false);
  });
});

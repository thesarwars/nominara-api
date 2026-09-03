import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// STORY-127 — the options a ceremony is created with and the rules it is
// verified against must agree.
//
// security-and-tenancy.md §11's auth-methods table and STORY-014's AC both
// specify user verification "preferred". createRegistrationOptions asked for
// exactly that, and then verifyRegistrationResponse was called without
// `requireUserVerification` — which @simplewebauthn/server defaults to TRUE.
//
// The result was that every authenticator declining UV, which "preferred"
// explicitly permits, was refused with "User verification was required, but
// user could not be verified" AFTER the browser had already created and
// saved the passkey. The user was left with a credential the server had no
// record of, and a sign-in that then failed with "unknown or revoked
// credential" — two confusing errors for one misconfiguration.
//
// A source assertion rather than a behavioural one: reproducing it needs a
// real authenticator that declines UV, which no unit test has.

const SOURCE = readFileSync("src/modules/identity/identity.service.ts", "utf8");

describe("STORY-127 · passkey user verification matches the spec", () => {
  it("asks for `preferred` when creating options — the spec's word, in two places", () => {
    expect(SOURCE).toMatch(/userVerification:\s*"preferred"/);
    expect(SOURCE).not.toMatch(/userVerification:\s*"required"/);
  });

  it("both verify calls pass requireUserVerification explicitly", () => {
    // The library's default is true. Leaving it off is what broke this, and
    // an implicit default is exactly what should not decide a documented
    // policy.
    const occurrences = SOURCE.match(/requireUserVerification:\s*false/g) ?? [];
    expect(occurrences, "one for registration, one for assertion").toHaveLength(2);
  });

  it("neither verify call demands user verification", () => {
    expect(SOURCE).not.toMatch(/requireUserVerification:\s*true/);
  });
});

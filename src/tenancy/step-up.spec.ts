import { describe, expect, it } from "vitest";
import { STEP_UP_WINDOW_MS } from "./constants.js";
import { StepUpRequiredException } from "./errors.js";
import { assertStepUpFresh } from "./step-up.js";

// STORY-173 — the one definition of "fresh" shared by RbacGuard and
// IdentityService (adding a passkey).
describe("STORY-173 · assertStepUpFresh", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");

  it("passes for a strong authentication just now", () => {
    expect(() => assertStepUpFresh(new Date(now), now)).not.toThrow();
  });

  it("passes at exactly the window (closed interval)", () => {
    expect(() => assertStepUpFresh(new Date(now - STEP_UP_WINDOW_MS), now)).not.toThrow();
  });

  it("is refused one millisecond past the window, naming the acceptable methods", () => {
    try {
      assertStepUpFresh(new Date(now - STEP_UP_WINDOW_MS - 1), now);
      expect.fail("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(StepUpRequiredException);
      expect((error as StepUpRequiredException).getResponse()).toMatchObject({
        code: "step_up_required",
        details: { methods: ["webauthn", "email_otp"] },
      });
    }
  });

  it("fails closed for a session that never re-authenticated (null)", () => {
    expect(() => assertStepUpFresh(null, now)).toThrow(StepUpRequiredException);
  });
});

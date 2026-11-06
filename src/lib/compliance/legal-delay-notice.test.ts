import { describe, expect, it } from "vitest";
import { LEGAL_DELAY_NOTICE_DRAFT, LEGAL_DELAY_NOTICE_DRAFT_MARKER } from "./legal-delay-notice.js";

// Owner decision 70(f): the subject-facing "erasure delayed for a legal reason" text exists as a DRAFT, marked so, until legal has reviewed it.
describe("decision 70(f) - the legal-delay notice draft", () => {
  it("opens with the draft marker, names the request id placeholder, and says the erasure is delayed and will run", () => {
    expect(LEGAL_DELAY_NOTICE_DRAFT_MARKER).toBe("Draft — pending legal review");
    expect(LEGAL_DELAY_NOTICE_DRAFT.startsWith(LEGAL_DELAY_NOTICE_DRAFT_MARKER)).toBe(true);
    expect(LEGAL_DELAY_NOTICE_DRAFT).toContain("{{request_id}}");
    expect(LEGAL_DELAY_NOTICE_DRAFT).toMatch(/delayed for a legal reason/);
    expect(LEGAL_DELAY_NOTICE_DRAFT).toMatch(/released or expires/);
  });
  it("carries no subject data and no matter detail", () => {
    expect(LEGAL_DELAY_NOTICE_DRAFT).not.toMatch(/@|workspace [0-9a-f]{8}/i);
  });
});

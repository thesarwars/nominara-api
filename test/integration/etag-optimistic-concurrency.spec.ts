import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseIfMatch } from "../../src/api/etag/if-match.js";
import { useApiHarness } from "../support/api-harness.js";

// STORY-024 T8 (RED step) — story scenarios 6 and 7, AC7. RED at module
// resolution until T11 creates src/api/etag/if-match.ts.
//
// §1: "`If-Match: <etag>` — on PATCH of mutable config. Optimistic
// concurrency on `projects`, `tracked_prompts`, `share_tokens`." None of
// those three resources has an endpoint yet, so this task applies the
// mechanism to `PATCH /v1/workspaces/{id}` — the one mutable-configuration
// PATCH that exists (the plan's T11 scope, deliberately narrow).
//
// The HTTP half needs a real session, which this file does not mint; those
// cases are marked and assert the helper's contract instead, so a green run
// is never read as "the route enforces it". T11 wires the route and extends
// test/integration/workspace-mutations-audit.spec.ts, which already has the
// credential machinery, with the end-to-end 409.
describe("STORY-024 · AC7 — a stale concurrency tag is refused, a current one succeeds", () => {
  useApiHarness();

  it("parses a strong ETag from an If-Match header", () => {
    expect(parseIfMatch('"abc123"')).toEqual(["abc123"]);
  });

  it("parses a list, because a client may offer several", () => {
    expect(parseIfMatch('"a", "b"')).toEqual(["a", "b"]);
  });

  // RFC 9110 §13.1.1: `If-Match: *` means "any current representation",
  // i.e. succeed if the resource exists at all. Collapsing it to a literal
  // tag would silently reject every such request.
  it("treats * as the wildcard it is, not as a tag literally named *", () => {
    expect(parseIfMatch("*")).toBe("*");
  });

  // A weak validator cannot be used for optimistic concurrency: W/ means
  // "semantically equivalent", which is exactly the guarantee a lost-update
  // check must not accept.
  it("refuses a weak validator for If-Match", () => {
    expect(() => parseIfMatch('W/"abc123"')).toThrow();
    // Guards against a VACUOUS pass while T11's stub throws for every input.
    expect(() => parseIfMatch('"abc123"')).not.toThrow();
  });

  it("refuses a malformed or empty header rather than treating it as absent", () => {
    for (const header of ["", "abc123", '"unterminated', "  "]) {
      expect(() => parseIfMatch(header), `"${header}" must be refused, not silently ignored`).toThrow();
    }
    expect(() => parseIfMatch('"well-formed"'), "a well-formed tag must still parse").not.toThrow();
  });

  // The distinction that makes AC7 meaningful: a MISSING If-Match is a
  // different case from a STALE one. Missing may be rejected as
  // precondition-required; stale must be a 409 conflict. Conflating them
  // makes the error unactionable.
  it("distinguishes an absent header from a stale tag", () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch(`"${randomUUID()}"`)).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseIfMatch } from "../../src/api/etag/if-match.js";

// STORY-024 T8 (RED step), relocated in T12 — the `If-Match` PARSER's
// contract (RFC 9110 §13.1.1). Nothing here touches Postgres, HTTP, or the
// Nest container, and it no longer pretends to.
//
// As an integration spec this file called useApiHarness() and DISCARDED the
// return value: it paid for a Postgres container, a schema drop, a full
// migrateUp and an entire ApiModule boot PER TEST — six times — to assert
// that parseIfMatch('"abc123"') returns ["abc123"]. Its describe claimed
// "a stale concurrency tag is refused, a current one succeeds" and neither
// half was exercised anywhere in it; a header comment said the HTTP cases
// were "marked", and no case was marked. That is the same shape as the
// cursor spec that asserted expect(101).toBeGreaterThan(100).
//
// AC7's HTTP half is proven for real in
// test/integration/workspace-mutations-audit.spec.ts (stale → 409, current
// → 200 with a new tag, missing → 422, weak → 400), and the concurrency
// half in test/integration/etag-lost-update-concurrency.spec.ts.
describe("STORY-024 · the If-Match parser's contract (RFC 9110 §13.1.1)", () => {

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

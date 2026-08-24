import { ConflictError, PreconditionUnmetError, ValidationFailedError, type DomainError } from "../errors/domain-errors.js";

// STORY-024 T11 — parses the `If-Match` request header (RFC 9110 §13.1.1)
// and enforces the precondition it carries.
//
// Returns the parsed strong validators, the literal wildcard `"*"` ("any
// current representation"), or undefined when the header is absent — an
// ABSENT If-Match and a STALE one are different conditions and must stay
// distinguishable to the caller. Conflating them makes the error
// unactionable: one is "you forgot the precondition", the other is
// "someone else changed the resource while you were editing it".

// RFC 9110 §8.8.3:
//   entity-tag = [ weak ] opaque-tag
//   opaque-tag = DQUOTE *etagc DQUOTE
//   etagc      = %x21 / %x23-7E / obs-text
// i.e. any visible character except DQUOTE itself, plus obs-text. Note that
// `,` (%x2C) IS a legal etagc — which is why this parses with a scanner
// rather than `header.split(",")`. A naive split would tear one tag
// containing a comma into two malformed halves and refuse a valid header.
const ENTITY_TAG_AT_START = /^(W\/)?"([\x21\x23-\x7E\x80-\xFF]*)"/;
const OPTIONAL_WHITESPACE_AT_START = /^[ \t]*/;

function malformed(reason: string): DomainError {
  return new ValidationFailedError({
    message: "malformed If-Match header",
    details: { issues: [{ path: ["If-Match"], message: reason }] },
  });
}

/**
 * Parses `If-Match`. Throws on a header that is present but not a valid
 * `If-Match` — a malformed precondition is refused, never silently treated
 * as an absent one, because "I sent a precondition you ignored" is the one
 * outcome optimistic concurrency must never produce.
 */
export function parseIfMatch(header: string | undefined): string[] | "*" | undefined {
  if (header === undefined) return undefined;

  let rest = header.replace(OPTIONAL_WHITESPACE_AT_START, "").trimEnd();
  if (rest.length === 0) {
    throw malformed("header is present but empty");
  }
  if (rest === "*") return "*";

  const tags: string[] = [];
  for (;;) {
    const match = ENTITY_TAG_AT_START.exec(rest);
    if (match === null) {
      throw malformed(`expected a quoted entity-tag at "${rest.slice(0, 16)}"`);
    }
    // A weak validator means "semantically equivalent", which is exactly the
    // guarantee a lost-update check must not accept — and RFC 9110 §13.1.1
    // says If-Match uses the strong comparison function, so W/ is not merely
    // discouraged here, it is unusable.
    if (match[1] !== undefined) {
      throw malformed("a weak validator (W/) cannot be used for If-Match");
    }
    tags.push(match[2]!);

    rest = rest.slice(match[0].length).replace(OPTIONAL_WHITESPACE_AT_START, "");
    if (rest.length === 0) break;
    if (!rest.startsWith(",")) {
      throw malformed(`expected "," between entity-tags at "${rest.slice(0, 16)}"`);
    }
    rest = rest.slice(1).replace(OPTIONAL_WHITESPACE_AT_START, "");
    if (rest.length === 0) {
      throw malformed("trailing comma with no entity-tag after it");
    }
  }
  return tags;
}

/**
 * Enforces the precondition against the tag the resource currently has.
 *
 * Callers MUST have taken a row lock before computing `currentTag` and MUST
 * perform the write in the same transaction — otherwise this is a
 * check-then-act race and the conflict it exists to detect can happen in the
 * window between them.
 *
 * The two failures are deliberately different codes:
 *   absent  422 `precondition_unmet` — the request never carried one.
 *   stale   409 `conflict` — api-specification.md §2 pins this exactly:
 *           "409 | `conflict` | `If-Match` mismatch, unique violation, or
 *           state-machine violation".
 */
export function assertIfMatch(parsed: string[] | "*" | undefined, currentTag: string): void {
  if (parsed === undefined) {
    throw new PreconditionUnmetError({
      message: "this endpoint requires an If-Match header carrying the current ETag",
    });
  }
  // `*` is "any current representation" — the caller asserts the resource
  // exists, which it does, or currentTag could not have been computed.
  if (parsed === "*") return;

  if (!parsed.includes(currentTag)) {
    throw new ConflictError({
      message: "the resource was modified since the ETag you supplied was issued",
    });
  }
}

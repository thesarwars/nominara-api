// STORY-078 AC12 - `If-None-Match` on a GET (RFC 9110 section 13.1.2): "I already hold a representation with one of these tags".
//
// The comparison is the WEAK one (section 8.8.3.2) - a `W/` prefix is ignored on both sides - because a GET precondition only saves a
// transfer; it can never lose an update (contrast `If-Match`, src/api/etag/if-match.ts, which must be strong). A header that does not
// parse is treated as ABSENT, never as an error: the safe answer to "I could not read your validator" on a read is to send the
// representation, and refusing a GET over a mangled cache header would turn a bandwidth optimisation into an outage.
const ENTITY_TAG_AT_START = /^(?:W\/)?"([\x21\x23-\x7E\x80-\xFF]*)"/;

export function ifNoneMatchMatches(header: string | undefined, currentTag: string): boolean {
  if (header === undefined) return false;
  let rest = header.trim();
  if (rest === "*") return true;
  while (rest.length > 0) {
    const match = ENTITY_TAG_AT_START.exec(rest);
    if (match === null) return false;
    if (match[1] === currentTag) return true;
    rest = rest.slice(match[0].length).replace(/^[ \t]*,[ \t]*/u, "");
    if (rest.startsWith(",")) return false;
  }
  return false;
}

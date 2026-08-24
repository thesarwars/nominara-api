// STORY-024 task T11's job, deliberately NOT implemented here — same
// "real signature, throwing body" shape as src/api/pagination/cursor.ts.
//
// Returns the parsed strong validators, the literal wildcard `"*"`
// (RFC 9110 §13.1.1: "any current representation"), or undefined when the
// header is absent — an ABSENT If-Match and a STALE one are different
// conditions and must stay distinguishable to the caller.
export function parseIfMatch(_header: string | undefined): string[] | "*" | undefined {
  throw new Error("parseIfMatch() is not implemented yet — STORY-024 task T11.");
}

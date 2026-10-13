import { z } from "zod";

// STORY-150 AC7 — the one spelling of a uuid that crosses the request boundary.
//
// RFC 4122 uuids are case-insensitive on input and lowercase on output. A path param is made canonical by
// CanonicalParamsGuard before anything reads it; a BODY or QUERY uuid is read by no guard, and zod's `.uuid()`
// accepts uppercase, so a field would otherwise keep the client's spelling while Postgres (a `uuid` column
// lowercases whatever it is given) and every `Map` or `===` in the application disagree about what it was.
// `prompt_ids` on POST /v1/projects/{id}/prompts/activate was the live instance: the row was found, then
// looked up by its uppercase spelling and reported as "no such prompt in this project".
//
// `.overwrite()` and not `.transform()`, for the reason pagination.schema.ts measured: a transform makes the
// schema unrepresentable in JSON Schema on the output side and reshapes it on the input side, whereas
// `.overwrite()` is a same-type check, so the published document is byte-identical to a bare `z.uuid()` and
// `@nominara/client` types do not move.
//
// ONLY the canonical 8-4-4-4-12 shape is accepted (that is what `z.uuid()` matches); a braced, hyphenless or
// mis-hyphenated spelling that Postgres would cast is refused with a 400, as it is for a path param.
export const lowercaseUuidSchema = z.uuid().overwrite((value) => value.toLowerCase());

export type LowercaseUuid = z.infer<typeof lowercaseUuidSchema>;

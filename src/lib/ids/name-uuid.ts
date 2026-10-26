import { createHash } from "node:crypto";

// STORY-066 AC7 — a deterministic milestone source id.
//
// `ux_milestones_source` is unique over (source_type, source_id) ACROSS ALL
// PROJECTS, and the configuration pins (`engine_model_change`,
// `prompt_set_change`, `source_seeded`) have no row of their own to point at.
// Each one is named instead: the same event always yields the same id, so a
// rollup re-run or a redelivery hits the unique index and pins nothing more,
// and the project id is always one of the parts, so the same model change
// seen on two projects pins once on EACH rather than colliding.
//
// An RFC 9562 version-5 (SHA-1, name-based) UUID under a fixed Nominara
// namespace. Not a secret and not a security boundary — only a stable name.

/** Fixed namespace for every milestone source name. Changing it would re-pin every configuration event once. */
const MILESTONE_SOURCE_NAMESPACE = "6f1c2a8e-0b7d-4e4a-9d3c-5a1e7b2c9f10";

/**
 * The UUID naming `parts`. Each part is LENGTH-PREFIXED before hashing, so
 * `("ab","c")` and `("a","bc")` — the same text split differently — are
 * different names.
 */
export function nameUuid(...parts: readonly string[]): string {
  const name = parts.map((part) => `${String(Buffer.byteLength(part, "utf8"))}.${part}`).join("");
  const hash = createHash("sha1")
    .update(Buffer.from(MILESTONE_SOURCE_NAMESPACE.replaceAll("-", ""), "hex"))
    .update(name, "utf8")
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

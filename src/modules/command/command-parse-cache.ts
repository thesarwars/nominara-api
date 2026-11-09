import { createHash } from "node:crypto";
import { tenantKey } from "../../lib/cache/valkey-keys.js";

// STORY-085-A — api-specification.md §10: the parse is cached by
// `sha256(normalized_query | workspace_id | entity_index_version)` for 24 h.

/**
 * The `entity_index_version` of the key. This slice has no entity index (it
 * binds slots from the text alone), so the version names the grammar: bumping
 * it when a rule changes retires every cached answer the old rules gave.
 * When the trigram entity index lands it supplies the real version here.
 */
export const PARSE_INDEX_VERSION = "grammar-2";

export const PARSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * `{env}:{workspace_id}:command-parse:{sha256}`. The workspace is both a key
 * segment (the tenant boundary — Valkey has no RLS) and part of the hashed
 * material, as the reference states it.
 */
export function parseCacheKey(env: string, workspaceId: string, normalized: string, indexVersion: string): string {
  const digest = createHash("sha256").update(`${normalized}|${workspaceId}|${indexVersion}`).digest("hex");
  return tenantKey(env, workspaceId, "command-parse", digest);
}

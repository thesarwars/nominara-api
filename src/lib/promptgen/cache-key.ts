import { createHash } from "node:crypto";
import { tenantKey } from "../cache/valkey-keys.js";
import { GRAMMAR_VERSION } from "./archetypes.js";

// STORY-045 — §8's L5 prompt-generation template cache.
//
//   | L5 | Prompt-generation template cache | Valkey only,
//     sha256(topic_norm|locale|grammar_version) | 30 d | ~60% of generation calls |
//
// TENANT-SCOPED, via tenantKey(). ISO-13 scopes every cache key to its
// tenant and grants exactly ONE exception — `{env}:global:capture:`, which is
// excepted because an L1 entry holds an engine's public answer to a public
// question and carries nothing tenant-derived. An L5 entry is keyed on a
// CUSTOMER'S TOPIC and holds the naturalised phrasing generated for their
// project, so it is not covered by that exception and must not borrow it.
//
// The ~60% hit rate §8 targets is therefore per-workspace, not cross-tenant.
// That is the correct reading: two workspaces in the same category would
// otherwise share naturalised prompt text derived from one of their topics.

export interface L5CacheKeyInput {
  readonly env: string;
  readonly workspaceId: string;
  /** Already through `normalizeTopic` — §4 step 1's output, not a raw topic. */
  readonly topicNorm: string;
  readonly locale: string;
  /** Defaults to the live grammar. Overridable so a test can prove the key moves with it. */
  readonly grammarVersion?: string;
}

export function l5TemplateCacheKey(input: L5CacheKeyInput): string {
  // A length-prefixed join, the same defence l1-cache-key.ts documents: `a|b`
  // and `ab|` must not hash alike, or a topic containing the separator can
  // impersonate a different locale or grammar version.
  const parts = [input.topicNorm, input.locale, input.grammarVersion ?? GRAMMAR_VERSION];
  const material = parts.map((part) => `${String(part.length)}:${part}`).join("|");
  const digest = createHash("sha256").update(material).digest("hex");

  return tenantKey(input.env, input.workspaceId, "promptgen", "l5", digest);
}

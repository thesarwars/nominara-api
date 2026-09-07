import { createHash } from "node:crypto";
import { globalKey } from "../cache/valkey-keys.js";

// STORY-032 — tracking-engine.md §6's L1 exact-hash key.
//
//   sim:v3:{sha256(engine_key | adapter_major | prompt_text_hash | locale
//                  | persona_hint | floor(now / ttl_bucket))}
//
// *** THIS KEY IS DELIBERATELY CROSS-TENANT. ***
//
// §6 is explicit: "all tenants asking the same question in the same window
// share one capture — the single largest cost lever, and the reason the key
// is built from prompt TEXT rather than prompt ID." An entry holds an
// engine's public answer to a public question. Entity matching, scoring and
// storage all happen per tenant AFTER the read, so nothing tenant-derived
// may enter here.
//
// TWO OPPOSITE FAILURES, and the input type is what prevents both:
//
//   Leak. A tenant identifier in this key would place tenant-derived data in
//   a namespace ISO-13 excepts from its tenant-scoping rule — and it excepts
//   `global:capture:` precisely BECAUSE the value carries none. The exception
//   is only sound while that stays true.
//
//   Fragmentation. A key that varies per workspace when it must not destroys
//   the sharing silently: nothing fails, no test goes red, and the only
//   symptom is a bill that grows and a suppression rate nobody can explain.
//
// `L1KeyInput` therefore has no workspace, project, actor or prompt-ID field,
// and capture-l1-cache-key.spec.ts asserts that absence directly rather than
// trusting this comment.
//
// A workspace flagged `no_shared_cache` (plans.entitlements) does not get a
// per-tenant variant of this key — it BYPASSES L1 entirely. Salting the key
// per workspace would look like the same thing and quietly pollute the shared
// namespace with entries only one tenant can ever hit.

/** The `sim:v3` version segment. Bump when the key's INPUTS change, or an old entry answers a new question. */
const L1_KEY_VERSION = "v3";

export interface L1KeyInput {
  /**
   * The DEPLOYMENT namespace — `cacheKeyNamespace()`.
   *
   * This key shipped without one, on the reasoning that "the cache instance
   * is already separate per environment". That is the exact assumption
   * key-namespace.ts says in writing this repository refuses to rely on,
   * because STORY-026 found a REALIZED cross-environment leak from it. Two
   * deployments sharing a cache instance would share answers: a staging run
   * with stubbed adapters writes a fixture answer, and a production run in
   * the same TTL bucket hits it and stores it for a paying tenant. Nothing
   * downstream could tell. Found by the second-engineer review.
   */
  readonly env: string;
  readonly engineKey: string;
  /** Major only: a patch release answers the same question, a major may not. §6's "an adapter upgrade invalidates the cache". */
  readonly adapterMajor: number;
  /** The prompt's TEXT, never its id — see above. Normalised below. */
  readonly promptText: string;
  readonly locale: string;
  readonly personaHint: string | null;
  /** This ENGINE's `cache_ttl_seconds`, so a volatile engine shares over a shorter window than a stable one. */
  readonly ttlSeconds: number;
  readonly nowMs: number;
}

/**
 * The floored sharing window.
 *
 * Exported because it is the half most worth asserting on its own: get it
 * wrong and every tenant still shares, but over the wrong period — too long
 * and a volatile engine serves stale answers, too short and the cost lever
 * quietly stops working.
 */
export function l1TimeBucket(nowMs: number, ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(
      `L1 cache key: ttlSeconds must be a positive number (got ${String(ttlSeconds)}) — ` +
        "a zero or negative TTL collapses every window into one eternal bucket that never invalidates",
    );
  }
  return Math.floor(nowMs / (ttlSeconds * 1_000));
}

/**
 * Trivial typing differences must not fragment the cache.
 *
 * Two tenants who independently wrote the same question should share, and
 * "Best CRM" versus "best crm" is the same question to an engine. Lowercased
 * and whitespace-collapsed only — nothing that could change meaning.
 *
 * EXPORTED for STORY-045's `promptTextHash`, which computes
 * `tracked_prompts.text_hash`. `schemas/projects-and-prompts.md` documents
 * that column as both the dedupe key and part of THIS key, so the two must
 * normalise identically: a second, more aggressive normalisation there would
 * dedupe two prompts that this key then treats as different questions —
 * reporting a duplicate that never shares a capture, with the cost lever
 * quietly degraded and no test going red. Exported rather than duplicated
 * for exactly the reason this file's header gives about fragmentation.
 */
export function normalizePromptText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/u, " ").replace(/\s+/gu, " ");
}

export function captureL1Key(input: L1KeyInput): string {
  const bucket = l1TimeBucket(input.nowMs, input.ttlSeconds);
  // A length-prefixed join, not a plain separator. `a|b` and `ab|` must not
  // hash alike — a prompt containing the separator would otherwise be able to
  // impersonate a different engine or locale.
  const parts = [
    input.engineKey,
    String(input.adapterMajor),
    normalizePromptText(input.promptText),
    input.locale,
    input.personaHint ?? "",
    String(bucket),
  ];
  const material = parts.map((part) => `${String(part.length)}:${part}`).join("|");
  const digest = createHash("sha256").update(material).digest("hex");

  // Built through globalKey(), which is the designated constructor for
  // "platform-wide, never tenant data" and takes `env` unconditionally. The
  // result is `{env}:global:capture:sim:v3:{digest}` — the `{env}:global:`
  // namespace three references name as the single documented ISO-13
  // exception, with the `capture:` segment ISO-13's own classifier excepts
  // by name.
  //
  // Sharing still spans TENANTS, which is the cost lever. It no longer spans
  // DEPLOYMENTS, which was never the lever and only ever a hazard.
  return globalKey(input.env, "capture", "sim", L1_KEY_VERSION, digest);
}

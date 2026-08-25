// STORY-026 audit fix — the `{env}` segment of every cache key, resolved in ONE
// place.
//
// It was `process.env.NODE_ENV ?? "development"`, read at two call sites. That
// is wrong twice over: NODE_ENV is one of development|test|production, so it
// cannot name a deployment at all — a staging environment runs as "production"
// and shares production's idempotency records and rate-limit counters, key for
// key. And a value read straight from process.env bypasses the schema that
// validates every other setting.
//
// `CACHE_KEY_NAMESPACE` names the DEPLOYMENT when it is set; NODE_ENV is the
// fallback for local work, where "development" is genuinely the whole answer.
// The primary isolation is still a separate Valkey instance per environment —
// this is defence in depth, and defence in depth that cannot distinguish
// staging from production is not defence at all.
// Read from process.env rather than loadEnv(): this runs on EVERY request, and
// making the hot path re-validate the whole environment would be a cost paid
// per request for a value that cannot change. Both variables are still in the
// schema and in KNOWN_KEYS, so a malformed one is a failed boot exactly as
// before — the validation happens once, at startup, where it belongs.
export function cacheKeyNamespace(): string {
  const namespace = process.env.CACHE_KEY_NAMESPACE;
  if (namespace !== undefined && namespace.trim().length > 0) return namespace;
  return process.env.NODE_ENV ?? "development";
}

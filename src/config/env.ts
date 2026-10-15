import { envSchema, type Env } from "./env.schema.js";

// STORY-022-E-4. Test scenario 6: "Start with a required configuration value
// missing → Refuses to start, naming the value." Thrown at import/bootstrap
// time (src/main.ts, src/worker.ts, src/gateway.ts all call loadEnv() before
// anything else), never discovered lazily on first use.
export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

// STORY-127 — exported so test/unit/env.spec.ts can pin it against the
// schema's own shape. A variable added to envSchema but forgotten here is
// silently dropped before parsing: the process boots, the setting appears to
// have no effect, and nothing says why. That happened to OTP_DEV_LOG_CODES
// while it was being written.
export const KNOWN_KEYS = [
  "NODE_ENV",
  "PORT",
  "GATEWAY_PORT",
  "DATABASE_URL",
  "DATABASE_URL_POOLED",
  "WORKER_GROUP",
  "WEBAUTHN_RP_ID",
  "WEBAUTHN_RP_NAME",
  "WEBAUTHN_ORIGIN",
  "AUTH_TOKEN_ED25519_PRIVATE_KEY",
  "AUTH_TOKEN_ED25519_PUBLIC_KEY",
  "AUTH_TOKEN_ED25519_KID",
  "AUTH_TOKEN_ED25519_PREVIOUS_PUBLIC_KEY",
  "AUTH_TOKEN_ED25519_PREVIOUS_KID",
  "CSRF_SECRET",
  "REALTIME_ALLOWED_ORIGINS",
  "WORKSPACE_DEK_WRAPPING_KEY",
  "WORKSPACE_KMS_KEY_ARN",
  "REFRESH_TOKEN_GRACE_WINDOW_MS",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "MICROSOFT_OAUTH_CLIENT_ID",
  "MICROSOFT_OAUTH_CLIENT_SECRET",
  "OAUTH_REDIRECT_BASE_URL",
  "OAUTH_STATE_SECRET",
  "OTP_EMAIL_HASH_PEPPER",
  "VALKEY_CACHE_URL",
  "CACHE_KEY_NAMESPACE",
  "TRUST_PROXY_HOPS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_TRACES_SAMPLER_ARG",
  "OTP_EMAIL_FROM",
  "OTP_DEV_LOG_CODES",
  "RETENTION_PURGE_ENABLED",
  "QUEUE_REDIS_URL",
  "QUEUE_JOB_SIGNING_KEY",
  "QUEUE_JOB_SIGNING_KID",
  "QUEUE_JOB_SIGNING_PREVIOUS_KEY",
  "QUEUE_JOB_SIGNING_PREVIOUS_KID",
  "ENGINE_TOKEN_BUCKETS",
  "ENGINE_SPEND_CEILINGS_USD",
  "GEMINI_API_KEY",
  "GEMINI_REQUESTS_PER_MINUTE",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PUBLISHABLE_KEY",
  "PORTAL_COOKIE_KEY",
  "DATABASE_URL_PORTAL",
  "STORAGE_ENDPOINT",
  "STORAGE_REGION",
  "STORAGE_BUCKET_RAW",
  "STORAGE_BUCKET_REPORTS",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_SSE",
  "STORAGE_KMS_KEY_ID",
  "STORAGE_KEY_ENV",
] as const;

/**
 * process.env carries many OS/CI-supplied keys that are none of this
 * schema's business (PATH, HOME, ...) — picking only the keys the schema
 * knows about before parsing lets envSchema stay `.strict()` (catching a
 * typo IN THIS FILE'S OWN key list) without rejecting the ambient
 * environment wholesale, which would make every process unbootable.
 */
function pickKnown(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of KNOWN_KEYS) {
    if (source[key] !== undefined) {
      picked[key] = source[key];
    }
  }
  return picked;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(pickKnown(source));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new EnvValidationError(`invalid environment configuration:\n  ${issues.join("\n  ")}`);
  }
  return result.data;
}

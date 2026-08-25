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

const KNOWN_KEYS = [
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
  "WORKSPACE_DEK_WRAPPING_KEY",
  "WORKSPACE_KMS_KEY_ARN",
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
  "OTP_EMAIL_FROM",
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

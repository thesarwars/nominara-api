import { z } from "zod";

// STORY-022-E-4 — configuration validation lives here, as zod (already a
// dependency), NOT Joi/class-validator/@nestjs/config. coding-standards.md
// §2: "zod is the single source." Validating at boot (env.ts) rather than at
// first use converts a missing/malformed value into a failed deploy instead
// of a customer-visible incident.

// A required string that also rejects "" and whitespace-only values — a
// plain z.string().min(1) would accept " " (length 1), silently letting a
// blank-but-present env var through.
const requiredString = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "must not be empty or whitespace-only" });

export const WORKER_GROUPS = ["capture", "parse", "crawl", "embed", "rollup", "report"] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // src/main.ts — the HTTP entry point's listen port.
    PORT: z.coerce.number().int().positive().default(3000),
    // src/gateway.ts — the WebSocket gateway's listen port.
    GATEWAY_PORT: z.coerce.number().int().positive().default(3001),
    // Migration/DDL connection — direct to Postgres, never through pgBouncer (docker-compose.yml).
    DATABASE_URL: requiredString,
    // Application connection — through pgBouncer in transaction-pooling mode (STORY-010).
    DATABASE_URL_POOLED: requiredString,
    // src/worker.ts — selects which of the 6 queue groups this worker process serves.
    WORKER_GROUP: z.enum(WORKER_GROUPS).optional(),

    // STORY-014 — WebAuthn relying-party identity. Read at ceremony-options
    // and verify time (never hardcoded), so a credential minted against one
    // environment's rpID/origin fails verification against another's.
    WEBAUTHN_RP_ID: requiredString,
    WEBAUTHN_RP_NAME: requiredString,
    WEBAUTHN_ORIGIN: requiredString,

    // STORY-014 — the access token's EdDSA (Ed25519) signing keypair, each
    // base64-encoded DER (PKCS8 private / SPKI public) — single-line, so no
    // PEM-newline escaping is needed in a .env file.
    AUTH_TOKEN_ED25519_PRIVATE_KEY: requiredString,
    AUTH_TOKEN_ED25519_PUBLIC_KEY: requiredString,
    // STORY-017 — kid identifying the current signing key (goes in the JWS
    // protected header, never the claim payload). The previous key/kid pair
    // is optional and only present during a rotation's overlap window — a
    // token signed with it must still verify for its remaining lifetime.
    AUTH_TOKEN_ED25519_KID: requiredString,
    AUTH_TOKEN_ED25519_PREVIOUS_PUBLIC_KEY: requiredString.optional(),
    AUTH_TOKEN_ED25519_PREVIOUS_KID: requiredString.optional(),
    // STORY-017 — HMAC-SHA256(sid, secret) double-submit CSRF token secret.
    CSRF_SECRET: requiredString,

    // STORY-021-E-10 — LocalDekProvisioner's wrapping key (AES-256-GCM,
    // node:crypto only, no KMS). Base64-encoded, exactly 32 bytes so it is
    // usable directly as an AES-256 key.
    WORKSPACE_DEK_WRAPPING_KEY: requiredString.refine(
      (value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      },
      { message: "must be base64-encoded and decode to exactly 32 bytes" },
    ),
    // Recorded verbatim into workspace_keys.kms_key_arn — no KMS story
    // exists yet, so "local:dev" is the honest default rather than a
    // fabricated ARN shape.
    WORKSPACE_KMS_KEY_ARN: requiredString.default("local:dev"),
  })
  .strict();

export type Env = z.infer<typeof envSchema>;

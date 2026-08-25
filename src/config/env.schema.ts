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

    // STORY-015 — OAuth 2.1 + PKCE (Google, GitHub, Microsoft), via
    // `openid-client`. Provider credentials are OPTIONAL config: every test
    // fakes the provider at a port boundary (same pattern as STORY-014's
    // WebAuthn mocking), so the suite stays green with zero real
    // credentials, and real credentials arrive later gating only manual
    // end-to-end verification, never the merge.
    GOOGLE_OAUTH_CLIENT_ID: requiredString.optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: requiredString.optional(),
    GITHUB_OAUTH_CLIENT_ID: requiredString.optional(),
    GITHUB_OAUTH_CLIENT_SECRET: requiredString.optional(),
    MICROSOFT_OAUTH_CLIENT_ID: requiredString.optional(),
    MICROSOFT_OAUTH_CLIENT_SECRET: requiredString.optional(),
    // The base URL each provider's redirect_uri is built from — the
    // callback path (auth/oauth/:provider/callback) is appended to this
    // value at runtime, never hardcoded, so a callback minted for one
    // environment cannot be replayed against another's.
    OAUTH_REDIRECT_BASE_URL: requiredString,
    // Signs the state parameter (security-and-tenancy.md §5: "signed,
    // single-use, short-lived, and bound to the initiating session"). A NEW
    // secret, distinct from CSRF_SECRET — key separation, so rotating one
    // never silently affects the other.
    OAUTH_STATE_SECRET: requiredString,

    // STORY-016 — email OTP (fallback sign-in). Peppers the rate-limit
    // ledger's email hash (security-and-tenancy.md §5 "Email OTP") — an
    // email address is not high-entropy, so an unpeppered hash would let
    // anyone with DB read access dictionary-attack the ledger to confirm who
    // requested a code. A NEW secret, distinct from CSRF_SECRET and
    // OAUTH_STATE_SECRET — same key-separation reasoning.
    OTP_EMAIL_HASH_PEPPER: requiredString,
    // Non-secret display string for the delivered email's "from" header,
    // read by the EMAIL_SENDER port's logging adapter — never hardcoded.
    OTP_EMAIL_FROM: requiredString,

    // STORY-025 — the Valkey CACHE instance. system-architecture.md §11
    // mandates two: this one (allkeys-lru, persistence off) for token
    // buckets, idempotency records, locks and memoisation, and a separate
    // QUEUE instance (noeviction, persistence on) for BullMQ, which arrives
    // with STORY-030 as VALKEY_QUEUE_URL. Named for its role rather than
    // VALKEY_URL precisely so the second one cannot quietly land on the
    // first: an eviction policy that discards a queued job is data loss,
    // and one that refuses to evict a cache is an outage.
    // A URL, validated here rather than at first use — this schema exists so a
    // malformed value is a failed deploy instead of a customer-visible
    // incident, and `requiredString` alone accepted anything non-blank.
    VALKEY_CACHE_URL: requiredString.refine((value) => URL.canParse(value), {
      message: "must be a valid connection URL, e.g. redis://host:6379",
    }),

    // STORY-025, corrected by STORY-026's audit — the key namespace for the
    // cache.
    //
    // It defaults to NODE_ENV, and NODE_ENV CANNOT EXPRESS A DEPLOYMENT. It is
    // one of development|test|production, so a staging deployment either fails
    // to boot or runs as "production" — and then shares production's
    // idempotency records and rate-limit counters key for key. The original
    // claim that the `{env}` segment kept staging out of production's data was
    // simply false as built.
    //
    // The PRIMARY boundary is still a separate Valkey instance per environment
    // (VALKEY_CACHE_URL). This is defence in depth, and it exists so an
    // environment that does share an instance can still be separated — set it
    // to something that names the deployment, not its build mode.
    CACHE_KEY_NAMESPACE: requiredString.optional(),

    // STORY-026 audit fix — how many trusted proxies sit in front of this
    // process.
    //
    // Fastify's `request.ip` is the IMMEDIATE PEER unless told otherwise.
    // Behind any load balancer that is the balancer, so every §12 per-IP
    // bucket collapses onto one key: `auth` at 30/min becomes thirty sign-ins
    // per minute for the ENTIRE PLATFORM, across all tenants. That is a
    // platform-wide sign-in outage on the first deploy behind an ingress.
    //
    // A HOP COUNT, never `trustProxy: true`. Bare `true` trusts the whole
    // X-Forwarded-For chain, so any caller can forge a header and land in a
    // fresh bucket — which turns a denial-of-service bug into a trivial
    // evasion, strictly worse than what it replaced. The count says how many
    // proxies YOU operate; everything beyond them is caller-supplied and
    // ignored.
    //
    // UNSET MEANS NO PROXY, and that is the safe default rather than a
    // convenient one: with no value the peer address is used, which is correct
    // when nothing sits in front and merely coarse when something does.
    TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export type Env = z.infer<typeof envSchema>;

import { z } from "zod";
import { engineKeySchema } from "../lib/engines/contract.js";

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

// STORY-030 — "deploy" added alongside the original six: deploy.cms
// (src/lib/queue/topology.ts) is a documented worker group too, and
// WORKER_GROUP must accept every group that actually owns a queue.
export const WORKER_GROUPS = ["capture", "parse", "crawl", "embed", "rollup", "report", "deploy"] as const;

// STORY-031 D7 — per-engine token-bucket shape. Exported so
// src/lib/engines/token-bucket.ts parses ENGINE_TOKEN_BUCKETS against the
// SAME schema this boot-time check uses, rather than a second hand-derived
// one that could silently drift from it.
const engineTokenBucketEntrySchema = z
  .object({
    capacity: z.number().int().positive(),
    refillPerSecond: z.number().positive(),
  })
  .strict();
// `z.record` over a zod enum key demands an entry for EVERY enum member
// (zod 4 semantics) — wrong here, since only some engine keys are active
// (src/lib/engines/registry.ts) and a deployer configures only those.
// `z.partialRecord` is the exhaustive-but-optional-per-key form.
export const engineTokenBucketsSchema = z.partialRecord(engineKeySchema, engineTokenBucketEntrySchema);
export type EngineTokenBuckets = z.infer<typeof engineTokenBucketsSchema>;

// STORY-031 D13 — optional per-engine monthly spend ceiling, in USD. Not a
// persisted `numeric(12,2)` money column — a config-level threshold compared
// against a Valkey-metered running total (src/lib/engines/spend-meter.ts).
export const engineSpendCeilingsSchema = z.partialRecord(engineKeySchema, z.number().positive());
export type EngineSpendCeilings = z.infer<typeof engineSpendCeilingsSchema>;

/** Well-formed JSON parsing against `schema` — used by refine() below since a refine can only report true/false, never transform. */
function parsesAgainst(schema: z.ZodTypeAny, value: string): boolean {
  try {
    return schema.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // src/main.ts — the HTTP entry point's listen port.
    // 4000 — the port this project's API runs on. Deliberately NOT 3000:
    // that is the frontend's (Next.js's own default), and the two run side by
    // side in development. WEBAUTHN_ORIGIN and REALTIME_ALLOWED_ORIGINS still
    // name port 3000 because they are BROWSER origins, not this service's
    // address.
    PORT: z.coerce.number().int().positive().default(4000),
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

    // STORY-026 — the socket handshake's Origin allow-list, comma-separated.
    //
    // Optional HERE and mandatory in the gateway, which is the only process
    // that opens sockets. Making it globally required forced the API, the
    // worker and the one-shot migrate container to carry a key none of them
    // reads, and would fail a deployment for omitting configuration
    // irrelevant to it.
    //
    // That is NOT a soft default. src/gateway/gateway.module.ts's provider
    // throws when it is missing or empty, so the gateway does not start
    // without an allow-list — the check cannot quietly become a no-op, which
    // is the failure this codebase keeps finding. The requirement lives with
    // the thing that needs it.
    REALTIME_ALLOWED_ORIGINS: requiredString.optional(),

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

    // STORY-127 — opt in to DevEmailSenderAdapter, which logs the one-time
    // code IN PLAINTEXT so email-OTP sign-in can be completed on a
    // developer's machine. Without it the code is unrecoverable: an 8-digit
    // CSPRNG draw, argon2id-hashed at rest, with no provider wired to
    // deliver it.
    //
    // Off unless set to exactly "true" — a typo, "1", or "yes" leaves it
    // off rather than guessing, because guessing wrong here prints a
    // credential. It is ALSO refused outright under NODE_ENV=production, by
    // this schema and again by the adapter's own constructor: two
    // independent checks, because one that can be refactored away is the
    // failure this codebase keeps finding.
    OTP_DEV_LOG_CODES: z.literal("true").optional(),

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
    // evasion, strictly worse than what it replaced.
    //
    // ⚠ COUNT THE HOPS THAT **APPEND** TO X-FORWARDED-FOR, AND DO NOT COUNT
    // A HOP THAT MERELY RELAYS ONE. Read literally this is "how many entries
    // at the right-hand end of the chain did equipment I operate write". A
    // relaying hop — nominara-app, which forwards the chain it received
    // verbatim (lib/api/forwarded-for.ts) — writes no entry and consumes no
    // count, because `proxy-addr` starts from the socket peer and that peer
    // IS the relaying hop. So `browser → ingress → nominara-app → api` is
    // ONE, not two.
    //
    // ⚠ AND AN OFF-BY-ONE HERE IS INVISIBLE IN TESTING. With honest traffic
    // through one appending ingress, 1 and 2 return the same address; 2 only
    // diverges once someone prepends a forged entry, and then it returns
    // theirs. Verified in test/unit/trust-proxy.spec.ts against the real
    // proxy-addr rather than reasoned about.
    //
    // ⚠ NOTHING APPENDING IN FRONT? THEN THIS MUST STAY UNSET. Any value at
    // all makes the rightmost entry of a caller-authored header authoritative,
    // which is total forgery of every ip bucket and of every audit row's
    // `actorIp`.
    //
    // UNSET MEANS NO PROXY, and that is the safe default rather than a
    // convenient one: with no value the peer address is used, which is correct
    // when nothing sits in front and merely coarse when something does.
    TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().optional(),

    // STORY-030 — the queue instance's dedicated Valkey connection
    // (system-architecture.md §4/§11: "never the cache instance"). BullMQ/
    // ioredis connect here.
    QUEUE_REDIS_URL: requiredString,
    // Rotating HMAC-SHA256 key signing every tenant-scoped job payload
    // (src/lib/queue/signing.ts), base64-encoded, exactly 32 bytes — same
    // shape as WORKSPACE_DEK_WRAPPING_KEY above. QUEUE_JOB_SIGNING_KID
    // identifies the current key; the previous key/kid pair is optional
    // and only present during a rotation's overlap window, so a job
    // signed with it still verifies for the window's duration.
    QUEUE_JOB_SIGNING_KEY: requiredString.refine(
      (value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      },
      { message: "must be base64-encoded and decode to exactly 32 bytes" },
    ),
    QUEUE_JOB_SIGNING_KID: requiredString,
    QUEUE_JOB_SIGNING_PREVIOUS_KEY: requiredString
      .refine(
        (value) => {
          try {
            return Buffer.from(value, "base64").length === 32;
          } catch {
            return false;
          }
        },
        { message: "must be base64-encoded and decode to exactly 32 bytes" },
      )
      .optional(),
    QUEUE_JOB_SIGNING_PREVIOUS_KID: requiredString.optional(),

    // STORY-031 D6 (revised) — token buckets, the breaker's shared state,
    // and everything else this story puts on the cache tier live on the
    // SAME cache instance STORY-025 already declared above (VALKEY_CACHE_URL)
    // — not a second, redundant instance. Original D6 built a duplicate
    // CACHE_REDIS_URL before EPIC-03 (which shipped first) was in this
    // branch's history; consolidated onto VALKEY_CACHE_URL once EPIC-03
    // merged, so system-architecture.md §11's "two Valkey instances, not
    // three" is what's actually deployed. NEVER the queue instance above
    // (QUEUE_REDIS_URL).
    // STORY-031 D7 — per-engine token-bucket capacity/refill rate is
    // undocumented anywhere in the spec, so it is injected config, never a
    // baked-in default number in src/lib/engines/token-bucket.ts.
    ENGINE_TOKEN_BUCKETS: requiredString.refine((value) => parsesAgainst(engineTokenBucketsSchema, value), {
      message: "must be a JSON object mapping engine keys to { capacity: positive int, refillPerSecond: positive number }",
    }),
    // STORY-031 D13 — optional: undocumented dollar ceilings, injected only
    // when known. Absent entirely (or absent for one engine key) disables
    // ONLY that engine's 100% hard stop; 80%/95% alerting still runs.
    ENGINE_SPEND_CEILINGS_USD: requiredString
      .refine((value) => parsesAgainst(engineSpendCeilingsSchema, value), {
        message: "must be a JSON object mapping engine keys to a positive USD ceiling",
      })
      .optional(),
  })
  .strict()
  // STORY-127 — the first of the two checks that keep plaintext one-time
  // codes out of a production build. The adapter's constructor is the
  // second; this one refuses at BOOT, so the process never starts rather
  // than starting and printing a credential on the first sign-in attempt.
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.OTP_DEV_LOG_CODES === "true") {
      ctx.addIssue({
        code: "custom",
        path: ["OTP_DEV_LOG_CODES"],
        message:
          "OTP_DEV_LOG_CODES logs one-time codes in plaintext and cannot be enabled under NODE_ENV=production.",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

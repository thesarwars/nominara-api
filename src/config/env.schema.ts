import { z } from "zod";
import { engineKeySchema } from "../lib/engines/contract.js";
import { REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS, REFRESH_TOKEN_GRACE_WINDOW_HARD_MAX_MS } from "../lib/auth/refresh-token.js";

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

const EMAIL_ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** A bare email address. Deliberately loose: Resend, not this regex, is the authority on deliverability. */
export function isEmailAddress(value: string): boolean {
  return EMAIL_ADDRESS.test(value);
}

/** `address` or `Display Name <address>` — the two shapes Resend accepts for `from`. */
export function isSenderIdentity(value: string): boolean {
  const bracketed = /^[^<>]+<([^<>]+)>$/.exec(value);
  return isEmailAddress(bracketed ? bracketed[1]!.trim() : value);
}

// A compose file passes `KEY=` for an unset optional variable; that is "not configured", not a malformed value.
const blankIsUnset = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? undefined : value);

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

/**
 * E2E-B6 — the ceilings that apply when ENGINE_SPEND_CEILINGS_USD does not name an engine. The
 * engines with a real adapter (gemini, and the two SerpApi Google surfaces of STORY-029) are the
 * ones that spend real money, so each gets a placeholder (USD/month): gemini 100 pending owner
 * decision O9; google_aio / google_ai_mode 5 each pending the owner's figure (250 Free-plan
 * searches at the metered $0.015 is $3.75 across both). A configured entry always wins; an engine
 * with no default has NO alerts and NO hard stop (spend-meter.ts computes both only when a ceiling exists).
 */
export const DEFAULT_ENGINE_SPEND_CEILINGS_USD: EngineSpendCeilings = { gemini: 100, google_aio: 5, google_ai_mode: 5 };

/** The effective ceilings: defaults, overridden per engine by the configured JSON (already validated at boot). */
export function resolveEngineSpendCeilings(configuredJson: string | undefined): EngineSpendCeilings {
  const configured = configuredJson ? engineSpendCeilingsSchema.parse(JSON.parse(configuredJson)) : {};
  return { ...DEFAULT_ENGINE_SPEND_CEILINGS_USD, ...configured };
}

/** Well-formed JSON parsing against `schema` — used by refine() below since a refine can only report true/false, never transform. */
function parsesAgainst(schema: z.ZodTypeAny, value: string): boolean {
  try {
    return schema.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

/** pgBouncer's documented host port (.env.example, docker-compose.yml `PGBOUNCER_PORT`) and compose service name. */
const PGBOUNCER_HOST_PORT = "6432";
const PGBOUNCER_SERVICE_HOST = "pgbouncer";

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

    // STORY-170 — the refresh-token reuse grace window
    // (security-and-tenancy.md §5 "Session model"). A refresh presenting a
    // token consumed by the session's own immediately-preceding rotation,
    // within this window, gets the identical successor back instead of
    // being treated as reuse. No secret is needed: the successor is held
    // encrypted under a key derived from the predecessor token itself
    // (src/lib/auth/refresh-token.ts), in a Valkey slot whose TTL is this
    // window.
    // How long a consumed token stays grace-eligible. Configurable so an
    // operator can shrink or disable it (0) without a redeploy; capped at
    // REFRESH_TOKEN_GRACE_WINDOW_HARD_MAX_MS (src/lib/auth/refresh-token.ts)
    // so it can never be turned into a de-facto non-rotating token. A value
    // above the cap is REJECTED at boot, never clamped: a clamp would run the
    // process on a window nobody configured.
    // An empty or whitespace-only value is UNSET, not 0. `z.coerce.number()`
    // turns "" into 0, and 0 is the switch that disables grace outright, so
    // `REFRESH_TOKEN_GRACE_WINDOW_MS=` in a deploy template would have turned
    // the feature off with no error and no log line.
    REFRESH_TOKEN_GRACE_WINDOW_MS: z.preprocess(
      (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
      z.coerce
        .number()
        .int()
        .nonnegative()
        .max(REFRESH_TOKEN_GRACE_WINDOW_HARD_MAX_MS)
        .default(REFRESH_TOKEN_GRACE_WINDOW_DEFAULT_MS),
    ),

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

    // Group C — real email through Resend (https://resend.com/docs/api-reference/emails/send-email). When BOTH
    // RESEND_API_KEY and RESEND_FROM_EMAIL are set the EMAIL_SENDER port is bound to ResendEmailSenderAdapter;
    // otherwise today's behaviour (logging adapter, or the OTP_DEV_LOG_CODES dev logger) is unchanged.
    // RESEND_FROM_EMAIL is either `address` or `Display Name <address>`; it must be a sender the Resend account may use
    // (the shared `onboarding@resend.dev` test sender, or an address on a verified domain).
    RESEND_API_KEY: z.preprocess(blankIsUnset, z.string().trim().optional()),
    RESEND_FROM_EMAIL: z.preprocess(
      blankIsUnset,
      z.string().trim().refine(isSenderIdentity, "must be an email address or `Display Name <address>`").optional(),
    ),
    // STORY-178 — the Svix signing secret of the Resend webhook (`POST /v1/webhooks/resend`: bounces and complaints), in
    // Resend's `whsec_<base64>` form. Unset, the route answers 503 `degraded` and writes nothing (fail closed). Under
    // NODE_ENV=production it is REQUIRED whenever Resend is configured (see the superRefine below): without it no bounce or
    // complaint is ever heard, and a bad address would be mailed forever, which is the harm the suppression list exists for.
    RESEND_WEBHOOK_SECRET: z.preprocess(
      blankIsUnset,
      z.string().trim().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/u, "must be a Svix signing secret: `whsec_` followed by base64").optional(),
    ),
    // DEV-ONLY OVERRIDE. Redirects EVERY outgoing message to this one address. Resend's shared test sender can only
    // deliver to the account owner's own address, so a developer sets this to that address and every code, alert and
    // report lands in one inbox. Refused at boot under NODE_ENV=production (see the superRefine below) and again by the
    // adapter's constructor.
    RESEND_TO_EMAIL: z.preprocess(blankIsUnset, z.string().trim().refine(isEmailAddress, "must be an email address").optional()),

    // Group C — where operational alerts (dead-letter depth, engine blackout, parse alarms, audit-chain and wallet
    // mismatches) are emailed, through the same EMAIL_SENDER. Unset: alerts keep their log line and counter and go
    // nowhere else (one line at boot says so).
    ALERT_EMAIL_TO: z.preprocess(blankIsUnset, z.string().trim().refine(isEmailAddress, "must be an email address").optional()),

    // STORY-077 R4 / STORY-013 — switches on the nightly retention purge (`retention.purge`), which HARD-DELETES
    // soft-deleted projects past 30 days and workspaces past their deletion grace. OFF unless exactly "true": a typo,
    // "1" or "yes" is REFUSED at boot rather than guessed at, because guessing wrong here deletes customer data.
    // Leave it off until an object store, the workspace-export sink, the retention-shortening notice and legal hold
    // exist — see src/lib/queue/handlers/retention-purge.handler.ts for why each one matters.
    RETENTION_PURGE_ENABLED: z.literal("true").optional(),

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
    // ⚠ THE AUDIT-CHAIN BLOCKER ON THIS VARIABLE IS LIFTED (STORY-149). A
    // caller who controls `request.ip` could previously send a valid but
    // non-canonical IPv6 literal, have Postgres rewrite it on the way into
    // `audit_log.actor_ip`, and leave THAT TENANT'S chain reporting
    // `hash_mismatch` forever. `AuditChainService.append` now canonicalises
    // through `host()` — the same function the verifier reads with — before
    // the hash is computed, and `src/lib/crypto/actor-ip.ts` keeps an
    // uncastable value from aborting the mutation's transaction. What remains
    // is the topology decision above, and only that.
    //
    // UNSET MEANS NO PROXY, and that is the safe default rather than a
    // convenient one: with no value the peer address is used, which is correct
    // when nothing sits in front and merely coarse when something does.
    TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().optional(),

    // STORY-024 — tracing. Every request gets a server span regardless (its
    // trace id IS `meta.request_id`), so ids exist with no collector. An OTLP
    // exporter is wired ONLY when this endpoint is set; unset (the default)
    // means spans are created and discarded. The base URL of an OTLP/HTTP
    // collector, e.g. http://otel-collector:4318 — `/v1/traces` is appended.
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
    // STORY-024 — the head-sampling ratio for new traces, 0..1, default 1
    // (always on). Sampling decides what is EXPORTED, never whether the id
    // exists: a request sampled out still has a trace id.
    OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).optional(),

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
    // when known. Absent for an engine key disables ONLY that engine's 100%
    // hard stop; 80%/95% alerting still runs. E2E-B6: gemini alone has a
    // default (DEFAULT_ENGINE_SPEND_CEILINGS_USD) that an entry here overrides.
    ENGINE_SPEND_CEILINGS_USD: requiredString
      .refine((value) => parsesAgainst(engineSpendCeilingsSchema, value), {
        message: "must be a JSON object mapping engine keys to a positive USD ceiling",
      })
      .optional(),
    // NEW-A-4 — optional: absent leaves Gemini honestly not capture-ready (registry.ts), it
    // does not fail boot. Never logged, never echoed in an error.
    GEMINI_API_KEY: requiredString.optional(),
    // STORY-029 - SerpApi key for the google_aio and google_ai_mode surfaces. Optional like GEMINI_API_KEY: absent leaves both surfaces
    // honestly not capture-ready, it does not fail boot. Never logged, never echoed in an error.
    SERP_API_KEY: requiredString.optional(),
    // STORY-133 - optional: absent leaves the embedding port on the deterministic stand-in outside production (and refusing in
    // production), it does not fail boot. Selecting the real adapter is this one variable. Never logged, never echoed in an error.
    OPENAI_API_KEY: requiredString.optional(),
    // SCANFIX D3 - the pace the capture dispatcher holds Gemini to, in requests per minute. Default 10 =
    // the free tier of gemini-2.5-flash; raise it with the paid quota. It builds a ONE-token bucket
    // (no burst above the rate) and takes precedence over ENGINE_TOKEN_BUCKETS.gemini.
    GEMINI_REQUESTS_PER_MINUTE: z.coerce.number().positive().default(10),
    // STORY-029 - the pace the capture dispatcher holds EACH Google surface to, in requests per minute (a one-token bucket per engine key,
    // overriding ENGINE_TOKEN_BUCKETS for google_aio and google_ai_mode). Default 1. This paces throughput only; it does NOT bound the
    // monthly quota (1/min per surface is thousands of searches a day). The monthly limit is the spend ceiling (DEFAULT_ENGINE_SPEND_CEILINGS_USD). The two surfaces draw separate buckets, so the vendor sees up to twice this.
    SERP_REQUESTS_PER_MINUTE: z.coerce.number().positive().default(1),
    // STORY-045 AC3 (owner decision 2026-10-28 #3) - which model naturalises generated prompt text (tracking-engine.md section 4 step 4).
    // `none` (the default) is the template-only path. `gemini` binds a Flash-class Gemini model using GEMINI_API_KEY; with no key it falls
    // back to template-only rather than failing boot. NOT YET BOUND ON THE REQUEST PATH: the generate route's transaction is open (ADR-0003),
    // so `gemini` is reported at boot and passes stay template-only until STORY-045 decision #5 is answered. The adapter's call has a hard timeout.
    PROMPT_NATURALISER: z.enum(["none", "gemini"]).default("none"),
    PROMPT_NATURALISER_MODEL: requiredString.default("gemini-2.5-flash"),
    PROMPT_NATURALISER_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(8_000),

    // NEW-D-2 — Stripe (SANDBOX keys in every environment this week). All three
    // are OPTIONAL, deliberately: the API must boot without a payment provider,
    // and every Stripe route then answers 503 `degraded` instead of the process
    // refusing to start. The secret key and the webhook signing secret are
    // credentials — they are never logged, never put in an error, and never
    // returned (src/lib/billing/stripe/stripe-http.gateway.ts). The publishable
    // key is public by design but is carried here so the one place that names
    // Stripe configuration names all three.
    STRIPE_SECRET_KEY: requiredString.optional(),
    STRIPE_WEBHOOK_SECRET: requiredString.optional(),
    STRIPE_PUBLISHABLE_KEY: requiredString.optional(),

    // NEW-E-098b — the share-token portal. BOTH optional, deliberately, like Stripe: the API boots without them and
    // POST /portal/session then answers 503 `degraded` (and every portal route 503), failing CLOSED rather than
    // refusing to start. PORTAL_COOKIE_KEY is 32 random bytes, base64url (43 characters): the root of both the
    // signing and the encryption key of the portal session cookie. DATABASE_URL_PORTAL logs in as `nominara_portal`
    // (SELECT only, portal_scope_* policies) and is a DIFFERENT pool from DATABASE_URL_POOLED. Credentials: never logged.
    PORTAL_COOKIE_KEY: requiredString.optional(),
    DATABASE_URL_PORTAL: requiredString.optional(),

    // Group C item 3 - object storage (KAD-08), S3-compatible. LocalStack in development, AWS S3 in production: the
    // ONLY production difference is STORAGE_ENDPOINT (unset on AWS) and the credentials (an IAM role on AWS, so
    // STORAGE_ACCESS_KEY_ID/SECRET are unset there too). Everything is OPTIONAL and the API boots without it; storage
    // calls then answer 503 `degraded`. The two bucket names are what switch it on, and one without the other is a
    // refused boot (superRefine below). The secret access key is a credential: never logged, never in an error.
    STORAGE_ENDPOINT: requiredString
      .refine((value) => URL.canParse(value), { message: "must be a URL, e.g. http://localhost:4566" })
      .optional(),
    STORAGE_REGION: requiredString.optional(),
    STORAGE_BUCKET_RAW: requiredString.optional(),
    STORAGE_BUCKET_REPORTS: requiredString.optional(),
    STORAGE_ACCESS_KEY_ID: requiredString.optional(),
    STORAGE_SECRET_ACCESS_KEY: requiredString.optional(),
    // "true" only - anything else is refused rather than guessed. LocalStack needs it; AWS must not set it.
    STORAGE_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(),
    // Encryption at rest on every write. Default (when unset) is the spec's SSE-KMS; local development sets AES256 (SSE-S3).
    STORAGE_SSE: z.enum(["AES256", "aws:kms"]).optional(),
    STORAGE_KMS_KEY_ID: requiredString.optional(),
    // The `{env}` segment of every object key (system-architecture.md section 6). Like CACHE_KEY_NAMESPACE it exists
    // because NODE_ENV cannot name a deployment (staging); a lowercase slug, defaulting to NODE_ENV.
    // `crawl` is reserved: the crawl namespace is `crawl/{env}/{ws}/…`, so an env named crawl would make a raw key
    // `crawl/{ws}/…` indistinguishable in shape from a crawl key.
    STORAGE_KEY_ENV: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, { message: "must be a lowercase slug of at most 32 characters" })
      .refine((value) => value !== "crawl", { message: "crawl is reserved for the crawl key namespace" })
      .optional(),
  })
  .strict()
  // STORY-127 — the first of the two checks that keep plaintext one-time
  // codes out of a production build. The adapter's constructor is the
  // second; this one refuses at BOOT, so the process never starts rather
  // than starting and printing a credential on the first sign-in attempt.
  .superRefine((env, ctx) => {
    // STORY-141 AC 8 — DATABASE_URL carries the reconciler's SESSION advisory
    // lock (src/lib/queue/locks.ts) and the migration/DDL connection; it must
    // be the direct connection. Under pgBouncer transaction pooling a session
    // lock is stranded on a backend nobody owns. Only the pooler's documented
    // signals can be recognised from a URL: its host port (6432, .env.example /
    // docker-compose.yml) and its compose service name. A pooler on another
    // host and port is not detectable here. DATABASE_URL_POOLED is the pooler
    // by design and is deliberately not checked.
    if (URL.canParse(env.DATABASE_URL)) {
      const direct = new URL(env.DATABASE_URL);
      if (direct.port === PGBOUNCER_HOST_PORT || direct.hostname.toLowerCase() === PGBOUNCER_SERVICE_HOST) {
        ctx.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message:
            "DATABASE_URL must be the direct Postgres connection, not the pgBouncer pooler (a session advisory lock cannot survive transaction pooling); the pooler belongs in DATABASE_URL_POOLED.",
        });
      }
    }
    if (env.NODE_ENV === "production" && env.RESEND_TO_EMAIL !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_TO_EMAIL"],
        message:
          "RESEND_TO_EMAIL redirects every outgoing email to one address and is a development-only override; it cannot be set under NODE_ENV=production.",
      });
    }
    if (env.NODE_ENV === "production" && (env.RESEND_API_KEY === undefined) !== (env.RESEND_FROM_EMAIL === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [env.RESEND_API_KEY === undefined ? "RESEND_API_KEY" : "RESEND_FROM_EMAIL"],
        message:
          "RESEND_API_KEY and RESEND_FROM_EMAIL must be set together: one without the other would fall back to a sender that delivers nothing.",
      });
    }
    if (
      env.NODE_ENV === "production" &&
      env.RESEND_API_KEY !== undefined &&
      env.RESEND_FROM_EMAIL !== undefined &&
      env.RESEND_WEBHOOK_SECRET === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["RESEND_WEBHOOK_SECRET"],
        message:
          "RESEND_WEBHOOK_SECRET is required when Resend is configured under NODE_ENV=production: without it no bounce or complaint is heard and suppression never happens.",
      });
    }
    if (
      env.NODE_ENV === "production" &&
      env.ALERT_EMAIL_TO !== undefined &&
      (env.RESEND_API_KEY === undefined || env.RESEND_FROM_EMAIL === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ALERT_EMAIL_TO"],
        message:
          "ALERT_EMAIL_TO needs RESEND_API_KEY and RESEND_FROM_EMAIL under NODE_ENV=production: without a real sender the alert would be logged as emailed and delivered to nobody.",
      });
    }
    // Group C item 3 - object storage is all-or-nothing where a half-set config would be silently wrong.
    if ((env.STORAGE_BUCKET_RAW === undefined) !== (env.STORAGE_BUCKET_REPORTS === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [env.STORAGE_BUCKET_RAW === undefined ? "STORAGE_BUCKET_RAW" : "STORAGE_BUCKET_REPORTS"],
        message: "STORAGE_BUCKET_RAW and STORAGE_BUCKET_REPORTS must be set together.",
      });
    }
    if ((env.STORAGE_ACCESS_KEY_ID === undefined) !== (env.STORAGE_SECRET_ACCESS_KEY === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: [env.STORAGE_ACCESS_KEY_ID === undefined ? "STORAGE_ACCESS_KEY_ID" : "STORAGE_SECRET_ACCESS_KEY"],
        message: "STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY must be set together (or neither, to use the IAM role).",
      });
    }
    // Production: the spec's SSE-KMS means OUR customer-managed key, not the account's default aws/s3 key, and the key
    // environment must be named rather than inherited from NODE_ENV (it is a segment of every object key).
    if (env.NODE_ENV === "production" && env.STORAGE_BUCKET_RAW !== undefined) {
      if ((env.STORAGE_SSE ?? "aws:kms") === "aws:kms" && env.STORAGE_KMS_KEY_ID === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["STORAGE_KMS_KEY_ID"],
          message: "STORAGE_KMS_KEY_ID is required in production when STORAGE_SSE is aws:kms (or unset): the default aws/s3 key is not the spec's CMK.",
        });
      }
      if (env.STORAGE_KEY_ENV === undefined) {
        ctx.addIssue({ code: "custom", path: ["STORAGE_KEY_ENV"], message: "STORAGE_KEY_ENV is required in production when object storage is configured." });
      }
    }
    if (env.STORAGE_KMS_KEY_ID !== undefined && (env.STORAGE_SSE ?? "aws:kms") !== "aws:kms") {
      ctx.addIssue({ code: "custom", path: ["STORAGE_KMS_KEY_ID"], message: "STORAGE_KMS_KEY_ID only applies when STORAGE_SSE is aws:kms." });
    }
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

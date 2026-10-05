import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { loadEnv } from "../../config/env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { hash, verify, verifyDecoy } from "../../lib/crypto/argon2id.js";
import {
  OTP_RATE_LIMIT_PER_ADDRESS_PER_HOUR,
  OTP_RATE_LIMIT_PER_SOURCE_PER_MINUTE,
  OTP_TTL_MS,
  generateOtpCode,
  hashEmailKey,
  normalizeEmail,
} from "../../lib/auth/email-otp.js";
import { withUniformDuration } from "../../lib/auth/uniform-timing.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { EmailOtpInvalidException, OtpRateLimitedException } from "../../tenancy/errors.js";
import type { EmailOtpRequestResponse } from "./dto/index.js";
import { EMAIL_SENDER, type EmailSender } from "./ports/email-sender.js";
import { renderOtpEmail } from "./otp-email-template.js";
import { SessionService, type SessionTokens } from "./session.service.js";

// STORY-016 — dangerous area: the request path is the enumeration-
// resistance surface (uniform response + duration whether or not an
// address has an account) and, alongside the verify path in this same
// file, the OTP attempt-budget/invalidation and rate-limit ledger logic
// (credit-ledger-adjacent correctness under concurrency) — second-engineer
// review required for both.

// Chosen conservatively above the argon2id op cost measured in
// argon2id.spec.ts (tens of milliseconds on dev hardware, m=64MiB t=3
// p=1); this floor must dominate the known path's SELECT + Argon2id
// hash() and the unknown path's verifyDecoy() alike so the two are
// statistically indistinguishable (Test Scenario 3), while staying well
// under vitest.integration.config.ts's 30s testTimeout across the timing
// spec's 25-sample loop (50 requests x 120ms floor ~= 6s, comfortably
// inside the limit).
export const REQUEST_TIMING_FLOOR_MS = 120;

interface RateLimitWindowRow {
  readonly cnt: number;
  readonly oldest: Date | null;
}

interface LiveOtpCodeRow {
  readonly id: string;
  readonly code_hash: string;
  readonly attempts: number;
  readonly max_attempts: number;
}

/** `email_otp:<address>` — hashed server-side by hashtextextended, not pre-hashed here. */
function emailOtpLockKey(normalizedEmail: string): string {
  return `email_otp:${normalizedEmail}`;
}

/**
 * Distinct key namespace from emailOtpLockKey — serializes the rate-limit
 * check-then-insert sequence (per address) rather than OTP-code
 * consumption, so requestCode() and verifyCode() for the same address
 * never block on each other unnecessarily (STORY-016 fix 3). Per-address
 * only: the per-source (30/min) bucket is a coarse abuse-deterrence
 * figure, not identity-critical, and locking on it too would risk
 * ordering two advisory locks per request (deadlock-prone under
 * concurrency) for a bucket the story's ACs don't require serializing.
 */
function emailOtpRateLockKey(normalizedEmail: string): string {
  return `email_otp_rate:${normalizedEmail}`;
}

/** Seconds remaining until `oldest` ages out of a `windowSeconds`-wide sliding window, clamped to (0, windowSeconds]. */
function retryAfterSeconds(oldest: Date, windowSeconds: number): number {
  const elapsedMs = Date.now() - oldest.getTime();
  const remainingMs = windowSeconds * 1000 - elapsedMs;
  return Math.min(windowSeconds, Math.max(1, Math.ceil(remainingMs / 1000)));
}

@Injectable()
export class EmailOtpService {
  private readonly logger = new Logger(EmailOtpService.name);
  private readonly pepper: string;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    private readonly sessions: SessionService,
  ) {
    this.pepper = loadEnv().OTP_EMAIL_HASH_PEPPER;
  }

  /**
   * POST /auth/otp/request. Order is security-critical:
   * 1. Normalize the address and derive its peppered ledger key
   *    (hashEmailKey — cheap HMAC, not the password-grade hashing step 5
   *    refers to).
   * 2. Rate-limit check FIRST — per-address (1h) then per-source (1m) —
   *    refused before any ledger row is written or any password-grade
   *    hashing happens, so a rate-limited caller never pays for either.
   * 3. The ledger row is written unconditionally once past the rate
   *    limit, known address or not (D5) — an unknown address that skipped
   *    the ledger would never be rate-limited, and the 429 itself would
   *    become an existence oracle.
   * 4-5. Resolve the user (active/unverified, not deleted/suspended — D7
   *    treats anything else as unknown) and either Argon2id-hash a real
   *    code or run a same-cost decoy verify.
   * 6. Both branches are wrapped in a uniform-duration floor so total
   *    wall time never signals which branch ran (Test Scenario 3).
   * 7. The email itself is fire-and-forget, AFTER the envelope above has
   *    already settled — it must never be part of what the floor
   *    measures or what the caller waits on.
   * 8. The response body is the same fixed constant on every path (D8).
   */
  async requestCode(email: string, source: string | null, httpRequestId: string): Promise<EmailOtpRequestResponse> {
    const normalizedEmail = normalizeEmail(email);
    const emailHash = hashEmailKey(normalizedEmail, this.pepper);
    const sourceHash = source !== null ? hashEmailKey(source, this.pepper) : null;

    // STORY-016 fix 3 — the count-check and the ledger insert used to be
    // two separate round-trips with nothing serializing them, so two
    // concurrent requests near the 3/hour boundary could both pass the
    // check before either committed. A transaction-scoped advisory lock
    // keyed on the address (same idiom as verifyCode below and
    // OauthService.resolveOrCreateForLogin) makes the check-then-insert
    // sequence atomic relative to any other concurrent request for the
    // same address.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [emailOtpRateLockKey(normalizedEmail)]);

      await this.checkRateLimit(client, emailHash, sourceHash, httpRequestId);

      await client.query(`INSERT INTO email_otp_requests (id, email_hash, source_hash) VALUES ($1, $2, $3)`, [
        uuidV7(),
        emailHash,
        sourceHash,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    const outcome = await withUniformDuration(REQUEST_TIMING_FLOOR_MS, async () => {
      // STORY-173 — an address with no account gets one, `unverified`, with no
      // credential and no session; only the code mailed to the address can
      // turn it into something usable. This is how a new person proves their
      // address BEFORE their first passkey exists, and it makes the two
      // branches the same work: the old unknown-address branch (decoy hash,
      // nothing mailed) was a response-time and mailbox oracle on whether an
      // account existed.
      //
      // DO NOTHING, never DO UPDATE: an anonymous request must not touch an
      // existing row — not its status, and not even the casing of its stored
      // address (STORY-173 AC3). A suspended or deleted-and-reused address
      // still falls through to the decoy below.
      await this.pool.query(
        `INSERT INTO users (id, email, status) VALUES ($1, $2, 'unverified')
         ON CONFLICT (email) WHERE deleted_at IS NULL DO NOTHING`,
        [uuidV7(), normalizedEmail],
      );
      const userResult = await this.pool.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL AND status IN ('active', 'unverified')`,
        [normalizedEmail],
      );
      const user = userResult.rows[0];
      if (!user) {
        await verifyDecoy(generateOtpCode());
        return null;
      }

      const code = generateOtpCode();
      const codeHash = await hash(code);
      const expiresAt = new Date(Date.now() + OTP_TTL_MS);
      await this.pool.query(`INSERT INTO email_otp_codes (id, user_id, code_hash, expires_at) VALUES ($1, $2, $3, $4)`, [
        uuidV7(),
        user.id,
        codeHash,
        expiresAt,
      ]);
      return { userId: user.id, code };
    });

    if (outcome) {
      // setImmediate, not a direct fire-and-forget call: calling an async
      // function still runs its body synchronously up to its first
      // `await`, and adapters (e.g. LoggingEmailSenderAdapter) do real
      // synchronous work there (env read, HMAC, a log call) — deferred to
      // the next tick so ZERO of that work is on the calling stack before
      // requestCode returns control past this point, on the known-address
      // branch or otherwise (code-reviewer finding, STORY-016 fix 2).
      setImmediate(() => {
        const rendered = renderOtpEmail({ code: outcome.code, expiresInMinutes: OTP_TTL_MS / 60_000 });
        this.emailSender.send({ to: normalizedEmail, subject: rendered.subject, textBody: rendered.textBody }).catch((error) => {
          this.logger.warn(
            `otp email send failed user_id=${outcome.userId} message=${error instanceof Error ? error.message : String(error)}`,
          );
        });
      });
    }

    // STORY-117 — the field is milliseconds now (`NFR-API-05`: "all durations
    // are integer milliseconds with a `_ms` suffix"). It was
    // `expires_in_seconds: 600`, which no reference ever asked for.
    //
    // Still a literal rather than OTP_TTL_MS: D8 requires a FIXED-CONSTANT
    // body, the schema pins z.literal(600_000), and OTP_TTL_MS is written as
    // `10 * 60 * 1000`, which TypeScript widens to `number` — so it cannot
    // satisfy the literal type. The two numbers agree and
    // email-otp-fixed-response.spec asserts they still do.
    return { status: "sent", expires_in_ms: 600_000 };
  }

  private async checkRateLimit(
    client: PoolClient,
    emailHash: Buffer,
    sourceHash: Buffer | null,
    httpRequestId: string,
  ): Promise<void> {
    const addressResult = await client.query<RateLimitWindowRow>(
      `SELECT count(*)::int AS cnt, min(created_at) AS oldest FROM email_otp_requests
       WHERE email_hash = $1 AND created_at > now() - interval '1 hour'`,
      [emailHash],
    );
    const address = addressResult.rows[0]!;
    if (address.cnt >= OTP_RATE_LIMIT_PER_ADDRESS_PER_HOUR) {
      this.rejectRateLimited(httpRequestId, "per_address", retryAfterSeconds(address.oldest!, 3600));
    }

    if (sourceHash !== null) {
      const sourceResult = await client.query<RateLimitWindowRow>(
        `SELECT count(*)::int AS cnt, min(created_at) AS oldest FROM email_otp_requests
         WHERE source_hash = $1 AND created_at > now() - interval '1 minute'`,
        [sourceHash],
      );
      const source = sourceResult.rows[0]!;
      if (source.cnt >= OTP_RATE_LIMIT_PER_SOURCE_PER_MINUTE) {
        this.rejectRateLimited(httpRequestId, "per_source", retryAfterSeconds(source.oldest!, 60));
      }
    }
  }

  private rejectRateLimited(httpRequestId: string, bucket: "per_address" | "per_source", retrySeconds: number): never {
    this.logger.warn(`otp request rate-limited bucket=${bucket} request_id=${httpRequestId}`);
    incrementCounter("nominara_identity_otp_rate_limited_total", { bucket });
    throw new OtpRateLimitedException(retrySeconds);
  }

  /**
   * POST /auth/otp/verify — dangerous area, second-engineer review
   * required alongside requestCode() above. Order is security-critical:
   * 1. Normalize the address.
   * 2. A transaction-scoped advisory lock (same idiom as
   *    OauthService.resolveOrCreateForLogin, oauth.service.ts:296) keyed
   *    on the address serializes every concurrent verify attempt against
   *    it — closes the race between two parallel guesses, or between a
   *    correct guess and an attempt-budget update, both acting on the
   *    same "live" row set.
   * 3. Resolve the user exactly as requestCode() does (active/unverified,
   *    not deleted/suspended). Not found still pays a real verifyDecoy()
   *    cost, then funnels into the same neutral rejection as every other
   *    failure mode.
   * 4. Every "live" row (not consumed, not invalidated, not expired) for
   *    the user is locked FOR UPDATE and checked against the presented
   *    code. Zero live rows (all expired/invalidated, or none ever
   *    issued) also pays a verifyDecoy() cost before rejecting.
   * 5. A match consumes that row and, in the SAME transaction, invalidates
   *    every OTHER live row as 'superseded' (AC "requesting twice ...
   *    leaves no live second code") and promotes email_verified_at/status
   *    (D2) before committing.
   * 6. No match increments `attempts` on EVERY live row (D3), invalidating
   *    any that reach `max_attempts` as 'attempts_exhausted' — never
   *    merely rejected — committed even though the request itself is
   *    refused.
   * 7. Every rejection path funnels through one exception, one fixed
   *    message (AC6) — the real reason is a server-side warn log only.
   *    A session is only minted AFTER this transaction commits (mirrors
   *    OauthService.callback's sequencing).
   */
  async verifyCode(email: string, code: string, httpRequestId: string): Promise<SessionTokens> {
    const normalizedEmail = normalizeEmail(email);
    const client = await this.pool.connect();
    let verifiedUserId: string | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [emailOtpLockKey(normalizedEmail)]);

      const userResult = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL AND status IN ('active', 'unverified')`,
        [normalizedEmail],
      );
      const user = userResult.rows[0];
      if (!user) {
        await verifyDecoy(code);
        // No explicit ROLLBACK here — rejectVerify() throws, and the one
        // ROLLBACK in the outer catch below handles every throwing path
        // uniformly (STORY-016 fix 5: this used to ROLLBACK twice, once
        // here and once in the catch, on an already-closed transaction).
        this.rejectVerify(httpRequestId, "unknown_address");
      }

      const liveRows = await client.query<LiveOtpCodeRow>(
        `SELECT id, code_hash, attempts, max_attempts FROM email_otp_codes
         WHERE user_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [user.id],
      );
      if (liveRows.rows.length === 0) {
        await verifyDecoy(code);
        this.rejectVerify(httpRequestId, "no_live_codes");
      }

      let matchedId: string | null = null;
      for (const row of liveRows.rows) {
        if (await verify(code, row.code_hash)) {
          matchedId = row.id;
          break;
        }
      }

      if (matchedId === null) {
        const liveIds = liveRows.rows.map((row) => row.id);
        await client.query(
          `UPDATE email_otp_codes SET
             attempts = attempts + 1,
             invalidated_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE invalidated_at END,
             invalidated_reason = CASE WHEN attempts + 1 >= max_attempts THEN 'attempts_exhausted' ELSE invalidated_reason END
           WHERE id = ANY($1::uuid[])`,
          [liveIds],
        );
        await client.query("COMMIT");
        this.rejectVerify(httpRequestId, "wrong_code");
      }

      await client.query(`UPDATE email_otp_codes SET consumed_at = now() WHERE id = $1`, [matchedId]);
      // STORY-173 — the FIRST proof of an address revokes everything that
      // predates it. Until now nobody had shown control of this address, so a
      // credential or session already on the account was put there by someone
      // who never proved it either (a passkey from the old anonymous
      // registration, an OAuth link from a provider that did not verify the
      // address): the person who has just proved the address is the first one
      // entitled to it. The row is locked so a concurrent proof cannot both
      // see "first".
      const prior = await client.query<{ email_verified_at: Date | null }>(
        `SELECT email_verified_at FROM users WHERE id = $1 FOR UPDATE`,
        [user.id],
      );
      if (prior.rows[0]!.email_verified_at === null) {
        const credentials = await client.query(
          `UPDATE user_credentials SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
          [user.id],
        );
        const sessions = await client.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'address_proved'
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [user.id],
        );
        if ((credentials.rowCount ?? 0) > 0 || (sessions.rowCount ?? 0) > 0) {
          // IDs and counts only — never the address.
          this.logger.warn(
            `first proof of address revoked earlier access user_id=${user.id} ` +
              `credentials=${String(credentials.rowCount ?? 0)} sessions=${String(sessions.rowCount ?? 0)}`,
          );
          incrementCounter("nominara_identity_first_proof_revocation_total");
        }
      }
      await client.query(
        `UPDATE email_otp_codes SET invalidated_at = now(), invalidated_reason = 'superseded'
         WHERE user_id = $1 AND id != $2 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        [user.id, matchedId],
      );
      // D2 — receiving a code at an address is direct proof of control of
      // it, stronger evidence than OAuth's provider assertion (already
      // treated as sufficient for 'active'). Same transaction as the
      // code-consumption update above, not a separate one — STORY-015's
      // bad9384 lesson: a promotion split across two transactions can
      // leave a user stuck between them if a crash lands in the gap.
      await client.query(
        `UPDATE users SET email_verified_at = now(), status = CASE WHEN status = 'unverified' THEN 'active' ELSE status END
         WHERE id = $1`,
        [user.id],
      );
      await client.query("COMMIT");
      verifiedUserId = user.id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error instanceof EmailOtpInvalidException) {
        throw error;
      }
      this.logger.warn(
        `otp verify failed unexpectedly request_id=${httpRequestId} message=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.rejectVerify(httpRequestId, "verify_failed_unexpectedly");
    } finally {
      client.release();
    }

    // The code just proved control of the address, which is the platform
    // itself performing a re-authentication: stamp the session so it satisfies
    // step-up for the next five minutes (this is what lets the person add
    // their first passkey straight after signing up).
    return this.sessions.createSession(verifiedUserId!, new Date(), "email_otp");
  }

  /**
   * Every verify() rejection funnels through here — same fixed neutral
   * message and shape regardless of `reason` (unknown address, no live
   * codes, wrong code, an unexpected error), which never leaves this
   * process (server-side warn log + metric only). Unlike
   * OauthService.rejectCallback, the thrown exception carries no
   * request_id — Test Scenario 5 requires byte-identical bodies across
   * genuinely different requests, so `httpRequestId` here is for the log
   * line only, never for the response.
   */
  private rejectVerify(httpRequestId: string, reason: string): never {
    this.logger.warn(`otp verify rejected reason=${reason} request_id=${httpRequestId}`);
    incrementCounter("nominara_identity_otp_verify_failed_total", { reason });
    throw new EmailOtpInvalidException();
  }
}

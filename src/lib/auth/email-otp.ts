import { createHmac, randomInt } from "node:crypto";

// STORY-016 — pure primitives for the email-OTP fallback sign-in flow.
// No I/O, no framework dependency: code generation, the normalization used
// identically at request and verify time so the two paths agree on the same
// logical address, and the peppered hash the rate-limit ledger keys on
// (email_otp_requests.email_hash — src/db/migrations/sql/0014_email_otp.up.sql).

/** security-and-tenancy.md §5 "Email OTP" — 10-minute code lifetime. */
export const OTP_TTL_MS = 10 * 60 * 1000;

/** security-and-tenancy.md §5 "Email OTP" — bounded attempt count before invalidation (D3). */
export const OTP_MAX_ATTEMPTS = 5;

/** security-and-tenancy.md §5 "Email OTP" — 3/hour/email rate limit. */
export const OTP_RATE_LIMIT_PER_ADDRESS_PER_HOUR = 3;

/** api-specification.md §12 "Rate limits" — Auth route class, per-IP figure (the "per source" bucket). */
export const OTP_RATE_LIMIT_PER_SOURCE_PER_MINUTE = 30;

const OTP_CODE_DIGITS = 8;
const OTP_CODE_EXCLUSIVE_UPPER_BOUND = 10 ** OTP_CODE_DIGITS;

/**
 * An 8-digit numeric code, zero-padded, drawn via a CSPRNG with no modulo
 * bias (crypto.randomInt already rejects out-of-range draws internally —
 * never Math.random, never `% 1e8`).
 */
export function generateOtpCode(): string {
  const value = randomInt(0, OTP_CODE_EXCLUSIVE_UPPER_BOUND);
  return value.toString().padStart(OTP_CODE_DIGITS, "0");
}

/**
 * Trim + lowercase — applied identically at request and verify time so the
 * two always resolve to the same logical address.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Peppered HMAC-SHA256 of the normalized email, for the rate-limit ledger
 * (email_otp_requests.email_hash). Stable for a given (email, pepper) pair;
 * differs across peppers so a DB-read-only attacker without the pepper
 * cannot dictionary-attack the ledger to confirm who requested a code (D5).
 */
export function hashEmailKey(normalizedEmail: string, pepper: string): Buffer {
  return createHmac("sha256", pepper).update(normalizedEmail).digest();
}

import { randomInt } from "node:crypto";
import { hashEmailKey, normalizeEmail } from "../../lib/auth/email-otp.js";

// Owner decision 71 (b) — the allowed-email-domain sign-in code for a share link. Pure: no I/O.

/** Valid for ten minutes. */
export const PORTAL_CODE_TTL_MS = 10 * 60 * 1000;
/** At most five wrong guesses per code; the fifth invalidates it. */
export const PORTAL_CODE_MAX_ATTEMPTS = 5;
/**
 * At most this many codes are MAILED per (token, address) per hour. Not from a reference: it bounds mailbox flooding and keeps a
 * guesser from farming fresh five-attempt budgets (each new code supersedes the live one). Three is the figure sign-in codes use
 * (security-and-tenancy.md section 5, 3/hour/email).
 */
export const PORTAL_CODE_ISSUE_LIMIT_PER_HOUR = 3;

/** Across ALL addresses of one link: a visitor with the link cannot farm fresh five-attempt budgets by varying the address. Not from a reference. */
export const PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_HOUR = 10;

/**
 * Across ALL addresses of one link, per rolling 24 hours (098 security review). The hourly caps alone let a link holder with no password
 * run codes continuously (10 an hour, 5 guesses each) and, over a year, reach a material chance of a correct guess; this bounds the day.
 */
export const PORTAL_CODE_ISSUE_LIMIT_PER_TOKEN_PER_DAY = 30;

const CODE_DIGITS = 6;

/**
 * The peppered hash a code row is keyed on. Domain-separated (`portal-code:`) from the sign-in ledger's hash of the same address, so a
 * reader of the database cannot join the two tables on it. The address itself is never stored.
 */
export function portalEmailHash(email: string, pepper: string): Buffer {
  return hashEmailKey(`portal-code:${normalizeEmail(email)}`, pepper);
}

/** Six digits, zero-padded, from a CSPRNG with no modulo bias (randomInt rejects out-of-range draws). */
export function generatePortalCode(): string {
  return randomInt(0, 10 ** CODE_DIGITS).toString().padStart(CODE_DIGITS, "0");
}

/** The address's domain is the part after the LAST `@`, compared case-insensitively and EXACTLY (no suffix, no subdomain). */
export function domainAllowed(email: string, allowed: readonly string[]): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return allowed.some((d) => d.toLowerCase() === domain);
}

export interface PortalCodeEmail {
  readonly subject: string;
  readonly textBody: string;
}

/** Carries the code and its lifetime and nothing else: no agency, client, link or workspace, so an intercepted mail discloses no more than the code. */
export function renderPortalCodeEmail({ code, expiresInMinutes }: { readonly code: string; readonly expiresInMinutes: number }): PortalCodeEmail {
  return {
    subject: "Your report access code",
    textBody: `Your access code is ${code}. It expires in ${String(expiresInMinutes)} minutes. If you didn't ask for it, you can ignore this email.`,
  };
}

import { z } from "zod";

// STORY-048 — api-specification.md §3: `POST /projects/{id}/domain-verification`
// and `/check`, both `project:update`.
//
// THE SCOPE GATE IS WHY THIS STORY EXISTS. Without proof of control the AUX
// audit becomes a way to inspect and score any third-party site, including a
// competitor's — a legal problem and a reputational one at once. Verification
// is free and takes minutes, so the nudge is "verify to audit more pages for
// the same price" rather than a paywall: a paywall would push customers onto
// the unverified path, which is the path we want used less.

/** schemas/projects-and-prompts.md's `domain_verifications.method` CHECK. */
export const VERIFICATION_METHODS = ["dns_txt", "well_known_file", "meta_tag"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/**
 * AC9 — "failure reasons are specific enough to act on".
 *
 * An enum, not prose, for the same reason the guarded fetcher's is: this is
 * rendered to a customer who has to go and fix something, and "verification
 * failed" tells them nothing. Each value names a DIFFERENT remedy — an absent
 * record means add one, a wrong one means correct it, a redirect means the
 * file is being served from somewhere else.
 */
export const VERIFICATION_FAILURES = [
  "record_absent",
  "record_present_but_wrong",
  "file_absent",
  "file_redirected",
  "file_wrong_content",
  "tag_absent",
  "tag_wrong_value",
  "dns_lookup_failed",
  "fetch_refused",
] as const;
export type VerificationFailure = (typeof VERIFICATION_FAILURES)[number];

export const startVerificationRequestSchema = z
  .object({ method: z.enum(VERIFICATION_METHODS) })
  .strict();

export const verificationStateSchema = z
  .object({
    domain: z.string(),
    method: z.enum(VERIFICATION_METHODS),
    nonce: z.string(),
    verified: z.boolean(),
    verified_at: z.string().nullable(),
    last_checked_at: z.string().nullable(),
    failure_reason: z.enum(VERIFICATION_FAILURES).nullable(),
    // AC2 — "instructions the customer can follow without support". Returned
    // with the state rather than only on start, so a client re-rendering a
    // failed check does not have to have kept them.
    instructions: z.string(),
  })
  .strict();

/** AC5 — "the state is per domain and per method, so a customer can verify by any one." */
export const verificationStatusResponseSchema = z
  .object({
    domain: z.string(),
    /** True when ANY method has verified. */
    verified: z.boolean(),
    /** AC6 — what an audit of this domain may cover right now. */
    audit_scope: z.enum(["full", "public_surface"]),
    methods: z.array(verificationStateSchema),
  })
  .strict();

export type StartVerificationRequest = z.infer<typeof startVerificationRequestSchema>;
export type VerificationState = z.infer<typeof verificationStateSchema>;
export type VerificationStatusResponse = z.infer<typeof verificationStatusResponseSchema>;

/** The DNS name the TXT record goes on, and the token it must contain. */
export function dnsRecordName(domain: string): string {
  return `_nominara-verify.${domain}`;
}

/** The path the well-known file goes at. Per-domain nonce, so it cannot be moved between domains. */
export function wellKnownPath(nonce: string): string {
  return `/.well-known/nominara-${nonce}.txt`;
}

/**
 * AC2 — method-specific, and concrete enough to act on without support.
 *
 * The nonce appears in the instruction text because the customer has to paste
 * it somewhere; there is no way to be useful here while withholding it.
 */
export function instructionsFor(method: VerificationMethod, domain: string, nonce: string): string {
  switch (method) {
    case "dns_txt":
      return `Add a TXT record at ${dnsRecordName(domain)} with the value nominara-verify=${nonce}. DNS changes can take up to an hour to propagate.`;
    case "well_known_file":
      return `Publish a file at https://${domain}${wellKnownPath(nonce)} containing exactly ${nonce}. It must return 200 directly — a redirect does not count as proof of control over ${domain}.`;
    case "meta_tag":
      return `Add <meta name="nominara-verify" content="${nonce}"> to the <head> of https://${domain}/.`;
  }
}

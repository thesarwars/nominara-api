// STORY-016 — the seam a real email-provider-backed adapter fills behind,
// without OtpService (a later task) ever importing a provider SDK
// directly. Same port-plus-adapter precedent as OAUTH_CLIENT
// (src/modules/identity/ports/oauth-client.ts) and DEK_PROVISIONER
// (src/modules/workspaces/ports/dek-provisioner.ts).
//
// Interface-only — no logic, no adapter, no DI wiring here.

export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

/** STORY-180 AC3: a file carried on the message. Bytes, never a path or a URL; never logged. */
export interface EmailAttachment {
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType?: string;
}

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  /** Optional HTML alternative. Nothing renders one today (no email template/branding exists); the Resend adapter passes it through when present. */
  readonly htmlBody?: string;
  /** STORY-180 AC3: files to attach (a scheduled report up to 8 MiB). Absent for every other mail. */
  readonly attachments?: readonly EmailAttachment[];
  /**
   * STORY-077 (owner 2026-10-23): a key the provider de-duplicates on, stable across RETRIES of the same logical email (a
   * queue job's attempts). Absent, the Resend adapter mints one per send() call, which only protects its own in-call
   * retries. Never part of the delivered message.
   */
  readonly idempotencyKey?: string;
  /**
   * STORY-100 AC10: the agency's display name for the From header. The ADDRESS stays the platform's authenticated sender
   * (never an agency domain); only the name before it changes. Sanitised against header injection by the adapter.
   */
  readonly fromName?: string;
  /** STORY-100 AC10 / owner decision 6: the Reply-To address. Absent (a theme with none stored) means the header is omitted. */
  readonly replyTo?: string;
  /**
   * STORY-178 / owner decision 8 — true for mail a person needs to use the product (the sign-in code). A spam COMPLAINT
   * suppresses everything that is not transactional (reports, digests, alerts) but still lets this through; a permanent
   * bounce suppresses it too, because it cannot be delivered anyway. Absent means NOT transactional: the safe default for a
   * message nobody classified is to honour a complaint.
   */
  readonly transactional?: boolean;
}

export interface EmailSender {
  /**
   * True only for a sender that really hands mail to a provider (Resend). Logging and dev senders omit it (false): a
   * record of "accepted" by them must never read as `delivered`.
   */
  readonly delivers?: boolean;
  send(message: EmailMessage): Promise<void>;
}

/**
 * STORY-178 — the send was refused because the recipient is suppressed (`bounce`: a permanent bounce; `complaint`: a spam
 * complaint on non-transactional mail). Distinct from a delivery failure: it is not retryable, it is not the provider's, and a
 * caller records it as "not sent, suppressed". The message names the KIND only, never the address.
 */
export class EmailSuppressedError extends Error {
  constructor(readonly kind: "bounce" | "complaint") {
    super(`email not sent: the recipient is suppressed (${kind})`);
    this.name = "EmailSuppressedError";
  }
}

/** STORY-178 — the suppression list could not be read, so the send FAILED CLOSED. Carries none of the database's own text. */
export class EmailSuppressionLookupError extends Error {
  constructor() {
    super("email not sent: the suppression list could not be checked");
    this.name = "EmailSuppressionLookupError";
  }
}

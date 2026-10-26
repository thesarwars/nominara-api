// STORY-016 — the seam a real email-provider-backed adapter fills behind,
// without OtpService (a later task) ever importing a provider SDK
// directly. Same port-plus-adapter precedent as OAUTH_CLIENT
// (src/modules/identity/ports/oauth-client.ts) and DEK_PROVISIONER
// (src/modules/workspaces/ports/dek-provisioner.ts).
//
// Interface-only — no logic, no adapter, no DI wiring here.

export const EMAIL_SENDER = Symbol("EMAIL_SENDER");

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly textBody: string;
  /** Optional HTML alternative. Nothing renders one today (no email template/branding exists); the Resend adapter passes it through when present. */
  readonly htmlBody?: string;
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
}

export interface EmailSender {
  /**
   * True only for a sender that really hands mail to a provider (Resend). Logging and dev senders omit it (false): a
   * record of "accepted" by them must never read as `delivered`.
   */
  readonly delivers?: boolean;
  send(message: EmailMessage): Promise<void>;
}

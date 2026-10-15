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
}

export interface EmailSender {
  /**
   * True only for a sender that really hands mail to a provider (Resend). Logging and dev senders omit it (false): a
   * record of "accepted" by them must never read as `delivered`.
   */
  readonly delivers?: boolean;
  send(message: EmailMessage): Promise<void>;
}

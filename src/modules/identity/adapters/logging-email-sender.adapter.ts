import { Injectable, Logger } from "@nestjs/common";
import { loadEnv } from "../../../config/env.js";
import { hashEmailKey, normalizeEmail } from "../../../lib/auth/email-otp.js";
import type { EmailMessage, EmailSender } from "../ports/email-sender.js";

// STORY-016 — the EMAIL_SENDER port's only implementation for now: a stub
// with no real transport. Logs delivery metadata (recipient hash, subject —
// used here as the template identifier) at `log` level and NEVER the
// textBody, which is the only thing that ever carries the code. A real
// provider (and its vendor credential) is a follow-up story, same as
// OpenidClientAdapter's STORY-015 comment for OAUTH_CLIENT.
//
// STORY-127 — this stays the DEFAULT, including in development. Local
// developers who need to complete an OTP sign-in opt in to
// DevEmailSenderAdapter with OTP_DEV_LOG_CODES; nothing prints a code
// unless someone asked for it.
@Injectable()
export class LoggingEmailSenderAdapter implements EmailSender {
  private readonly logger = new Logger(LoggingEmailSenderAdapter.name);

  async send(message: EmailMessage): Promise<void> {
    const env = loadEnv();
    const recipientHash = hashEmailKey(normalizeEmail(message.to), env.OTP_EMAIL_HASH_PEPPER).toString("hex");
    this.logger.log(
      `email queued (stub, not delivered) from=${env.OTP_EMAIL_FROM} recipient_hash=${recipientHash} template=${message.subject}`,
    );
    await Promise.resolve();
  }
}

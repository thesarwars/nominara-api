import { Injectable, Logger } from "@nestjs/common";
import { loadEnv } from "../../../config/env.js";
import type { EmailMessage, EmailSender } from "../ports/email-sender.js";

// STORY-127 — the local-development email sender: it logs the WHOLE message,
// including the one-time code.
//
// LoggingEmailSenderAdapter deliberately never logs the body, "which is the
// only thing that ever carries the code", and that is right for anything
// resembling a deployment. But it also makes email-OTP sign-in impossible to
// exercise locally: the code is an 8-digit CSPRNG draw stored as an argon2id
// hash, so it is not recoverable from the database either, and there is no
// email provider wired to deliver it. The fallback sign-in path could not be
// used at all on a developer's machine.
//
// This adapter exists to close that, and it prints a secret to a log, so it
// is guarded twice:
//
//   1. It is only ever SELECTED when OTP_DEV_LOG_CODES is on AND NODE_ENV is
//      not "production" (see selectEmailSender below).
//   2. Its CONSTRUCTOR throws under NODE_ENV=production regardless of how it
//      was selected — so a future refactor that rewires the provider cannot
//      quietly ship it. The check lives with the thing that needs it, and it
//      cannot become a no-op, which is the posture this codebase already
//      takes for REALTIME_ALLOWED_ORIGINS.
//
// NODE_ENV cannot express a deployment (see env.schema.ts) and that is fine
// here: this is about BUILD MODE, and a production build must never print a
// credential whatever it is deployed as.
@Injectable()
export class DevEmailSenderAdapter implements EmailSender {
  private readonly logger = new Logger(DevEmailSenderAdapter.name);

  constructor() {
    if (loadEnv().NODE_ENV === "production") {
      throw new Error(
        "DevEmailSenderAdapter logs one-time codes in plaintext and must never be constructed under NODE_ENV=production. " +
          "Wire a real EmailSender adapter instead.",
      );
    }
  }

  async send(message: EmailMessage): Promise<void> {
    this.logger.warn(
      `DEV EMAIL — NOT DELIVERED, CODE IN PLAINTEXT. to=${message.to} subject=${message.subject}\n${message.textBody}`,
    );
    await Promise.resolve();
  }
}

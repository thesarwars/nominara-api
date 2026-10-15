import { Logger } from "@nestjs/common";
import { loadEnv } from "../../config/env.js";
import { DevEmailSenderAdapter } from "./adapters/dev-email-sender.adapter.js";
import { LoggingEmailSenderAdapter } from "./adapters/logging-email-sender.adapter.js";
import { ResendEmailSenderAdapter } from "./adapters/resend-email-sender.adapter.js";
import type { EmailSender } from "./ports/email-sender.js";

const logger = new Logger("email-sender");

/**
 * STORY-127 — which EmailSender this process runs with.
 *
 * Group C — Resend wins when RESEND_API_KEY and RESEND_FROM_EMAIL are both set: real delivery was asked for by
 * supplying a credential, and a developer who also left OTP_DEV_LOG_CODES on gets a warning that it is being ignored
 * rather than a silently-unsent code. Otherwise nothing changes.
 *
 * Without Resend, the default is LoggingEmailSenderAdapter in every environment, including
 * development: nothing prints a one-time code unless a developer explicitly
 * asked for it. `env.schema.ts` already refuses OTP_DEV_LOG_CODES under
 * NODE_ENV=production at boot, and DevEmailSenderAdapter's constructor
 * refuses it again — this function is the third place the pair is checked,
 * and deliberately so: it is the one a reader lands on first.
 */
export function selectEmailSender(): EmailSender {
  const env = loadEnv();
  if (env.RESEND_API_KEY !== undefined && env.RESEND_FROM_EMAIL !== undefined) {
    if (env.OTP_DEV_LOG_CODES === "true") {
      logger.warn("OTP_DEV_LOG_CODES is ignored: Resend is configured, so codes are delivered by email and never logged.");
    }
    if (env.RESEND_TO_EMAIL !== undefined) {
      logger.warn("RESEND_TO_EMAIL is set: EVERY outgoing email is redirected to that one address (development only).");
    }
    return new ResendEmailSenderAdapter({
      apiKey: env.RESEND_API_KEY,
      from: env.RESEND_FROM_EMAIL,
      ...(env.RESEND_TO_EMAIL !== undefined ? { toOverride: env.RESEND_TO_EMAIL } : {}),
    });
  }
  if (env.OTP_DEV_LOG_CODES === "true" && env.NODE_ENV !== "production") {
    return new DevEmailSenderAdapter();
  }
  return new LoggingEmailSenderAdapter();
}

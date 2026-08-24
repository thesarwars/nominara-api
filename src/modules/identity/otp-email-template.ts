// STORY-016 — pure template, deliberately independent of the EMAIL_SENDER
// transport (Implementation decisions: "AC8's email-content requirement is
// satisfied by a pure, unit-tested template function independent of
// transport"). Carries nothing beyond the code and its expiry — no user
// id, session id, workspace name, sign-in link, or account-status wording
// — so intercepting only the email gains an attacker nothing the code
// itself doesn't already give them (AC "includes nothing that would help
// an attacker who intercepted only the email").

export const OTP_EMAIL_SUBJECT = "Your Nominara sign-in code";

export interface OtpEmailInput {
  readonly code: string;
  readonly expiresInMinutes: number;
}

export interface RenderedOtpEmail {
  readonly subject: string;
  readonly textBody: string;
}

export function renderOtpEmail({ code, expiresInMinutes }: OtpEmailInput): RenderedOtpEmail {
  const textBody = `Your sign-in code is ${code}. It expires in ${expiresInMinutes} minutes. If you didn't request this, you can ignore this email.`;
  return { subject: OTP_EMAIL_SUBJECT, textBody };
}

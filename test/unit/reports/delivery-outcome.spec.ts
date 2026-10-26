import { describe, expect, it } from "vitest";
import { deliveryOutcome, sendReportEmails } from "../../../src/lib/reports/run-scheduled-report.js";
import { EmailSuppressedError, type EmailMessage, type EmailSender } from "../../../src/modules/identity/ports/email-sender.js";

// STORY-178 AC3 — what a delivery records when some recipients are suppressed. Counts only, never an address.
describe("STORY-178 · deliveryOutcome", () => {
  it("no suppression: the status and reasons are exactly what they were before", () => {
    expect(deliveryOutcome({ sent: 2, failed: 0, suppressed: 0 }, 2, true)).toEqual({ status: "delivered", reason: null });
    expect(deliveryOutcome({ sent: 2, failed: 0, suppressed: 0 }, 2, false)).toEqual({ status: "logged", reason: null });
    expect(deliveryOutcome({ sent: 1, failed: 1, suppressed: 0 }, 2, true)).toEqual({ status: "failed", reason: "1 of 2 recipients could not be sent" });
  });

  it("some suppressed, the rest sent: delivered (or logged) with a reason naming how many were not sent", () => {
    const reason = "1 of 3 recipients were not sent: their addresses are suppressed after a bounce or a spam complaint";
    expect(deliveryOutcome({ sent: 2, failed: 0, suppressed: 1 }, 3, true)).toEqual({ status: "delivered", reason });
    expect(deliveryOutcome({ sent: 2, failed: 0, suppressed: 1 }, 3, false)).toEqual({ status: "logged", reason });
  });

  it("all suppressed: failed, because nobody was mailed", () => {
    expect(deliveryOutcome({ sent: 0, failed: 0, suppressed: 1 }, 1, true)).toEqual({
      status: "failed",
      reason: "Not sent: all 1 recipients are suppressed after a bounce or a spam complaint",
    });
  });

  it("a failure alongside a suppression stays a failure and names both counts", () => {
    expect(deliveryOutcome({ sent: 0, failed: 1, suppressed: 1 }, 2, true)).toEqual({
      status: "failed",
      reason: "1 of 2 recipients could not be sent; 1 not sent because the address is suppressed",
    });
  });
});

describe("STORY-178 · sendReportEmails counts a suppression apart from a failure", () => {
  it("only an EmailSuppressedError is a suppression; any other rejection is a failure", async () => {
    const outcomes: Record<string, Error | undefined> = {
      "ok@example.test": undefined,
      "bounced@example.test": new EmailSuppressedError("bounce"),
      "flaky@example.test": new Error("provider down"),
    };
    const sender: EmailSender = {
      async send(message: EmailMessage) {
        const error = outcomes[message.to];
        if (error !== undefined) throw error;
      },
    };
    const result = await sendReportEmails(sender, { name: "R", recipients: Object.keys(outcomes) }, ["a1"], {});
    expect(result).toEqual({ sent: 1, failed: 1, suppressed: 1 });
  });
});

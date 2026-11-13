import { describe, expect, it } from "vitest";
import { sendReportEmails } from "../../../src/lib/reports/run-scheduled-report.js";
import { themeForEmail } from "../../../src/lib/theme/email-theme.js";
import type { EmailMessage, EmailSender } from "../../../src/modules/identity/ports/email-sender.js";

// STORY-097 AC1 / AC4 / scenario 15 - the sent message: themed HTML, the agency identity, and no platform brand once removed.
const plan = {
  items: [],
  store: { get: async () => Buffer.alloc(0), head: async () => ({ contentLength: 0, contentType: null, etag: null, serverSideEncryption: null }) },
  uploaded: async () => undefined,
};
const values = { color_primary: "#102030", color_accent: null, color_bg: null, color_fg: null, hide_nominara_brand: true, email_footer_html: "<p>Agency Ltd</p>" };

async function sent(theme: ReturnType<typeof themeForEmail>): Promise<EmailMessage> {
  const out: EmailMessage[] = [];
  const email: EmailSender = { async send(m) { out.push(m); } };
  await sendReportEmails(email, { name: "Monthly", recipients: ["a@example.test"] }, plan, { fromName: "Agency", replyTo: "r@agency.test", theme });
  return out[0]!;
}

describe("STORY-097 · the scheduled-report message carries the theme", () => {
  it("scenario 15 · agency display name and reply-to ride on the message; the themed HTML body is attached to it", async () => {
    const m = await sent(themeForEmail(values, true));
    expect(m.fromName).toBe("Agency");
    expect(m.replyTo).toBe("r@agency.test");
    expect(m.htmlBody).toContain("#102030");
    expect(m.htmlBody).toContain("Agency Ltd");
  });

  it("scenario 5 · with brand removal granted, subject, text and HTML name no platform", async () => {
    const m = await sent(themeForEmail(values, true));
    for (const part of [m.subject, m.textBody, m.htmlBody ?? ""]) expect(part).not.toMatch(/nominara/i);
  });

  it("scenario 4 · with the entitlement absent the stored flag is not honoured", async () => {
    const m = await sent(themeForEmail(values, false));
    expect(m.subject).toMatch(/nominara/i);
  });
});

describe("STORY-097 · one theme per run: the export build is given the report's own theme", () => {
  it("buildReportArtifacts passes the report's theme_id and id to every export (null theme = the default is chosen downstream)", async () => {
    const { buildReportArtifacts } = await import("../../../src/lib/reports/run-scheduled-report.js");
    const calls: unknown[][] = [];
    const exporter = { export: async (...a: unknown[]) => (calls.push(a), { export_id: `e${String(calls.length)}` }), uploaded: async () => undefined };
    const base = { id: "r1", name: "n", project_ids: ["p1", "p2"], cadence: "monthly", day_of_period: 1, send_hour_local: 8, timeframe: "30d", format: "both", recipients: [], include_sections: ["overview"], next_send_at: null, active: true };
    await buildReportArtifacts(exporter as never, { ...base, theme_id: "T" } as never);
    expect(calls).toHaveLength(4);
    for (const c of calls) expect(c[3]).toEqual({ scheduledReport: { id: "r1", themeId: "T" } });
    calls.length = 0;
    await buildReportArtifacts(exporter as never, { ...base, theme_id: null } as never);
    for (const c of calls) expect(c[3]).toEqual({ scheduledReport: { id: "r1", themeId: null } });
  });
});

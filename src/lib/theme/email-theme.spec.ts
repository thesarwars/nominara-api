import { describe, expect, it } from "vitest";
import { PLATFORM_DEFAULT_COLORS } from "./contrast.js";
import { renderReportEmail, themeForEmail, type ReportEmailInput } from "./email-theme.js";

// STORY-097 AC1 (themed email) and AC4 (brand removal in emails): the one render of the scheduled-report mail, from the stored theme.
const base: ReportEmailInput = {
  reportName: "Q3 client report",
  attachments: ["acme-2026-09.pdf"],
  links: [{ filename: "acme-2026-09.csv", url: "https://api.example.test/v1/report-links/ws/tok" }],
  linkTtlDays: 7,
  theme: themeForEmail(
    { color_primary: "#112233", color_accent: "#445566", color_bg: "#ffffff", color_fg: "#000000", hide_nominara_brand: false, email_footer_html: "<p>Questions? <a href=\"mailto:hi@agency.test\">Email us</a></p>" },
    false,
  ),
};

describe("STORY-097 · renderReportEmail", () => {
  it("scenario 1 · the HTML body draws with the stored theme's colours, and the text body is still present", () => {
    const out = renderReportEmail(base);
    expect(out.htmlBody).toContain("#112233");
    expect(out.htmlBody).toContain("#ffffff");
    expect(out.textBody).toContain("Q3 client report");
    expect(out.textBody).toContain("acme-2026-09.pdf");
    expect(out.textBody).toContain("https://api.example.test/v1/report-links/ws/tok");
  });

  it("scenario 1 · no stored theme falls back to the platform default colours", () => {
    const out = renderReportEmail({ ...base, theme: themeForEmail(undefined, false) });
    expect(out.htmlBody).toContain(PLATFORM_DEFAULT_COLORS.color_primary);
  });

  it("AC email footer · the stored footer is rendered (re-sanitised) into both bodies", () => {
    const out = renderReportEmail(base);
    expect(out.htmlBody).toContain("mailto:hi@agency.test");
    expect(out.textBody).toContain("Questions?");
  });

  it("AC email footer · a footer carrying a script is re-sanitised at render, whatever was stored", () => {
    const theme = themeForEmail({ ...baseValues(), email_footer_html: "<p>ok</p><script>alert(1)</script><a href=\"javascript:x\">x</a>" }, false);
    const out = renderReportEmail({ ...base, theme });
    expect(out.htmlBody).not.toMatch(/<script|javascript:/i);
  });

  it("the report name is escaped in the HTML body", () => {
    const out = renderReportEmail({ ...base, reportName: "<img src=x onerror=1>&co" });
    expect(out.htmlBody).not.toContain("<img");
    expect(out.htmlBody).toContain("&lt;img");
  });

  it("scenario 5 · brand removal with the entitlement: no platform name, asset or link in subject, text or HTML", () => {
    const theme = themeForEmail({ ...baseValues(), hide_nominara_brand: true }, true);
    const out = renderReportEmail({ ...base, theme });
    for (const part of [out.subject, out.textBody, out.htmlBody]) expect(part).not.toMatch(/nominara/i);
    expect(out.htmlBody).not.toMatch(/<img/i);
  });

  it("scenario 5 · brand removal stored but NOT granted now (a downgrade): the platform brand returns", () => {
    const theme = themeForEmail({ ...baseValues(), hide_nominara_brand: true }, false);
    const out = renderReportEmail({ ...base, theme });
    expect(out.subject).toMatch(/nominara/i);
  });

  it("scenario 4 · brand not removed: the subject and a footer line name the platform", () => {
    const out = renderReportEmail(base);
    expect(out.subject).toBe("Your scheduled Nominara report is ready");
    expect(out.htmlBody).toMatch(/nominara/i);
  });

  it("scenario 5 · request audit - the HTML makes no fetch of its own: no image, stylesheet, import, url() or script, and every link is a report link or the agency's footer link", () => {
    for (const hide of [true, false]) {
      const out = renderReportEmail({ ...base, theme: themeForEmail({ ...baseValues(), hide_nominara_brand: hide, email_footer_html: base.theme.footerHtml }, hide) });
      expect(out.htmlBody).not.toMatch(/<(img|link|script|iframe|style|object|embed|video|audio|source)\b|@import|url\(|\bsrc=/i);
      const hrefs = [...out.htmlBody.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
      expect(hrefs.sort()).toEqual(["https://api.example.test/v1/report-links/ws/tok", "mailto:hi@agency.test"].sort());
    }
  });

  it("empty collections · no attachments and no links renders without those sections", () => {
    const out = renderReportEmail({ ...base, attachments: [], links: [] });
    expect(out.textBody).not.toMatch(/Attached|Download/);
  });
});

function baseValues() {
  return { color_primary: null, color_accent: null, color_bg: null, color_fg: null, hide_nominara_brand: false, email_footer_html: null };
}

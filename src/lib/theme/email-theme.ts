import { sanitiseEmailFooter } from "./email-footer.js";
import { exportPaletteFrom, type ExportPalette, type StoredThemeValues } from "./export-palette.js";

// STORY-097 AC1 / AC4 - the scheduled-report email, drawn from the ONE stored theme (no second branding source).
//
// A pure function: the subject, a text body and an HTML body from the report's facts and a theme. Colours and the brand-removal
// switch come through `exportPaletteFrom` (so a downgrade stops honouring a stored `hide_nominara_brand`, exactly as the PDF
// does); the footer is the stored sanitised subset, RE-sanitised here so what was stored is never trusted to be safe.
//
// No image is ever referenced: an email client would have to fetch it from a host, and a platform asset is exactly what brand
// removal forbids. The agency shows as text (its display name is the From header, set by the sender).

export interface EmailTheme extends ExportPalette {
  /** The stored footer subset, or null. */
  readonly footerHtml: string | null;
}

export interface StoredEmailThemeValues extends StoredThemeValues {
  readonly email_footer_html: string | null;
}

/** `undefined` = no stored theme: the platform default look, brand shown. */
export function themeForEmail(theme: StoredEmailThemeValues | undefined, brandRemovalGranted: boolean): EmailTheme {
  return { ...exportPaletteFrom(theme, brandRemovalGranted), footerHtml: theme?.email_footer_html ?? null };
}

export interface ReportEmailInput {
  readonly reportName: string;
  readonly attachments: readonly string[];
  readonly links: readonly { readonly filename: string; readonly url: string }[];
  readonly linkTtlDays: number;
  readonly theme: EmailTheme;
}

export interface RenderedReportEmail {
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody: string;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function footerOf(theme: EmailTheme): { html: string; text: string } | undefined {
  if (theme.footerHtml === null) return undefined;
  const clean = sanitiseEmailFooter(theme.footerHtml);
  if (!clean.ok || clean.html.length === 0) return undefined;
  const text = clean.html
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|li)>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
  return { html: clean.html, text };
}

export function renderReportEmail(input: ReportEmailInput): RenderedReportEmail {
  const { theme } = input;
  const colours = {
    primary: theme.primary,
    background: theme.background,
    foreground: theme.foreground,
  };
  const subject = theme.showBrandLine ? "Your scheduled Nominara report is ready" : "Your scheduled report is ready";
  const footer = footerOf(theme);

  const lines = [`Your report "${input.reportName}" is ready.`];
  if (input.attachments.length > 0) lines.push("", "Attached:", ...input.attachments.map((f) => `- ${f}`));
  if (input.links.length > 0) {
    lines.push("", `Too large to attach. Download (each link is valid for ${String(input.linkTtlDays)} days):`, ...input.links.map((l) => `- ${l.filename}: ${l.url}`));
  }
  if (footer !== undefined) lines.push("", footer.text);
  if (theme.showBrandLine) lines.push("", "Sent with Nominara");
  const textBody = `${lines.join("\n")}\n`;

  const attached = input.attachments.length > 0 ? `<p>Attached:</p><ul>${input.attachments.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
  const linked =
    input.links.length > 0
      ? `<p>Too large to attach. Download (each link is valid for ${String(input.linkTtlDays)} days):</p><ul>${input.links
          .map((l) => `<li><a href="${esc(l.url)}" style="color:${colours.primary}">${esc(l.filename)}</a></li>`)
          .join("")}</ul>`
      : "";
  const htmlBody =
    `<!doctype html><html><body style="margin:0;padding:0;background:${colours.background};color:${colours.foreground};font-family:Inter,Arial,sans-serif">` +
    `<div style="border-top:6px solid ${colours.primary};padding:24px;max-width:600px">` +
    `<h1 style="margin:0 0 16px;font-size:20px;color:${colours.primary}">${esc(input.reportName)}</h1>` +
    `<p>Your report is ready.</p>${attached}${linked}` +
    (footer !== undefined ? `<div style="margin-top:24px;font-size:12px">${footer.html}</div>` : "") +
    (theme.showBrandLine ? `<p style="margin-top:24px;font-size:12px">Sent with Nominara</p>` : "") +
    `</div></body></html>`;
  return { subject, textBody, htmlBody };
}

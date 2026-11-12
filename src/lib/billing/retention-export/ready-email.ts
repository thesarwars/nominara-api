import type { RetentionExportCoverage } from "../../../../contracts/billing/retention-export.schema.js";
import type { EmailMessage } from "../../../modules/identity/ports/email-sender.js";

// STORY-185 - the delivery email to the person who requested the export. It says what the copy holds and until when the link works; the link is
// the authenticated API route (a fresh 15-minute presign is minted each time it is opened), never a bucket URL.

export const RETENTION_EXPORT_READY_SUBJECT = "Your full data export is ready";

const day = (iso: string): string => iso.slice(0, 10);
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

export function retentionExportReadyEmail(to: string, link: string, expiresAt: Date, coverage: RetentionExportCoverage, idempotencyKey: string): EmailMessage {
  const lines: string[] = [
    "The full copy of the data your plan change will remove is ready. It is one zip file with a folder per project.",
    "",
    `Download it (sign in first): ${link}`,
    `The link works until ${expiresAt.toISOString().slice(0, 10)}, the day the retention purge begins. Opening it gives a fresh download address that is valid for 15 minutes.`,
    "",
    "What it holds:",
  ];
  for (const p of coverage.projects) {
    const parts: string[] = [];
    if (p.raw_answers !== null) parts.push(`${plural(p.raw_answers.count, "raw answer", "raw answers")}${p.raw_answers.oldest === null || p.raw_answers.newest === null ? "" : ` (${day(p.raw_answers.oldest)} to ${day(p.raw_answers.newest)})`}`);
    if (p.rollups !== null) parts.push(`${plural(p.rollups.count, "rollup day", "rollup days")}${p.rollups.oldest === null || p.rollups.newest === null ? "" : ` (${p.rollups.oldest} to ${p.rollups.newest})`}`);
    if (p.attribution !== null) parts.push(`${plural(p.attribution.count, "attribution day", "attribution days")}`);
    lines.push(`  - ${p.name}: ${parts.join("; ")}`);
  }
  if (!coverage.complete) {
    const missing = coverage.projects.reduce((n, p) => n + (p.raw_answers?.unreadable ?? 0), 0);
    lines.push("", `${plural(missing, "raw answer could", "raw answers could")} not be read from storage and ${missing === 1 ? "is" : "are"} not in the file. manifest.json in the zip says which projects.`);
  }
  lines.push("", "It costs no credits.");
  return { to, subject: RETENTION_EXPORT_READY_SUBJECT, textBody: lines.join("\n"), idempotencyKey, transactional: true };
}

import { describe, expect, it } from "vitest";
import { retentionShorteningEmail } from "../../../src/lib/billing/retention-shortening.js";
import { retentionExportReadyEmail } from "../../../src/lib/billing/retention-export/ready-email.js";
import { retentionExportDownloadUrl } from "../../../src/lib/billing/retention-export/links.js";

// STORY-185 AC5 / STORY-077 R1 - the retention notice links to the full-data export ONLY once it exists.

const base = {
  fromPlanName: "Business",
  toPlanName: "Starter",
  purgeNotBefore: new Date("2026-11-27T09:30:00.000Z"),
  raw: {
    from: 395 as number | "unlimited" | null,
    to: 90 as number | "unlimited" | null,
    cutoff: new Date("2026-08-29T09:30:00.000Z"),
    projects: [{ projectId: "0198a1f0-0000-7000-8000-000000000001", name: "Acme", count: 3, oldest: new Date("2026-01-01T00:00:00Z"), newest: new Date("2026-02-01T00:00:00Z") }],
  },
  rollups: null,
};

describe("STORY-185 AC5 · the notice and the export link", () => {
  it("AC5 · with no export yet the notice says nothing about one", () => {
    expect(retentionShorteningEmail("o@example.com", base).textBody).not.toMatch(/export|download|copy/i);
  });

  it("AC5 · with an export that exists the notice carries its link and says until when", () => {
    const link = retentionExportDownloadUrl("https://api.example.test", "0198a1f0-0000-7000-8000-0000000000aa");
    const body = retentionShorteningEmail("o@example.com", { ...base, exportLink: link }).textBody;
    expect(body).toContain(link);
    expect(body).toContain("2026-11-27");
    expect(link).toBe("https://api.example.test/v1/billing/retention-export/0198a1f0-0000-7000-8000-0000000000aa/download");
  });
});

describe("STORY-185 · the delivery email", () => {
  const coverage = {
    generated_at: "2026-11-12T00:00:00.000Z",
    purge_not_before: "2026-11-27T00:00:00.000Z",
    complete: true,
    projects: [
      {
        project_id: "0198a1f0-0000-7000-8000-000000000001",
        name: "Acme",
        folder: "Acme-0198a1f0",
        raw_answers: { cutoff: "2026-08-29T00:00:00.000Z", count: 3, unreadable: 0, oldest: "2026-01-01T00:00:00.000Z", newest: "2026-02-01T00:00:00.000Z" },
        rollups: { cutoff: "2025-10-28T00:00:00.000Z", count: 10, oldest: "2025-01-01", newest: "2025-01-10" },
        attribution: null,
      },
    ],
  };

  it("names the link, the end date, what it holds per project and that it costs nothing; no bucket URL", () => {
    const m = retentionExportReadyEmail("o@example.com", "https://api.example.test/v1/billing/retention-export/x/download", new Date("2026-11-26T00:00:00Z"), coverage, "k");
    expect(m).toMatchObject({ to: "o@example.com", idempotencyKey: "k", transactional: true });
    expect(m.textBody).toContain("https://api.example.test/v1/billing/retention-export/x/download");
    expect(m.textBody).toContain("2026-11-26");
    expect(m.textBody).toContain("Acme: 3 raw answers (2026-01-01 to 2026-02-01); 10 rollup days (2025-01-01 to 2025-01-10)");
    expect(m.textBody).toContain("no credits");
    expect(m.textBody).not.toMatch(/X-Amz|s3\./);
  });

  it("says so when raw answers could not be read, never claiming a complete copy", () => {
    const partial = { ...coverage, complete: false, projects: [{ ...coverage.projects[0]!, raw_answers: { ...coverage.projects[0]!.raw_answers!, unreadable: 2 } }] };
    expect(retentionExportReadyEmail("o@example.com", "l", new Date(), partial, "k").textBody).toMatch(/2 raw answers could not be read/);
  });
});

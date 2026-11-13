import { describe, expect, it } from "vitest";
import { reportFileName } from "./artifact-filename.js";

describe("STORY-097 AC4 · reportFileName", () => {
  it("the platform brand shown keeps the existing name", () => {
    expect(reportFileName(true, "2026-10-31", "pdf")).toBe("nominara-report-2026-10-31.pdf");
    expect(reportFileName(true, "2026-10-31", "csv", "-2")).toBe("nominara-report-2026-10-31-2.csv");
  });
  it("brand removed: no platform name in the file name", () => {
    expect(reportFileName(false, "2026-10-31", "pdf")).toBe("report-2026-10-31.pdf");
    expect(reportFileName(false, "2026-10-31", "csv", "-2")).not.toMatch(/nominara/i);
  });
});

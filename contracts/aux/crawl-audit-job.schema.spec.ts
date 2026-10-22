import { describe, expect, it } from "vitest";
import { crawlAuditJobPayloadSchema } from "./crawl-audit-job.schema.js";

const base = {
  projectId: "0190b1c0-0000-7000-8000-000000000001",
  auditId: "0190b1c0-0000-7000-8000-000000000002",
  workspaceId: "0190b1c0-0000-7000-8000-000000000003",
  kid: "k1",
  trigger: "scheduled",
};

describe("STORY-049 · crawl.audit job payload", () => {
  it("AC5 · a payload with no scope still parses (the producer's default applies)", () => {
    expect(crawlAuditJobPayloadSchema.parse(base).scope).toBeUndefined();
  });

  it("AC5 · accepts the three scopes a producer may ask for", () => {
    for (const scope of ["key_pages", "single_url", "sitemap_sample"]) {
      const targetUrls = scope === "single_url" ? ["https://acme.com/pricing"] : undefined;
      expect(crawlAuditJobPayloadSchema.parse({ ...base, scope, ...(targetUrls ? { targetUrls } : {}) }).scope).toBe(scope);
    }
  });

  it("AC9 · a producer cannot ask for public_surface or domain_root: verification decides those, never the payload", () => {
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, scope: "public_surface" }).success).toBe(false);
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, scope: "domain_root" }).success).toBe(false);
  });

  it("AC5 · single_url needs exactly one target URL", () => {
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, scope: "single_url" }).success).toBe(false);
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, scope: "single_url", targetUrls: [] }).success).toBe(false);
    expect(
      crawlAuditJobPayloadSchema.safeParse({ ...base, scope: "single_url", targetUrls: ["https://acme.com/a", "https://acme.com/b"] }).success,
    ).toBe(false);
  });

  it("AC5 · targetUrls must be http(s) URLs and bounded", () => {
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, scope: "single_url", targetUrls: ["javascript:alert(1)"] }).success).toBe(false);
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, scope: "single_url", targetUrls: ["file:///etc/passwd"] }).success).toBe(false);
  });

  it("AC5 · an unknown key is still refused", () => {
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});

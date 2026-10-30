import { describe, expect, it } from "vitest";
import { crawlAuditJobPayloadSchema } from "./crawl-audit-job.schema.js";
import { triggerAuxAuditRequestSchema, triggerAuxAuditResponseSchema } from "./trigger-aux-audit.schema.js";

describe("AUXLIVE-3 · POST /projects/{id}/aux-audits request", () => {
  it("accepts an empty body (scope defaults to key_pages in the service)", () => {
    expect(triggerAuxAuditRequestSchema.parse({})).toEqual({});
  });

  it("accepts the three scopes a caller may ask for", () => {
    for (const scope of ["key_pages", "single_url", "sitemap_sample"]) {
      const target_urls = scope === "single_url" ? ["https://acme.com/pricing"] : undefined;
      expect(triggerAuxAuditRequestSchema.parse({ scope, ...(target_urls ? { target_urls } : {}) }).scope).toBe(scope);
    }
  });

  it("refuses public_surface and domain_root: verification decides those, never the request", () => {
    expect(triggerAuxAuditRequestSchema.safeParse({ scope: "public_surface" }).success).toBe(false);
    expect(triggerAuxAuditRequestSchema.safeParse({ scope: "domain_root" }).success).toBe(false);
  });

  it("single_url needs exactly one target URL", () => {
    expect(triggerAuxAuditRequestSchema.safeParse({ scope: "single_url" }).success).toBe(false);
    expect(triggerAuxAuditRequestSchema.safeParse({ scope: "single_url", target_urls: [] }).success).toBe(false);
    expect(triggerAuxAuditRequestSchema.safeParse({ scope: "single_url", target_urls: ["https://a.com/x", "https://a.com/y"] }).success).toBe(false);
  });

  it("target_urls must be http(s) and bounded at 50", () => {
    expect(triggerAuxAuditRequestSchema.safeParse({ target_urls: ["file:///etc/passwd"] }).success).toBe(false);
    expect(triggerAuxAuditRequestSchema.safeParse({ target_urls: ["javascript:alert(1)"] }).success).toBe(false);
    const fifty = Array.from({ length: 50 }, (_, i) => `https://acme.com/p${i}`);
    expect(triggerAuxAuditRequestSchema.safeParse({ target_urls: fifty }).success).toBe(true);
    expect(triggerAuxAuditRequestSchema.safeParse({ target_urls: [...fifty, "https://acme.com/x"] }).success).toBe(false);
  });

  it("an unknown key is a 400, not a silent drop (.strict())", () => {
    expect(triggerAuxAuditRequestSchema.safeParse({ credits: 0 }).success).toBe(false);
    expect(triggerAuxAuditRequestSchema.safeParse({ trigger: "onboarding" }).success).toBe(false);
  });
});

describe("AUXLIVE-3 · POST /projects/{id}/aux-audits response and job payload", () => {
  const ok = {
    audit_id: "0190b1c0-0000-7000-8000-000000000002",
    status: "queued",
    trigger: "manual",
    requested_scope: "key_pages",
    credits_charged: 10,
    pricing: { pages_priced: 25, base_credits: 10, base_page_band: 25, extra_page_credits: 1 },
  };

  it("a priced response parses and always names a charge of at least one credit", () => {
    expect(triggerAuxAuditResponseSchema.parse(ok).credits_charged).toBe(10);
    expect(triggerAuxAuditResponseSchema.safeParse({ ...ok, credits_charged: 0 }).success).toBe(false);
  });

  it("the response is strict", () => {
    expect(triggerAuxAuditResponseSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("the crawl.audit job payload accepts the manual trigger", () => {
    const base = { projectId: "0190b1c0-0000-7000-8000-000000000001", auditId: ok.audit_id, workspaceId: "0190b1c0-0000-7000-8000-000000000003", kid: "k" };
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, trigger: "manual" }).success).toBe(true);
    expect(crawlAuditJobPayloadSchema.safeParse({ ...base, trigger: "post_fix" }).success).toBe(false);
  });
});

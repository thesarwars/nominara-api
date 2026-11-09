import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { contrastRejectionDetailsSchema, updateAgencyThemeRequestSchema } from "./theme.schema.js";
import {
  mintShareTokenRequestSchema,
  mintedShareTokenSchema,
  shareTokenSchema,
  shareTokenViewSchema,
} from "./share-token.schema.js";
import { portalSessionRequestSchema, portalSessionResponseSchema } from "../portal/portal-session.schema.js";
import { portalProjectQuerySchema } from "../portal/portal-read.schema.js";
import { createScheduledReportRequestSchema, updateScheduledReportRequestSchema } from "../reports/scheduled-report.schema.js";
import { exportFeatureNotInPlanDetailsSchema, exportQuotaExceededDetailsSchema } from "../reports/export.schema.js";
import { methodologyFooterSchema } from "../reports/methodology-footer.schema.js";

const mint = {
  label: "Acme Q3",
  scope_project_ids: [randomUUID()],
  scope_tabs: ["overview", "growth_map"],
  hide_competitors: false,
  hide_costs: true,
  timeframe_lock: null,
  password: "correct horse",
  acknowledge_no_password: false,
  allowed_email_domains: [],
  max_views: null,
  expires_at: null,
};

function keysDeep(schemaJson: unknown, out = new Set<string>()): Set<string> {
  if (schemaJson && typeof schemaJson === "object") {
    for (const [k, v] of Object.entries(schemaJson)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

describe("Track E contracts (NEW-E-0)", () => {
  it("FR-AGY-01k: only MintedShareToken contains `secret`; ShareToken and views carry no secret or hash", () => {
    const props = (s: z.ZodType) => keysDeep(z.toJSONSchema(s));
    expect(props(mintedShareTokenSchema).has("secret")).toBe(true);
    for (const s of [shareTokenSchema, shareTokenViewSchema]) {
      const keys = props(s);
      expect(keys.has("secret")).toBe(false);
      expect(keys.has("token_hash")).toBe(false);
      expect(keys.has("password_hash")).toBe(false);
    }
  });

  it("STORY-098 s4: a passwordless mint requires the acknowledgement", () => {
    expect(mintShareTokenRequestSchema.safeParse({ ...mint, password: null }).success).toBe(false);
    expect(mintShareTokenRequestSchema.safeParse({ ...mint, password: null, acknowledge_no_password: true }).success).toBe(true);
  });

  it("STORY-098: the new tab vocabulary is accepted and the old one refused", () => {
    expect(mintShareTokenRequestSchema.safeParse({ ...mint, scope_tabs: ["matrix", "tasks", "sources"] }).success).toBe(true);
    expect(mintShareTokenRequestSchema.safeParse({ ...mint, scope_tabs: ["tracking"] }).success).toBe(false);
    expect(mintShareTokenRequestSchema.safeParse({ ...mint, scope_tabs: [] }).success).toBe(false);
  });

  it("KAD-05: request schemas are strict (an unknown key is refused, not dropped)", () => {
    expect(mintShareTokenRequestSchema.safeParse({ ...mint, workspace_id: randomUUID() }).success).toBe(false);
    expect(updateAgencyThemeRequestSchema.safeParse({ custom_css: "a{}" }).success).toBe(true); // STORY-097: a request field now, sanitised by the service
    expect(updateAgencyThemeRequestSchema.safeParse({ email_footer_css: "a{}" }).success).toBe(false);
    expect(updateAgencyThemeRequestSchema.safeParse({ logo_light_key: "x" }).success).toBe(false);
    expect(portalProjectQuerySchema.safeParse({ project: randomUUID(), workspace: "x" }).success).toBe(false);
  });

  it("D6: theme colours may be null (platform default) but not an invalid hex", () => {
    expect(updateAgencyThemeRequestSchema.safeParse({ color_primary: null }).success).toBe(true);
    expect(updateAgencyThemeRequestSchema.safeParse({ color_primary: "blue" }).success).toBe(false);
  });

  it("FR-AGY-01h: contrast rejection details carry the measurement and extend the validation shape", () => {
    const ok = {
      issues: [{ path: ["color_fg"], message: "contrast" }],
      measured_ratio: 2.77,
      threshold: 4.5,
      token: "color_fg_on_bg",
      suggestion: "#1e293b",
    };
    expect(contrastRejectionDetailsSchema.safeParse(ok).success).toBe(true);
    expect(contrastRejectionDetailsSchema.safeParse({ ...ok, suggestion: undefined }).success).toBe(false);
  });

  it("NFR-API-13: export refusal keeps feature_not_in_plan and quota_exceeded distinct", () => {
    expect(exportFeatureNotInPlanDetailsSchema.safeParse({ key: "exports.pdf_per_cycle", min_plan: "growth" }).success).toBe(true);
    expect(exportQuotaExceededDetailsSchema.safeParse({ metric: "pdf_exports", resets_at: "2026-11-01" }).success).toBe(true);
    expect(exportFeatureNotInPlanDetailsSchema.safeParse({ metric: "pdf_exports", resets_at: "2026-11-01" }).success).toBe(false);
  });

  it("NFR-AGY-05: absent is not zero in the footer (null data_through / live_capture_ratio)", () => {
    const base = {
      data_through: null,
      engines: ["gemini"],
      engine_data_sources: [{ engine_key: "gemini", data_source: "live" }],
      timeframe: "30d",
      sample_size: 0,
      live_capture_ratio: null,
      scoring_version: "v1",
      weight_overrides: null,
      note: "n",
    };
    expect(methodologyFooterSchema.safeParse(base).success).toBe(true);
    expect(methodologyFooterSchema.safeParse({ ...base, engine_data_sources: [{ engine_key: "gemini", data_source: "mock" }] }).success).toBe(false);
    for (const data_source of ["mixed", null]) {
      expect(methodologyFooterSchema.safeParse({ ...base, engine_data_sources: [{ engine_key: "gemini", data_source }] }).success).toBe(true);
    }
  });

  it("STORY-100: PATCH never applies create defaults; create does", () => {
    const patch = updateScheduledReportRequestSchema.parse({ paused: true });
    expect(patch).toEqual({ paused: true });
    expect(updateScheduledReportRequestSchema.safeParse({}).success).toBe(false);
    const created = createScheduledReportRequestSchema.parse({
      label: "Monthly",
      project_ids: [randomUUID()],
      sections: ["overview"],
      cadence: "monthly",
      day: 1,
      hour: 8,
      format: "both",
      recipients: ["a@example.com"],
    });
    expect(created.timeframe).toBe("30d");
    expect(created.theme_id).toBeNull();
  });

  it("STORY-098 s5: the session response carries no data beyond expiry", () => {
    expect(portalSessionResponseSchema.safeParse({ expires_at: new Date().toISOString(), projects: [] }).success).toBe(false);
  });

  it("STORY-098 s7: the session request takes an optional email, and still refuses an unknown key", () => {
    const secret = "s".repeat(43);
    expect(portalSessionRequestSchema.safeParse({ secret, password: "pw", email: "a@acme.test" }).success).toBe(true);
    expect(portalSessionRequestSchema.safeParse({ secret, email: "not-an-email" }).success).toBe(false);
    expect(portalSessionRequestSchema.safeParse({ secret, project_id: "x" }).success).toBe(false);
  });
});

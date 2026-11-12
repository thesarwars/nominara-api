import { describe, expect, it } from "vitest";
import {
  RETENTION_EXPORT_MAX_LIFETIME_DAYS,
  RETENTION_EXPORT_URL_SECONDS,
  retentionExportJobPayloadSchema,
  retentionExportRequestSchema,
  retentionExportSchema,
} from "./retention-export.schema.js";

const id = "0198a1f0-0000-7000-8000-000000000001";

describe("STORY-185 - the retention export contract", () => {
  it("AC6 · the request takes no input: an unknown key is a 400, not a silent drop", () => {
    expect(retentionExportRequestSchema.safeParse({}).success).toBe(true);
    expect(retentionExportRequestSchema.safeParse({ project_ids: [id] }).success).toBe(false);
  });

  it("AC3 · the link lifetime constants are the owner's: 14 days at most, a 15-minute presign", () => {
    expect(RETENTION_EXPORT_MAX_LIFETIME_DAYS).toBe(14);
    expect(RETENTION_EXPORT_URL_SECONDS).toBe(900);
  });

  it("the response is strict and a download_url is null until ready", () => {
    const row = { id, status: "building", requested_at: "2026-11-12T00:00:00.000Z", expires_at: "2026-11-26T00:00:00.000Z", ready_at: null, coverage: null, download_url: null, error_code: null };
    expect(retentionExportSchema.safeParse(row).success).toBe(true);
    expect(retentionExportSchema.safeParse({ ...row, object_key: "k" }).success).toBe(false);
    expect(retentionExportSchema.safeParse({ ...row, status: "paused" }).success).toBe(false);
  });

  it("the job payload carries ids only and refuses an unknown key", () => {
    expect(retentionExportJobPayloadSchema.safeParse({ workspaceId: id, kid: "k1", exportId: id }).success).toBe(true);
    expect(retentionExportJobPayloadSchema.safeParse({ workspaceId: id, kid: "k1", exportId: id, to: "a@b.c" }).success).toBe(false);
  });
});

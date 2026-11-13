import { z } from "zod";
import { EXPORT_DOWNLOAD_URL_SECONDS } from "../reports/export.schema.js";

// STORY-185 (owner decision 100(a)/(c), 2026-11-12) - the full-data export offered while a retention-shortening purge is pending.
//
//   GET  /v1/billing/retention-export                 (billing:read)   whether an export can be requested now, and the latest one
//   POST /v1/billing/retention-export                 (billing:write)  request it; 202 with the row. Always a background job.
//   GET  /v1/billing/retention-export/{id}/download   (billing:read)   302 to a FRESH 15-minute presign of the stored zip
//
// Owner and admin only (the billing permissions). Available only while `workspaces.retention_purge_not_before` is still ahead, whatever the NEW
// plan's export entitlements are (it is the customer's data and it is about to go), and for EVERY retention-shortening deferral, a plain cancellation
// to Free included. It costs 0 credits and takes no part of the report export (`/exports`): no PDF cap, no `export:data` entitlement, no wallet.
//
// One zip per workspace, a folder per project:
//   manifest.json                                  the coverage (below), also returned as `coverage`
//   <project-slug>-<id8>/answers.jsonl             one JSON object per raw capture older than the new raw window: the answer text as stored,
//                                                  and its parsed `mention_facts` and `citation_facts`
//   <project-slug>-<id8>/metric_daily.csv          rollup days older than the new rollup window
//   <project-slug>-<id8>/attribution_daily.csv     attribution days older than the new rollup window
//
// `superseded`: a ready export built for an EARLIER scope (a second retention shortening moved the cutoffs, so it no longer covers everything the purge will
// remove). It has no `download_url` and is not complete; `POST` builds a new one.
//
// `coverage` states what the zip holds per project, in the units the retention notice uses (raw captures; rollup DAYS; attribution DAYS), so the
// two can be read against each other. A section is null when that window was not shortened (nothing of that kind is purged).
// `complete` is false when a raw object a row points at could not be read: those captures are counted in `unreadable` and absent from the file,
// never silently dropped.

/** The link lives until the deferral ends, never longer than this. */
export const RETENTION_EXPORT_MAX_LIFETIME_DAYS = 14;
/** The presign the download route redirects to, minted fresh on every fetch. The same lifetime as a report download. */
export const RETENTION_EXPORT_URL_SECONDS = EXPORT_DOWNLOAD_URL_SECONDS;

export const retentionExportStatusSchema = z.enum(["requested", "building", "ready", "failed", "expired", "superseded"]);
export type RetentionExportStatus = z.infer<typeof retentionExportStatusSchema>;

const sectionBase = {
  /** Anything older than this goes at the first purge (the same cutoff the notice names). */
  cutoff: z.iso.datetime(),
  oldest: z.string().nullable(),
  newest: z.string().nullable(),
};

export const retentionExportRawSectionSchema = z.object({ ...sectionBase, count: z.number().int().nonnegative(), unreadable: z.number().int().nonnegative() }).strict();
export const retentionExportDaysSectionSchema = z.object({ ...sectionBase, count: z.number().int().nonnegative() }).strict();

export const retentionExportCoverageSchema = z
  .object({
    generated_at: z.iso.datetime(),
    purge_not_before: z.iso.datetime(),
    complete: z.boolean(),
    projects: z.array(
      z
        .object({
          project_id: z.uuid(),
          name: z.string(),
          folder: z.string(),
          raw_answers: retentionExportRawSectionSchema.nullable(),
          rollups: retentionExportDaysSectionSchema.nullable(),
          attribution: retentionExportDaysSectionSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type RetentionExportCoverage = z.infer<typeof retentionExportCoverageSchema>;

export const retentionExportSchema = z
  .object({
    id: z.uuid(),
    status: retentionExportStatusSchema,
    requested_at: z.iso.datetime(),
    /** When the link stops working: the end of the deferral, at most RETENTION_EXPORT_MAX_LIFETIME_DAYS after the request. */
    expires_at: z.iso.datetime(),
    ready_at: z.iso.datetime().nullable(),
    /** Null until the export is built. */
    coverage: retentionExportCoverageSchema.nullable(),
    /** The API download route; opening it redirects to a fresh presign. Null unless `status` is `ready`. */
    download_url: z.url({ protocol: /^https?$/ }).nullable(),
    /** A stable code when `status` is `failed`; never provider text. */
    error_code: z.string().nullable(),
  })
  .strict();
export type RetentionExport = z.infer<typeof retentionExportSchema>;

export const retentionExportViewSchema = z
  .object({
    /** True while a retention-shortening deferral is pending: an export can be requested (or is under way). */
    available: z.boolean(),
    /** The first purge date; null when no deferral is pending. */
    purge_not_before: z.iso.datetime().nullable(),
    /** The latest export of this workspace, or null. */
    export: retentionExportSchema.nullable(),
  })
  .strict();
export type RetentionExportView = z.infer<typeof retentionExportViewSchema>;

/** `POST /v1/billing/retention-export` takes no input: what is exported is decided by the pending purge, never by the caller. */
export const retentionExportRequestSchema = z.object({}).strict();
export type RetentionExportRequest = z.infer<typeof retentionExportRequestSchema>;

export const retentionExportParamsSchema = z.object({ id: z.uuid() }).strict();
export type RetentionExportParams = z.infer<typeof retentionExportParamsSchema>;

/** The signed tenant job's payload (`billing.retention_export`): the id only. The scope is read from the database inside the tenant context. */
export const retentionExportJobPayloadSchema = z.object({ workspaceId: z.uuid(), kid: z.string(), exportId: z.uuid() }).strict();
export type RetentionExportJobPayload = z.infer<typeof retentionExportJobPayloadSchema>;

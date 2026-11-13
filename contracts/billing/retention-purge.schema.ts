import { z } from "zod";

// STORY-096 AC3 (owner decision 100(h)) - `GET /v1/billing/retention-purge` (billing:read, owner and admin): the per-project purge list of a PENDING
// retention-shortening deferral, the same content as the notice email (STORY-077 slice B). Counts and dates only: no capture text, no ids.
//
// `purge_not_before` is the date the first purge may run, null when no deferral is in force (including once it has passed); the sections are then
// null too. A section is null when its window is not shortened. `from_days` null means "no limit" (the window being replaced was unbounded);
// `to_days` is always a finite day count. A section with no projects and `total` 0 is a real answer: nothing existing is older than the cutoff yet.
// `attribution` follows the rollup window and is null unless `rollups` is present. Rollup and attribution counts are DAYS, raw counts are captures.
export const retentionPurgeProjectSchema = z
  .object({
    /** A soft-deleted project is listed with "(deleted project)" appended: the sweep still expires its rows. */
    name: z.string(),
    count: z.number().int().positive(),
    oldest: z.iso.datetime(),
    newest: z.iso.datetime(),
  })
  .strict();

export const retentionPurgeSectionSchema = z
  .object({
    from_days: z.number().int().positive().nullable(),
    to_days: z.number().int().positive(),
    /** Anything older than this goes at the first purge (the window keeps moving, so each later night removes one more day). */
    cutoff: z.iso.datetime(),
    total: z.number().int().nonnegative(),
    projects: z.array(retentionPurgeProjectSchema),
  })
  .strict();

export const retentionPurgeResponseSchema = z
  .object({
    purge_not_before: z.iso.datetime().nullable(),
    raw: retentionPurgeSectionSchema.nullable(),
    rollups: retentionPurgeSectionSchema.nullable(),
    attribution: retentionPurgeSectionSchema.nullable(),
  })
  .strict();

export type RetentionPurgeSection = z.infer<typeof retentionPurgeSectionSchema>;
export type RetentionPurgeResponse = z.infer<typeof retentionPurgeResponseSchema>;

import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-077 D2 — the customer chooses what to keep before a downgrade's cut-over (owner approved 2026-10-20).
//   GET /v1/billing/subscription/change/keep   (billing:read)   what can be kept, the target's limits, the default, the choice
//   PUT /v1/billing/subscription/change/keep   (billing:write)  record the choice; answers the same view
//
// Both answer `409 plan_change_not_pending` unless a DOWNGRADE is pending (`subscriptions.pending_plan_change`).
//
// ⚠ WHAT "KEEP" MEANS. At the cut-over the projects and prompts named here are kept FIRST: everything else is paused
// (never deleted, marked `paused_by_downgrade_at`, resumed by a later upgrade) unless the target's limits still have room
// after the chosen items, which is filled with the most recently active of the rest - the same rule as no choice. So a
// choice that uses the whole allowance pauses exactly everything not chosen, and a later reconcile under the same limits
// changes nothing (a smaller choice would otherwise be undone by the next add-on change). Something created after the
// choice is not in it, so it is paused unless room is left.
//
// ⚠ THE CHOICE IS VALIDATED AGAINST THE TARGET PLAN'S RESOLVED LIMITS (the plan, the add-ons that survive the move, and
// the workspace's overrides): at most `limits.projects_keepable` projects, at most `limits.prompts_per_project` prompts in
// any one project, at most `limits.prompts_total` in all; every prompt must belong to a project in `project_ids`. A choice
// over a limit is `400 validation_failed` naming the field. If the limits fall further before the cut-over (an add-on
// removed), the cut-over keeps the most recently active of the chosen items up to the new limit.
//
// ⚠ A PROJECT THAT IS NOT TRACKING STILL HOLDS ITS SLOT. `projects.max` counts every non-deleted project (§14, the
// guards' count), so an ARCHIVED project, or one a PERSON paused, uses one of the target's project slots whatever its
// activity, and is never paused or resumed by billing. `limits.projects_keepable` is what is left for tracking projects:
// `limits.projects` minus those (never below 0; null = unlimited). The cut-over ranks them first, with or without a
// choice, so the default and the choice agree and a later reconcile under the same limits changes nothing. A chosen
// project a person pauses or archives after the choice is made holds its slot the same way: the cut-over does not give
// that slot to another project.
//
// ⚠ WITH NO CHOICE, the cut-over keeps the MOST RECENTLY ACTIVE items (owner decision 2026-10-20) and pauses the rest of
// the excess. "Last active" (`last_active_at`) is, for a project, its latest finished capture run (`capture_runs.finished_at`,
// status `completed` or `partial`); for a prompt, its latest answer capture (`answer_captures.captured_at`, status
// `captured`, `parsed` or a reused `skipped` cell - the rule freshness uses); null when there is none, which ranks below
// any activity. Equal activity (or none) falls back to the slice-A rule: the older row is kept, the most recently created
// is paused first. `default` is that dry run, today.
//
// The choice is cleared with the downgrade it was made for: cancelling it, or its cut-over, clears it.

/** Upper bounds on the request; far above any plan's own limits (Business: 5 projects, 250 prompts). */
export const DOWNGRADE_KEEP_MAX_PROJECTS = 500;
export const DOWNGRADE_KEEP_MAX_PROMPTS = 5_000;

const uniqueIds = (max: number) =>
  z
    .array(lowercaseUuidSchema)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { message: "ids must be unique" });

export const downgradeKeepRequestSchema = z
  .object({
    /** The projects that keep tracking after the cut-over. */
    project_ids: uniqueIds(DOWNGRADE_KEEP_MAX_PROJECTS),
    /** The prompts that keep tracking after the cut-over; each in one of `project_ids`. */
    prompt_ids: uniqueIds(DOWNGRADE_KEEP_MAX_PROMPTS),
  })
  .strict();

const keepSetSchema = z
  .object({
    project_ids: z.array(z.uuid()),
    prompt_ids: z.array(z.uuid()),
  })
  .strict();

const keepablePromptSchema = z
  .object({
    id: z.uuid(),
    text: z.string(),
    status: z.enum(["active", "paused"]),
    /** Paused by an earlier downgrade (resumable); a prompt a person paused is never listed. */
    paused_by_downgrade: z.boolean(),
    /** Null: never captured. */
    last_active_at: z.iso.datetime().nullable(),
  })
  .strict();

const keepableProjectSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: z.enum(["initializing", "active", "paused"]),
    /** Paused by an earlier downgrade (resumable); a project a person paused or archived is never listed. */
    paused_by_downgrade: z.boolean(),
    /** Null: no finished capture run. */
    last_active_at: z.iso.datetime().nullable(),
    /** Its prompts that can be kept: active, or paused by an earlier downgrade. Most recently active first. */
    prompts: z.array(keepablePromptSchema),
  })
  .strict();

export const downgradeKeepResponseSchema = z
  .object({
    target_plan_key: z.string().min(1),
    /** When the cut-over happens (the pending downgrade's `effective_at`). */
    effective_at: z.iso.datetime().nullable(),
    /** The target plan's resolved limits; null = unlimited. */
    limits: z
      .object({
        projects: z.number().int().nonnegative().nullable(),
        /** How many of `projects` a choice may name: `projects` minus the archived and person-paused projects, which hold their slots. */
        projects_keepable: z.number().int().nonnegative().nullable(),
        prompts_total: z.number().int().nonnegative().nullable(),
        prompts_per_project: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    /** Everything that can be kept: tracking now, or paused by an earlier downgrade. Most recently active first. */
    projects: z.array(keepableProjectSchema),
    /** What the cut-over keeps if no choice is made: the most recently active, up to the limits. */
    default: keepSetSchema,
    /** The recorded choice, or null (the default applies). Ids deleted since are dropped from it. */
    choice: keepSetSchema.extend({ chosen_at: z.iso.datetime() }).strict().nullable(),
  })
  .strict();

/**
 * The shape of `subscriptions.downgrade_keep` (jsonb, migration 0133). Bound to the intent it was made for: the cut-over
 * honours it only when adopting THAT intent, and it is cleared with the intent. Never leaves the API.
 */
export const downgradeKeepRecordSchema = z
  .object({
    /** `pending_plan_change.id` of the downgrade this choice is for. */
    intent_id: z.uuid(),
    project_ids: z.array(z.uuid()),
    prompt_ids: z.array(z.uuid()),
    chosen_at: z.iso.datetime(),
  })
  .strict();

export type DowngradeKeepRequest = z.infer<typeof downgradeKeepRequestSchema>;
export type DowngradeKeepResponse = z.infer<typeof downgradeKeepResponseSchema>;
export type DowngradeKeepRecord = z.infer<typeof downgradeKeepRecordSchema>;

import { z } from "zod";

// STORY-111 / NFR-CMP-08 / data-model.md section 7 "There is no content archive" - one entry of the purge journal, an append-only object in
// object storage OUTSIDE the database.
//
// IDENTIFIERS, A TIMESTAMP AND A REASON. NO CONTENT OF ANY KIND. The shape enforces that, not a convention: every field is a UUID, an
// ISO instant, or a member of a closed enum, and `.strict()` refuses a field nobody declared. A free-text reason is not allowed because free
// text is where content leaks in.

export const purgeJournalScopeSchema = z.enum(["project", "workspace"]);

export const purgeJournalReasonSchema = z.enum([
  "project_hard_deleted", // 30 days after the soft delete (data-model.md section 7)
  "workspace_deletion_executed", // at deletion_execute_at
]);
export type PurgeJournalReason = z.infer<typeof purgeJournalReasonSchema>;

export const purgeJournalEntrySchema = z
  .object({
    v: z.literal(1),
    id: z.uuid(),
    scope: purgeJournalScopeSchema,
    scope_id: z.uuid(),
    /** The owning workspace. For a workspace purge this equals `scope_id`. */
    workspace_id: z.uuid(),
    purged_at: z.iso.datetime(),
    reason: purgeJournalReasonSchema,
  })
  .strict();
export type PurgeJournalEntry = z.infer<typeof purgeJournalEntrySchema>;

/** What a caller supplies; the journal stamps `v`, `id` and `purged_at`. */
export const purgeJournalAppendSchema = z
  .object({
    scope: purgeJournalScopeSchema,
    scopeId: z.uuid(),
    workspaceId: z.uuid(),
    reason: purgeJournalReasonSchema,
  })
  .strict();
export type PurgeJournalAppend = z.infer<typeof purgeJournalAppendSchema>;

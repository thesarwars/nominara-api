import { z } from "zod";

// STORY-053 (aux-and-geo-analysis.md section 5; schemas/geo-and-vectors.md `patches`) — a copy-ready patch on the wire, and the
// guidance a finding carries when its rule has no patch.
//
// THERE IS NO REQUEST SCHEMA. A patch is made by the audit (the `crawl.audit` reconcile stage), never by a client: no route creates
// one, regenerates one, or edits one. `GET /v1/patches/{id}` and the `patch` on a finding are the only way out. That is deliberate:
// generation is free and happens as part of the diagnosis, and a client path to write a patch would be a path to put content into a
// "copy this" artifact that Nominara did not derive.
//
// A PATCH IS IMMUTABLE. A later audit that re-detects the finding with different content or a different precondition makes a NEW row;
// `earlier_patch_ids` names the ones before it, so the artifact a customer already copied is still retrievable.

export const AUX_PATCH_KINDS = ["markdown", "html_fragment", "jsonld", "robots"] as const;
export const auxPatchKindSchema = z.enum(AUX_PATCH_KINDS);

/** `sha256:` and 64 lower-case hex digits. */
const sha256TagSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Every `patches.preconditions` entry. `file_absent` carries no hash: the precondition is that the file does not exist yet. */
export const patchPreconditionSchema = z
  .object({
    kind: z.enum(["file_hash", "page_hash", "file_absent"]),
    value: sha256TagSchema.nullable(),
  })
  .strict();

/** `patches.reversal`: how to undo it. Present even in v1, where nothing applies automatically. */
export const patchReversalSchema = z
  .object({
    operation: z.enum(["remove_block", "delete_file", "replace_file", "remove_fragment", "remove_jsonld", "restore_jsonld"]),
    /** What to remove or put back; null when the operation needs none (delete_file). */
    content: z.string().nullable(),
  })
  .strict();

/** `patches.jsonld_blocks` elements: one JSON-LD object each. */
export const patchJsonldBlockSchema = z.record(z.string(), z.unknown());

/** `claim_requires_review` and `kept_existing:<path>`; an open list, so a string, not an enum. */
export const patchRiskFlagSchema = z.string().min(1).max(200);

export const auxPatchSchema = z
  .object({
    patch_id: z.string().uuid(),
    /** The finding that produced it; null if the finding was deleted since, or for an optimizer patch. */
    finding_id: z.string().uuid().nullable(),
    project_id: z.string().uuid(),
    rule_code: z.string().nullable(),
    kind: auxPatchKindSchema,
    target_url: z.string(),
    /** The customer's change detector: sha256 of the file or page the patch was made from. */
    content_before_hash: sha256TagSchema,
    content_after: z.string(),
    unified_diff: z.string().nullable(),
    jsonld_blocks: z.array(patchJsonldBlockSchema).nullable(),
    reversal: patchReversalSchema.nullable(),
    preconditions: z.array(patchPreconditionSchema),
    explanation: z.string().nullable(),
    /** Where every derived value came from: the page's own content or a named Nominara template. */
    derivation: z.string().nullable(),
    /** True when the patch touches a compliance, metric or pricing value. The copy control requires an acknowledgement first (EC-25). */
    requires_human_review: z.boolean(),
    review_reason: z.string().nullable(),
    risk_flags: z.array(patchRiskFlagSchema),
    /**
     * Does the file still look the way it did when the patch was made? true = unchanged, false = changed since (the patch may no
     * longer apply cleanly), null = not re-checked since the patch was made. null is not false.
     */
    page_matches: z.boolean().nullable(),
    /** Earlier patches for the same finding, newest first (at most 20). */
    earlier_patch_ids: z.array(z.string().uuid()),
    /** Generation is free and says so: the fix is never priced separately from the diagnosis. */
    free: z.literal(true),
    credits_charged: z.literal(0),
    created_at: z.string(),
  })
  .strict();

export type AuxPatch = z.infer<typeof auxPatchSchema>;

/** What a finding carries instead of a patch when its rule needs a human: structured steps and a link to the alignment analysis. */
export const auxGuidanceSchema = z
  .object({
    summary: z.string(),
    steps: z.array(z.string()).min(1),
    /** null where an alignment analysis would not help (a sitemap). `target_url` is null for a domain-level finding. */
    alignment_link: z.object({ path: z.string(), target_url: z.string().nullable() }).strict().nullable(),
  })
  .strict();

export type AuxGuidance = z.infer<typeof auxGuidanceSchema>;

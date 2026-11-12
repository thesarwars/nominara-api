import type { ClientBase } from "pg";
import { z } from "zod";
import { patchJsonldBlockSchema, patchPreconditionSchema, patchReversalSchema, patchRiskFlagSchema, type AuxPatch } from "../../../../contracts/aux/index.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { pageMatches, sha256Tag, type LatestAuditFacts } from "./precondition.js";

// STORY-053 / STORY-194 - the ONE patch reader. `AuxService` (the finding and `GET /patches/{id}`) and `TasksService` (the patch on a
// task row) both serve the same shape, so the shape is built here, from a tenant-context client the caller passes; nothing here opens a
// connection or makes a network call. Moved out of `aux.service.ts` unchanged so `TasksService` need not import `AuxService`
// (`AuxModule` already imports `TasksModule`).

/** STORY-053: how many earlier patches a patch names. Patches are never deleted, so the read is bounded rather than the table. */
export const EARLIER_PATCHES_MAX = 20;

export const PATCH_SELECT = `
  SELECT p.id, p.finding_id, p.project_id, p.rule_code, p.kind, p.target_url, p.content_before_hash, p.content_after, p.unified_diff,
         p.jsonld_blocks, p.reversal, p.preconditions, p.explanation, p.derivation, p.requires_human_review, p.review_reason,
         p.risk_flags, p.created_at
    FROM patches p`;

export interface PatchRow {
  id: string;
  finding_id: string | null;
  project_id: string;
  rule_code: string | null;
  kind: AuxPatch["kind"];
  target_url: string;
  content_before_hash: Buffer;
  content_after: string;
  unified_diff: string | null;
  jsonld_blocks: AuxPatch["jsonld_blocks"];
  reversal: AuxPatch["reversal"];
  preconditions: AuxPatch["preconditions"];
  explanation: string | null;
  derivation: string | null;
  requires_human_review: boolean;
  review_reason: string | null;
  risk_flags: string[];
  created_at: Date;
}

export function toPatch(row: PatchRow, audit: LatestAuditFacts | null, earlier: string[]): AuxPatch {
  return {
    patch_id: row.id,
    finding_id: row.finding_id,
    project_id: row.project_id,
    rule_code: row.rule_code,
    kind: row.kind,
    target_url: row.target_url,
    content_before_hash: sha256Tag(row.content_before_hash),
    content_after: row.content_after,
    unified_diff: row.unified_diff,
    jsonld_blocks: row.jsonld_blocks === null ? null : z.array(patchJsonldBlockSchema).parse(row.jsonld_blocks),
    reversal: row.reversal === null ? null : patchReversalSchema.parse(row.reversal),
    preconditions: z.array(patchPreconditionSchema).parse(row.preconditions),
    explanation: row.explanation,
    derivation: row.derivation,
    requires_human_review: row.requires_human_review,
    review_reason: row.review_reason,
    risk_flags: z.array(patchRiskFlagSchema).parse(row.risk_flags),
    page_matches: pageMatches({ kind: row.kind, contentBeforeHash: row.content_before_hash, preconditions: row.preconditions }, audit),
    earlier_patch_ids: earlier,
    free: true,
    credits_charged: 0,
    created_at: row.created_at.toISOString(),
  };
}

/** What the project's most recent finished audit saw of the files a patch is judged against. null = no audit has finished. */
export async function latestAuditFacts(client: ClientBase, projectId: string): Promise<LatestAuditFacts | null> {
  const audit = await client.query<{ robots_hash: Buffer | null; llms_txt_present: boolean | null }>(
    `SELECT robots_hash, llms_txt_present FROM aux_audits
      WHERE project_id = $1 AND status IN ('completed', 'partial')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId],
  );
  const row = audit.rows[0];
  return row === undefined ? null : { robotsHash: row.robots_hash, llmsTxtPresent: row.llms_txt_present };
}

/**
 * The newest patch of each finding, with the ids of the ones before it. One bounded query for the set (21 rows a finding at most), and
 * one for the project's latest audit, which is what `page_matches` is judged against. A latest patch made against a file that has since
 * changed is not offered: the audit would have made a new one, so its absence means today's gate refused or found nothing. It stays
 * readable by id.
 */
export async function latestPatches(client: ClientBase, projectId: string, findingIds: readonly string[], route: "finding" | "task"): Promise<Map<string, AuxPatch>> {
  const out = new Map<string, AuxPatch>();
  if (findingIds.length === 0) return out;
  const rows = await client.query<PatchRow & { rn: number }>(
    `SELECT * FROM (
       SELECT p.*, row_number() OVER (PARTITION BY p.finding_id ORDER BY p.created_at DESC, p.id DESC) AS rn
         FROM (${PATCH_SELECT} WHERE p.finding_id = ANY($1::uuid[])) p
     ) ranked WHERE rn <= ${EARLIER_PATCHES_MAX + 1} ORDER BY finding_id, rn`,
    [findingIds],
  );
  if (rows.rows.length === 0) return out;
  const audit = await latestAuditFacts(client, projectId);
  const grouped = new Map<string, (PatchRow & { rn: number })[]>();
  for (const row of rows.rows) grouped.set(row.finding_id!, [...(grouped.get(row.finding_id!) ?? []), row]);
  for (const [findingId, list] of grouped) {
    const patch = toPatch(list[0]!, audit, list.slice(1).map((r) => r.id));
    if (patch.page_matches !== false) out.set(findingId, patch);
  }
  incrementCounter("nominara_aux_patch_reads_total", { route });
  return out;
}

import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { CLAIM_BEARING_NODE_TYPES } from "../../../../contracts/analytics/index.js";
import { NotFoundError, PreconditionUnmetError } from "../../../api/errors/domain-errors.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { normalisePhrase } from "./phrases.js";

// STORY-192 - `POST /geo/alignment/{id}/patch`: an immutable, copy-ready patch with a precondition hash (aux-and-geo-analysis.md section 5;
// schemas/geo-and-vectors.md `patches`).
//
// NOTHING IS GENERATED (section 9, the anti-filler policy). The patch's content IS the customer's own draft, which they wrote to test a change:
// `content_after` is that text, verbatim. The concepts it adds are READ from it, not written for it: `applied_node_ids` are the semantic nodes
// whose phrase is in the draft and not in the live page, by the same exact-phrase test the analysis uses.
//
//   content_before_hash / preconditions   sha256 of the LIVE page text the draft was measured against: the customer's change detector
//   reversal                              `replace_file` with the live text: putting it back undoes the patch
//   alignment_before / alignment_projected the live baseline, and the DRAFT's own measured alignment (the embedding of text that exists,
//                                         not the modeled gain estimate)
//   risk_flags / requires_human_review    `claim_requires_review` when a compliance, metric or pricing concept is added (EC-25): the copy
//                                         control asks for an acknowledgement
//
// A patch is immutable (trigger `patches_immutable`): a second request makes a NEW row, so the artifact a customer already copied is still
// reconstructable. It charges nothing. The session's `status` is not changed (`patched` has no reader yet; that is an owner question).
//
// REFUSED, with `422 precondition_unmet` and `details.reason`: `session_not_ready` (the live analysis is not final), `no_draft`, and
// `draft_not_ready` (the draft was saved after the last measurement, or its vectors have not arrived): a patch is never cut from text that
// was not measured.

const tracer = trace.getTracer("nominara.geo-alignment");
const logger = new Logger("geo.alignment");

const REVIEW_REASON = "The patch adds a compliance, metric or pricing concept. Confirm it is accurate for your product before publishing.";
const DERIVATION = "The content is your own draft, unchanged. The concepts it adds were read from it by matching the phrases engines cite; nothing was written for you.";
const EXPLANATION = "Your draft, ready to copy. The precondition hash is that of the live page this draft was measured against, so you can tell whether the page changed since.";

interface SessionRow {
  workspace_id: string;
  project_id: string;
  prompt_cluster_id: string | null;
  target_url: string;
  live_content_md: string | null;
  draft_content_md: string | null;
  draft_state: string | null;
  analysis_state: string;
  baseline_alignment: number | null;
  current_alignment: number | null;
}

export async function createAlignmentPatch(tx: ClientBase, sessionId: string, createdBy: string | null): Promise<string> {
  return tracer.startActiveSpan("geo.alignment.create_patch", async (span) => {
    try {
      const id = await run(tx, sessionId, createdBy);
      incrementCounter("nominara_geo_alignment_patches_total");
      return id;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

const unmet = (reason: "session_not_ready" | "no_draft" | "draft_not_ready", message: string): InstanceType<typeof PreconditionUnmetError> =>
  new PreconditionUnmetError({ message, details: { reason } });

async function run(tx: ClientBase, sessionId: string, createdBy: string | null): Promise<string> {
  const found = await tx.query<SessionRow>(
    `SELECT app.current_workspace()::text AS workspace_id, project_id, prompt_cluster_id, target_url, live_content_md, draft_content_md, draft_state, analysis_state, baseline_alignment, current_alignment
       FROM geo_alignments WHERE id = $1 AND workspace_id = app.current_workspace() FOR SHARE`,
    [sessionId],
  );
  const s = found.rows[0];
  if (s === undefined) throw new NotFoundError({ message: "no such alignment session" });
  if (s.analysis_state !== "ready" || s.live_content_md === null) throw unmet("session_not_ready", "the live analysis is not final yet");
  if (s.draft_content_md === null) throw unmet("no_draft", "save a draft first: the patch is cut from it");
  if (s.draft_state !== "ready") throw unmet("draft_not_ready", "the draft has not been measured yet");

  const nodes = await tx.query<{ id: string; phrase_normalized: string; node_type: string }>(
    `SELECT id, phrase_normalized, node_type FROM semantic_nodes
      WHERE workspace_id = app.current_workspace() AND project_id = $1 AND prompt_cluster_id IS NOT DISTINCT FROM $2 AND collapsed_into_id IS NULL ORDER BY id`,
    [s.project_id, s.prompt_cluster_id],
  );
  const live = ` ${normalisePhrase(s.live_content_md)} `;
  const draft = ` ${normalisePhrase(s.draft_content_md)} `;
  const added = nodes.rows.filter((n) => {
    const needle = ` ${normalisePhrase(n.phrase_normalized)} `;
    return draft.includes(needle) && !live.includes(needle);
  });
  const claim = added.some((n) => (CLAIM_BEARING_NODE_TYPES as readonly string[]).includes(n.node_type));

  const beforeHash = createHashOf(s.live_content_md);
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO patches
       (workspace_id, project_id, session_id, target_url, kind, unified_diff, content_before_hash, content_after, jsonld_blocks, reversal, risk_flags,
        applied_node_ids, alignment_before, alignment_projected, created_by, requires_human_review, review_reason, explanation, derivation, preconditions)
     VALUES (app.current_workspace(), $1, $2, $3, 'markdown', NULL, $4, $5, NULL, $6::jsonb, $7::jsonb, $8::uuid[], $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
     RETURNING id`,
    [
      s.project_id, sessionId, s.target_url, beforeHash, s.draft_content_md,
      JSON.stringify({ operation: "replace_file", content: s.live_content_md }),
      JSON.stringify(claim ? ["claim_requires_review"] : []),
      added.map((n) => n.id), s.baseline_alignment, s.current_alignment, createdBy,
      claim, claim ? REVIEW_REASON : null, EXPLANATION, DERIVATION,
      JSON.stringify([{ kind: "page_hash", value: `sha256:${beforeHash.toString("hex")}` }]),
    ],
  );
  // The workspace ID and counts: never the URL, the page or the draft.
  logger.log({ event: "geo.alignment.patch_created", workspace_id: s.workspace_id, session_id: sessionId, added_nodes: added.length, requires_human_review: claim });
  return inserted.rows[0]!.id;
}

const createHashOf = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

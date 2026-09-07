import type { FunnelStage, IntentArchetype } from "../../../contracts/prompts/index.js";
import { uuidV7 } from "../ids/uuidv7.js";
import { GRAMMAR_VERSION } from "./archetypes.js";
import type { PrioritisedCandidate } from "./prioritise.js";
import { promptTextHash } from "./text-hash.js";

// STORY-045 — §4 step 8 PERSIST. The one place that knows how to write a
// `tracked_prompts` row.
//
// *** WHY THIS EXISTS AS A MODULE RATHER THAN AN INLINE INSERT. ***
//
// `tracked_prompts` has four NOT NULL columns with no database default that a
// caller must supply — `workspace_id`, `project_id`, `text`, and then
// `text_hash`, `intent_archetype` and `funnel_stage`. STORY-043's
// supplied-prompt insert (projects.service.ts) supplied none of the last
// three. Verified against the live database:
//
//   ERROR: null value in column "text_hash" of relation "tracked_prompts"
//   violates not-null constraint
//
// So `POST /v1/projects` with any `prompts` in the body has been failing since
// it shipped, and it is reachable from onboarding's project step.
//
// It survived two test suites because NEITHER EXECUTES THAT STATEMENT. The
// unit test asserts the SQL string contains `'manual'` against a stubbed
// client (projects.service.spec.ts scenario 8), and the integration test
// writes its own correct insert rather than calling the service
// (projects-prompts-captures.spec.ts). A statement that cannot run passes
// both. That gap is the reason this module exists: one statement, two
// callers, a column list asserted against the schema, and an integration test
// that actually executes it.

/**
 * The columns every insert supplies, in order.
 *
 * Exported so a test can assert the NOT NULL set is covered without parsing
 * SQL. Columns with a database default (`generation_source` has one, but it is
 * supplied anyway because the two callers differ on it) are included where
 * the value is a decision rather than a fallback.
 */
export const INSERT_PROMPT_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "generation_batch_id",
  "generation_source",
  "text",
  "text_hash",
  "intent_archetype",
  "funnel_stage",
  "generator_meta",
  "is_priority",
  "status",
] as const;

export type PromptGenerationSource = "generated" | "manual";
export type PromptStatus = "active" | "paused" | "archived";

export interface PromptRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly generationBatchId: string | null;
  readonly generationSource: PromptGenerationSource;
  readonly text: string;
  readonly textHash: Buffer;
  readonly intentArchetype: IntentArchetype;
  readonly funnelStage: FunnelStage;
  readonly generatorMeta: Readonly<Record<string, unknown>>;
  readonly isPriority: boolean;
  readonly status: PromptStatus;
}

/**
 * The statement and its parameters, in `INSERT_PROMPT_COLUMNS` order.
 *
 * No `ON CONFLICT`. `ux_prompts_project_hash` is unique on
 * `(project_id, text_hash) WHERE deleted_at IS NULL`, and a collision is a
 * real outcome the caller has to REPORT — `FR-FAN-01a`'s
 * `rejected_duplicate`, naming the prompt that was kept. Swallowing it here
 * with `DO NOTHING` would drop a variant silently and leave the response
 * claiming it was accepted.
 */
export function insertPromptStatement(row: PromptRow): { sql: string; params: readonly unknown[] } {
  const placeholders = INSERT_PROMPT_COLUMNS.map((_, index) => `$${String(index + 1)}`).join(", ");
  return {
    sql: `INSERT INTO tracked_prompts (${INSERT_PROMPT_COLUMNS.join(", ")}) VALUES (${placeholders})`,
    params: [
      row.id,
      row.workspaceId,
      row.projectId,
      row.generationBatchId,
      row.generationSource,
      row.text,
      row.textHash,
      row.intentArchetype,
      row.funnelStage,
      JSON.stringify(row.generatorMeta),
      row.isPriority,
      row.status,
    ],
  };
}

/**
 * A prompt the customer wrote by hand — STORY-043's `prompts` at creation,
 * and `POST /projects/{id}/prompts` later.
 *
 * `custom` is exactly what the sixteenth `intent_archetype` value exists for.
 * Labelling a hand-written prompt `recommendation` would report a provenance
 * that is not true, and the archetype is what the matrix filters and the
 * coverage row count.
 *
 * ACTIVE, not archived: a prompt the customer wrote is one they asked for.
 * That is the deliberate difference from a generated variant, which lands
 * `archived` per `FR-FAN-01g` and waits for activation.
 */
export function manualPromptRow(input: { workspaceId: string; projectId: string; text: string }): PromptRow {
  return {
    id: uuidV7(),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    generationBatchId: null,
    generationSource: "manual",
    text: input.text,
    textHash: promptTextHash(input.text).bytes,
    intentArchetype: "custom",
    // NOT NULL with no "unknown" member in its CHECK, so a hand-written
    // prompt has to be assigned a stage it does not actually declare.
    // `consideration` is the stage matching `topic_clusters
    // .commercial_intent`'s documented DEFAULT of 0.7 — the specification's
    // own neutral value for this concept. Recorded as an assumption below so
    // it reads as one rather than as a measurement.
    funnelStage: "consideration",
    generatorMeta: { source: "manual", funnel_stage_assumed: true },
    isPriority: false,
    status: "active",
  };
}

export interface GeneratedRowContext {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly generationBatchId: string;
}

/**
 * A generated variant.
 *
 * `generator_meta` carries everything the generator DECIDED that cannot be
 * recovered from the text afterwards: which surface, whether a model rewrote
 * it, which slot values went in, whether each of those was real context or
 * one of our derivations, and which grammar version produced it. Without the
 * slot record, "Best crm for mid market b2b saas teams?" cannot be checked
 * against the project it was generated for.
 *
 * The hash is taken from the FINAL text, after any naturalisation — dedupe has
 * to be about what was stored, not about the template it started as.
 */
export function promptRowFromCandidate(candidate: PrioritisedCandidate, context: GeneratedRowContext): PromptRow {
  return {
    id: uuidV7(),
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    generationBatchId: context.generationBatchId,
    generationSource: "generated",
    text: candidate.text,
    textHash: promptTextHash(candidate.text).bytes,
    intentArchetype: candidate.archetype,
    funnelStage: candidate.funnelStage,
    generatorMeta: {
      template_id: candidate.templateId,
      naturalized: candidate.naturalized,
      grammar_version: GRAMMAR_VERSION,
      brand_named: candidate.brandNamed,
      competitor_named: candidate.competitorNamed,
      used_anonymous_fallback: candidate.usedAnonymousFallback,
      anonymous_substitution: candidate.anonymousSubstitution,
      slots: candidate.slots,
    },
    isPriority: candidate.isPriority,
    // FR-FAN-01g — "All 15 variants are produced and persisted; the plan's
    // cap binds only at activation, and unactivated variants are stored
    // status='archived' for later activation at 0 credits." Generation
    // activates nothing, so every row is archived; that also keeps the pass
    // from consuming plan slots, since `PROMPT_OCCUPIES_SLOT` is
    // `status <> 'archived' AND deleted_at IS NULL`.
    status: "archived",
  };
}

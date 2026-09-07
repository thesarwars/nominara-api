import { describe, expect, it } from "vitest";
import { ARCHETYPES } from "./archetypes.js";
import { emitCandidates } from "./emit.js";
import { INSERT_PROMPT_COLUMNS, insertPromptStatement, manualPromptRow, promptRowFromCandidate } from "./persist.js";
import { prioritise } from "./prioritise.js";
import { resolveSlots, type SlotContext } from "./slots.js";
import { promptTextHash } from "./text-hash.js";

// STORY-045 — §4 step 8 PERSIST, and the ONE place that knows how to write a
// `tracked_prompts` row.
//
// *** WHY THIS IS A MODULE AND NOT AN INLINE INSERT. ***
//
// `tracked_prompts` has three NOT NULL columns with no defaults — `text_hash`,
// `intent_archetype`, `funnel_stage` — and STORY-043's supplied-prompt insert
// (projects.service.ts) supplied none of them. Verified against the live
// database: creating a project with any `prompts` in the body fails with
// `null value in column "text_hash" violates not-null constraint`. Shipped,
// and reachable from the onboarding project step.
//
// It survived two test suites because neither executes that statement. The
// unit test asserts the SQL STRING contains `'manual'` against a stubbed
// client, and the integration test writes its OWN correct insert rather than
// calling the service. The bug lived in the gap.
//
// So both callers now build their row here, and the column list is asserted
// against the schema's NOT NULL set rather than trusted.

const FULL: SlotContext = {
  brandName: "HubSpot CRM",
  categorySlug: "crm",
  competitors: ["Salesforce"],
  personas: ["marketing_director"],
  verticals: ["b2b_saas"],
  sizeBands: ["mid_market"],
  integrations: ["slack"],
  complianceTerms: ["soc2"],
  capabilities: ["pipeline_automation"],
};

const WS = "01a0676a-a3e5-7d2f-9da8-144bcae0adfd";
const PROJECT = "01a06ccd-9e37-7f0c-957b-195fa6d263dd";
const BATCH = "01a06ccd-0000-7000-8000-0000000000ff";

function candidates() {
  return prioritise(emitCandidates({ bag: resolveSlots(FULL), archetypes: ARCHETYPES, batchSize: 1 }).candidates, 6);
}

describe("STORY-045 · the insert statement covers every NOT NULL column", () => {
  it("names all three columns STORY-043's insert omitted", () => {
    // The regression guard. These are NOT NULL with no default, so any
    // statement missing one can never execute — and a stubbed client will
    // happily let it through.
    expect(INSERT_PROMPT_COLUMNS).toContain("text_hash");
    expect(INSERT_PROMPT_COLUMNS).toContain("intent_archetype");
    expect(INSERT_PROMPT_COLUMNS).toContain("funnel_stage");
  });

  it("names every NOT NULL column that has no database default", () => {
    // Transcribed from src/db/schema/prompts.ts, which is generated from the
    // migrations. `id`, `generation_source`, `generator_meta`, `is_priority`,
    // `status`, `created_at` and `updated_at` all carry defaults, so they are
    // optional to supply — the four below are not.
    for (const column of ["workspace_id", "project_id", "text", "text_hash", "intent_archetype", "funnel_stage"]) {
      expect(INSERT_PROMPT_COLUMNS, column).toContain(column);
    }
  });

  it("binds exactly as many parameters as it names columns", () => {
    const { sql, params } = insertPromptStatement(manualPromptRow({ workspaceId: WS, projectId: PROJECT, text: "best crm" }));
    expect(params).toHaveLength(INSERT_PROMPT_COLUMNS.length);
    // A placeholder count that disagrees with the column count is a
    // `bind message supplies N parameters` error at runtime, not a type error.
    expect(sql.match(/\$\d+/g)).toHaveLength(INSERT_PROMPT_COLUMNS.length);
    expect(sql).toContain("INSERT INTO tracked_prompts");
  });
});

describe("STORY-045 · manualPromptRow — STORY-043's supplied prompts", () => {
  it("hashes the text with the shared normaliser", () => {
    const row = manualPromptRow({ workspaceId: WS, projectId: PROJECT, text: "  Best CRM  " });
    expect(row.textHash.equals(promptTextHash("best crm").bytes)).toBe(true);
  });

  it("is `manual` and `custom`, never `generated`", () => {
    // `custom` is exactly what the sixteenth `intent_archetype` value exists
    // for: a hand-written prompt has no archetype the generator would have
    // chosen, and labelling it `recommendation` would report a provenance
    // that is not true.
    const row = manualPromptRow({ workspaceId: WS, projectId: PROJECT, text: "best crm" });
    expect(row.generationSource).toBe("manual");
    expect(row.intentArchetype).toBe("custom");
  });

  it("is ACTIVE, because a prompt the customer wrote is one they asked for", () => {
    // Distinct from a generated variant, which lands `archived` per
    // FR-FAN-01g and waits for activation.
    const row = manualPromptRow({ workspaceId: WS, projectId: PROJECT, text: "best crm" });
    expect(row.status).toBe("active");
  });

  it("carries no generation batch", () => {
    expect(manualPromptRow({ workspaceId: WS, projectId: PROJECT, text: "best crm" }).generationBatchId).toBeNull();
  });

  it("records that its funnel stage is not derived from anything", () => {
    // `funnel_stage` is NOT NULL and its CHECK has no "unknown" member, so a
    // hand-written prompt must be assigned one. `consideration` is chosen
    // because it is the stage matching `topic_clusters.commercial_intent`'s
    // documented DEFAULT of 0.7 — the specification's own neutral value for
    // this concept. Recorded in generator_meta so the assignment is visibly
    // an assumption rather than a measurement.
    const row = manualPromptRow({ workspaceId: WS, projectId: PROJECT, text: "best crm" });
    expect(row.funnelStage).toBe("consideration");
    expect(row.generatorMeta).toMatchObject({ funnel_stage_assumed: true });
  });
});

describe("STORY-045 · promptRowFromCandidate — generated variants", () => {
  it("lands every variant ARCHIVED, per FR-FAN-01g", () => {
    // "All 15 variants are produced and persisted; the plan's cap binds only
    // at activation, and unactivated variants are stored status='archived'".
    // Generation activates nothing — STORY-046 owns that — so every row is
    // archived and none of them consumes a plan slot
    // (`PROMPT_OCCUPIES_SLOT` is `status <> 'archived'`).
    for (const candidate of candidates()) {
      expect(promptRowFromCandidate(candidate, { workspaceId: WS, projectId: PROJECT, generationBatchId: BATCH }).status).toBe("archived");
    }
  });

  it("groups the pass under one generation_batch_id", () => {
    // The column's own comment: "groups one pass for review and undo".
    const rows = candidates().map((c) => promptRowFromCandidate(c, { workspaceId: WS, projectId: PROJECT, generationBatchId: BATCH }));
    expect(new Set(rows.map((r) => r.generationBatchId))).toEqual(new Set([BATCH]));
  });

  it("carries the archetype and stage the generator actually chose", () => {
    const [candidate] = candidates();
    const row = promptRowFromCandidate(candidate!, { workspaceId: WS, projectId: PROJECT, generationBatchId: BATCH });
    expect(row.intentArchetype).toBe(candidate!.archetype);
    expect(row.funnelStage).toBe(candidate!.funnelStage);
    expect(row.generationSource).toBe("generated");
  });

  it("records the full provenance in generator_meta", () => {
    // The column's comment is `{template_id, naturalized, …}`. Everything
    // here is a decision the generator made that cannot be recovered from the
    // text: which surface, whether a model rewrote it, which slot values went
    // in and whether each was real context or one of our derivations, and
    // which grammar version produced it.
    const [candidate] = candidates();
    const row = promptRowFromCandidate(candidate!, { workspaceId: WS, projectId: PROJECT, generationBatchId: BATCH });
    expect(row.generatorMeta).toMatchObject({
      template_id: candidate!.templateId,
      naturalized: false,
      grammar_version: expect.stringMatching(/^g\d+$/),
      brand_named: candidate!.brandNamed,
      competitor_named: candidate!.competitorNamed,
      used_anonymous_fallback: candidate!.usedAnonymousFallback,
      anonymous_substitution: candidate!.anonymousSubstitution,
      slots: candidate!.slots,
    });
  });

  it("propagates the priority flag the subset selection set", () => {
    const rows = candidates().map((c) => promptRowFromCandidate(c, { workspaceId: WS, projectId: PROJECT, generationBatchId: BATCH }));
    expect(rows.filter((r) => r.isPriority)).toHaveLength(6);
  });

  it("hashes the FINAL text, so a naturalised rewrite dedupes on what was stored", () => {
    const [candidate] = candidates();
    const rewritten = { ...candidate!, text: "which crm would you actually recommend?", naturalized: true };
    const row = promptRowFromCandidate(rewritten, { workspaceId: WS, projectId: PROJECT, generationBatchId: BATCH });
    expect(row.textHash.equals(promptTextHash(rewritten.text).bytes)).toBe(true);
    expect(row.generatorMeta).toMatchObject({ naturalized: true });
  });

  it("gives every row a distinct id", () => {
    const rows = candidates().map((c) => promptRowFromCandidate(c, { workspaceId: WS, projectId: PROJECT, generationBatchId: BATCH }));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("uses UUIDv7 ids, per KAD-15", () => {
    const [candidate] = candidates();
    const { id } = promptRowFromCandidate(candidate!, { workspaceId: WS, projectId: PROJECT, generationBatchId: BATCH });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

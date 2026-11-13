import { z } from "zod";
import { auxFindingSeveritySchema } from "../aux/site-file-finding.schema.js";
import { storedPresentationNotesSchema } from "./tool-run.schema.js";

// STORY-083 - Schema Builder: POST /v1/tools/schema-builder (owner decision 78a).
//
// BUILD AND CHECK RUN IN THE BROWSER. Pasted markup never reaches the server: this route is the explicit SAVE, and it carries FINDINGS ONLY. The request is
// `.strict()` and has no field that can hold markup, a snippet, a parser message or free text, so a client that sends any of those gets a 400 rather than a
// silently dropped key. The consequence a finding leads with is NOT taken from the client: the server writes it from the shared rule catalog (`rationale`),
// so the wording is the one the project findings list uses and a client cannot smuggle text through it.
//
// FREE. `credits_charged` is the literal 0 and the database refuses a debit on the row (`ck_tr_free_tools`).

/** The nine documented entity types (page-inventory.md FR-TL-04a; the vocabulary map in app-fnt-dev-main lib/tools/schema.ts). */
export const SCHEMA_BUILDER_ENTITY_TYPES = ["Organization", "LocalBusiness", "Product", "SoftwareApplication", "Service", "Article", "FAQPage", "HowTo", "Event"] as const;
export const schemaBuilderEntityTypeSchema = z.enum(SCHEMA_BUILDER_ENTITY_TYPES);

export const SCHEMA_BUILDER_MODES = ["build", "check"] as const;
export const schemaBuilderModeSchema = z.enum(SCHEMA_BUILDER_MODES);

/** The `structured_data` rules (AUX-R-008..018). AUX-R-013 is held (owner decision 2026-10-28 #8) and needs page text, so it is not accepted. */
export const SCHEMA_BUILDER_RULE_CODES = ["AUX-R-008", "AUX-R-009", "AUX-R-010", "AUX-R-011", "AUX-R-012", "AUX-R-014", "AUX-R-015", "AUX-R-016", "AUX-R-017", "AUX-R-018"] as const;
export const schemaBuilderRuleCodeSchema = z.enum(SCHEMA_BUILDER_RULE_CODES);

export const SCHEMA_BUILDER_MAX_FINDINGS = 50;

/** Where a parse finding sits in the pasted text: numbers only, so it can name the position without carrying any of the text. */
export const schemaBuilderPositionSchema = z.object({ line: z.number().int().min(1).max(1_000_000), column: z.number().int().min(1).max(1_000_000) }).strict();

export const schemaBuilderSaveFindingSchema = z
  .object({
    rule_code: schemaBuilderRuleCodeSchema,
    severity: auxFindingSeveritySchema,
    position: schemaBuilderPositionSchema.nullable(),
    /** The property the finding is about (`offers.price`): a property path, never a value. */
    field: z.string().regex(/^[A-Za-z@][A-Za-z0-9@_.]{0,79}$/).nullable(),
  })
  .strict();

export const schemaBuilderRequestSchema = z
  .object({
    mode: schemaBuilderModeSchema,
    /** Required for `build`, and `null` for `check` (a check names no entity type). */
    entity_type: schemaBuilderEntityTypeSchema.nullable(),
    /** The versioned vocabulary map the browser checked against. */
    vocab_version: z.string().regex(/^schema-vocab@\d{4}\.\d{2}$/),
    findings: z.array(schemaBuilderSaveFindingSchema).max(SCHEMA_BUILDER_MAX_FINDINGS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "build" && value.entity_type === null) ctx.addIssue({ code: "custom", path: ["entity_type"], message: "a build names its entity type" });
    if (value.mode === "check" && value.entity_type !== null) ctx.addIssue({ code: "custom", path: ["entity_type"], message: "a check names no entity type" });
  });

/** A saved finding. The consequence is first, the rule code is a reference, never the headline (FR-TL-04c). */
export const schemaBuilderFindingSchema = z
  .object({
    consequence: z.string().min(1),
    title: z.string().min(1),
    rule_code: schemaBuilderRuleCodeSchema,
    severity: auxFindingSeveritySchema,
    position: schemaBuilderPositionSchema.nullable(),
    field: z.string().nullable(),
  })
  .strict();

/** `tool_runs.result_json`: findings only, never markup. */
export const schemaBuilderStoredResultSchema = z
  .object({
    schema_version: z.literal(1),
    mode: schemaBuilderModeSchema,
    entity_type: schemaBuilderEntityTypeSchema.nullable(),
    vocab_version: z.string(),
    findings: z.array(schemaBuilderFindingSchema).max(SCHEMA_BUILDER_MAX_FINDINGS),
    /** STORY-095 AC9: the notes the run was written with (absent on a run stored before the key existed). */
    presentation_notes: storedPresentationNotesSchema.optional(),
  })
  .strict();

export const SCHEMA_BUILDER_STATEMENT = "Checked in your browser: the markup you pasted was not sent to Nominara, and only these findings were saved.";

export const schemaBuilderResponseSchema = z
  .object({
    id: z.uuid(),
    tool_key: z.literal("schema_builder"),
    mode: schemaBuilderModeSchema,
    entity_type: schemaBuilderEntityTypeSchema.nullable(),
    vocab_version: z.string(),
    findings: z.array(schemaBuilderFindingSchema),
    credits_charged: z.literal(0),
    not_tracked: z.literal(true),
    not_tracked_note: z.string().min(1),
    did_not_check: z.string().min(1),
    statement: z.literal(SCHEMA_BUILDER_STATEMENT),
  })
  .strict();

export type SchemaBuilderRequest = z.infer<typeof schemaBuilderRequestSchema>;
export type SchemaBuilderSaveFinding = z.infer<typeof schemaBuilderSaveFindingSchema>;
export type SchemaBuilderFinding = z.infer<typeof schemaBuilderFindingSchema>;
export type SchemaBuilderStoredResult = z.infer<typeof schemaBuilderStoredResultSchema>;
export type SchemaBuilderResponse = z.infer<typeof schemaBuilderResponseSchema>;

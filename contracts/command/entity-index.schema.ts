import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-085 AC3 - GET /v1/command/entities: the prefetched index the bar resolves names against.
// Bounded per kind (ENTITY_INDEX_LIMIT_PER_KIND, newest first) so a large workspace never ships an unbounded
// payload; `truncated` says which kinds hit the bound, so a client knows its index is partial and can fall back
// to the server parse rather than read a miss as "no such entity".

export const ENTITY_INDEX_KINDS = ["project", "competitor", "prompt", "tool_run"] as const;
export const entityIndexKindSchema = z.enum(ENTITY_INDEX_KINDS);
export type EntityIndexKind = z.infer<typeof entityIndexKindSchema>;

export const ENTITY_INDEX_LIMIT_PER_KIND = 200;
/** A prompt's text is cut here: the index matches names, it does not carry answers' worth of text. */
export const ENTITY_INDEX_NAME_MAX = 120;

export const entityIndexEntrySchema = z
  .object({
    kind: entityIndexKindSchema,
    id: lowercaseUuidSchema,
    name: z.string().max(ENTITY_INDEX_NAME_MAX),
    /** The owning project, or null for a project itself and for a tool run (tool runs belong to the workspace). */
    project_id: lowercaseUuidSchema.nullable(),
  })
  .strict();

export const entityIndexResponseSchema = z
  .object({
    entities: z.array(entityIndexEntrySchema),
    limit_per_kind: z.number().int().positive(),
    truncated: z
      .object({
        project: z.boolean(),
        competitor: z.boolean(),
        prompt: z.boolean(),
        tool_run: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type EntityIndexEntry = z.infer<typeof entityIndexEntrySchema>;
export type EntityIndexResponse = z.infer<typeof entityIndexResponseSchema>;

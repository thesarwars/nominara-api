import { z } from "zod";

// NEW-A-5 — the per-engine provenance marker.
//
// Only Gemini has a real adapter this week; the other engines carry
// demo-seeded captures (STORY-169, `answer_captures.normalizer_version =
// 'demo-seed'`). A number that can mix the two must say so on the wire, or an
// invented figure reads as a measured one.
//
//   live   every measured capture behind this figure came from a real engine
//   demo   every measured capture behind it is demo-seeded
//   mixed  both kinds contributed (only possible above a single capture)
//   null   NOTHING WAS MEASURED. Absence, not "demo": a cell never captured
//          stays pending, and a null here must never be read as either value.
export const dataSourceSchema = z.enum(["live", "demo", "mixed"]);

export const engineDataSourceSchema = z
  .object({
    engine_key: z.string().min(1),
    data_source: dataSourceSchema.nullable(),
  })
  .strict();

/**
 * Disclosure for a blended figure: the blend INCLUDES demo engines (the policy
 * is stated, not implied) and says how many of them there were, so a headline
 * number is never unlabelled when fabricated answers fed it.
 */
export const blendDisclosureSchema = z
  .object({
    policy: z.literal("all_measured_engines"),
    live_engines: z.number().int().nonnegative(),
    demo_engines: z.number().int().nonnegative(),
    mixed_engines: z.number().int().nonnegative(),
  })
  .strict();

export type DataSource = z.infer<typeof dataSourceSchema>;
export type EngineDataSource = z.infer<typeof engineDataSourceSchema>;
export type BlendDisclosure = z.infer<typeof blendDisclosureSchema>;

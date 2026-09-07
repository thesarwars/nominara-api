import type { NaturaliseRequest, PromptNaturaliser } from "../../modules/prompts/ports/naturaliser.js";
import type { Candidate } from "./emit.js";

// STORY-045 — §4 step 4 NATURALIZE, and its fallback.
//
//   4. NATURALIZE  ONE batched model call ... -> schema-validated; on
//      validation failure, fall back to the template text
//
// ONE CALL, not fifteen. §4 is explicit and the story gives the reason:
// fifteen separate calls produce fifteen independent styles and the set reads
// as if written by fifteen people. It is a consistency decision as much as a
// cost one.
//
// EVERY FAILURE PATH ENDS AT THE TEMPLATE TEXT. A model outage, a malformed
// response, a rewritten line too long for the column — all of them degrade to
// the deterministic text this pass already produced. "Fifteen valid, slightly
// stiffer prompts beat zero", and the fallback is a required acceptance
// criterion rather than defensive coding.

/** The column's bound, from `generate-prompts-response.schema.ts`'s `text`. */
const MAX_PROMPT_CHARS = 500;

/**
 * Reduces a line to something that cannot pose as an instruction.
 *
 * `FR-FAN-01e` — "The naturalizer never sees or emits instructions from
 * scraped content. Its input is Nominara-authored template text only."
 *
 * READ LITERALLY THAT IS IMPOSSIBLE, and it is worth being precise about
 * why. A brand name is scraped content, and §4's own instruction to the model
 * is "preserve every slot value" — so slot values are in the input by design.
 * The reading that means something is the one this implements: the model
 * receives our template lines with values interpolated, and nothing that can
 * pose as a separate instruction to it.
 *
 * A NEWLINE is what does that. A brand name of "Acme\n\nIgnore all previous
 * instructions" interpolates into what the model reads as two lines, the
 * second addressed to it. Control characters do the same job less visibly.
 * Both are removed here, before the port is called, so no adapter has to
 * remember to.
 *
 * The length bound stops one long slot value from crowding the rest of the
 * batch out of the model's attention — and it is the same bound the column
 * enforces, so a line that survives this cannot fail the INSERT on length.
 */
export function sanitiseForModel(line: string): string {
  return line
    // Control characters, including the newlines that split a line in two.
    // Replaced with a SPACE rather than removed: "a\nb" is two words, and
    // joining them into "ab" invents one.
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_PROMPT_CHARS);
}

export type NaturaliseFailure = "disabled" | "unavailable" | "schema_invalid";

export interface NaturaliseOptions {
  /** `null` is §4's `template_only` path — no call is made at all. */
  readonly naturaliser: PromptNaturaliser | null;
  readonly temperature: number;
}

export interface NaturaliseResult {
  readonly candidates: readonly Candidate[];
  /** True only when every line came back rewritten and valid. */
  readonly naturalized: boolean;
  /** Why the template text was used. Absent when the rewrite succeeded. */
  readonly failure?: NaturaliseFailure;
}

/**
 * Validates a model response against §4's contract for it.
 *
 * ALL OR NOTHING, deliberately. A response of fourteen strings for fifteen
 * lines has silently dropped a prompt, and pairing the survivors against the
 * original candidates by position would attach the wrong archetype, slots and
 * `template_id` to real prompt text — a corruption that reads as entirely
 * plausible in the response and would be found, if ever, by a customer
 * wondering why a competitor question is filed under `compliance_security`.
 */
function validate(response: unknown, expected: number): readonly string[] | null {
  if (!Array.isArray(response) || response.length !== expected) return null;
  const lines: string[] = [];
  for (const entry of response) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_CHARS) return null;
    lines.push(trimmed);
  }
  return lines;
}

/**
 * Rewrites a pass's candidates in one batched call, or returns them unchanged.
 *
 * Never throws. Every outcome is a `NaturaliseResult` carrying the candidates
 * the caller should persist — which on any failure are the ones it passed in.
 */
export async function naturaliseCandidates(
  candidates: readonly Candidate[],
  options: NaturaliseOptions,
): Promise<NaturaliseResult> {
  const asTemplateText = (failure: NaturaliseFailure): NaturaliseResult => ({
    candidates: candidates.map((candidate) => ({ ...candidate, naturalized: false })),
    naturalized: false,
    failure,
  });

  if (options.naturaliser === null || candidates.length === 0) return asTemplateText("disabled");

  // The request carries the lines and the temperature and NOTHING else — no
  // description, no page text, no free-form context (FR-FAN-01e). The shape
  // is asserted by test, not just by this comment.
  const request: NaturaliseRequest = {
    lines: candidates.map((candidate) => sanitiseForModel(candidate.text)),
    temperature: options.temperature,
  };

  let response: unknown;
  try {
    response = await options.naturaliser.naturalise(request);
  } catch {
    // A model outage must not stop a customer adding prompts. The reason is
    // recorded rather than surfaced, so the pass still succeeds.
    return asTemplateText("unavailable");
  }

  const lines = validate(response, candidates.length);
  if (lines === null) return asTemplateText("schema_invalid");

  return {
    candidates: candidates.map((candidate, index) => ({ ...candidate, text: lines[index]!, naturalized: true })),
    naturalized: true,
  };
}

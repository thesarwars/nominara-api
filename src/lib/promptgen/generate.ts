import { createHash } from "node:crypto";
import type {
  ArchetypeCoverage,
  GeneratableArchetype,
  GenerationSummary,
  RejectedCandidate,
} from "../../../contracts/prompts/index.js";
import type { PromptNaturaliser } from "../../modules/prompts/ports/naturaliser.js";
import { ARCHETYPES, ARCHETYPE_BY_KEY, GRAMMAR_VERSION } from "./archetypes.js";
import { emitCandidates, type Candidate } from "./emit.js";
import { naturaliseCandidates } from "./naturalise.js";
import { normalizeTopic } from "./normalize.js";
import { promptRowFromCandidate, type PromptRow } from "./persist.js";
import { prioritise, type PrioritisedCandidate } from "./prioritise.js";
import { resolveSlots, type SlotContext } from "./slots.js";
import { promptTextHash } from "./text-hash.js";

// STORY-045 — §4's pipeline, steps 1 through 8, composed.
//
//   1. NORMALIZE  2. RESOLVE SLOTS  3. TEMPLATE EMIT  4. NATURALIZE
//   5. DEDUPE     6. CLASSIFY       7. PRIORITISE     8. PERSIST
//
// PURE APART FROM THE INJECTED PORTS. `existingHashes` arrives as a value
// rather than being queried for here, and the L5 cache is a two-method port.
// So the whole pipeline — including the backfill loop, which is
// the part most likely to spin or to drop a variant — is exercised without a
// database, and the service above stays a thin wrapper over one query, one
// call and one transaction.
//
// WHAT IS NOT HERE, and is named rather than left as a silence:
//
//   Vector dedupe. §4 step 5 is "embed all 15 in one batched call ->
//   pgvector cosine ... reject at cosine >= 0.92". Nothing computes an
//   embedding (`G3`, STORY-133), so what runs is exact `text_hash` dedupe
//   against `ux_prompts_project_hash` — real, and enough to keep the INSERT
//   from failing, but it catches only identical questions. `novelty` is
//   reported null rather than 0 for exactly this reason: see the response
//   contract.

/** `text_hash` hex -> the id of the prompt that owns it. */
export type ExistingHashes = ReadonlyMap<string, string> | ReadonlySet<string>;

export interface GeneratePassInput {
  readonly generationBatchId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly context: SlotContext;
  /**
   * Every live `text_hash` in the project, so a collision is caught before
   * the INSERT rather than as a unique-violation that fails the whole pass.
   * A Map also carries the colliding prompt's id, which
   * `rejected[].conflicting_prompt_id` reports; a Set is accepted for callers
   * that have no id to give.
   */
  readonly existingHashes: ExistingHashes;
  readonly batchSize: number;
  readonly prioritySubsetSize: number;
  readonly naturaliser: PromptNaturaliser | null;
  readonly temperature: number;
  readonly topicHint?: string;
  readonly locale?: string;
  readonly includeArchetypes?: readonly GeneratableArchetype[];
  readonly excludeArchetypes?: readonly GeneratableArchetype[];
  /**
   * §8's L5 template cache.
   *
   * A narrow two-method port, not the `Cache` interface itself: this file
   * takes no view on Valkey, namespacing or TTL. The service's adapter
   * applies `l5TemplateCacheKey`'s tenant scoping and §8's thirty days, so
   * the SUFFIX built here stays the one logical key and there is no second
   * key format to keep in step.
   *
   * Absent means "do not cache", which is what a `template_only` pass wants —
   * there is nothing worth caching when no model ran.
   */
  readonly cache?: TemplateCache;
}

export interface TemplateCache {
  get(key: string): Promise<readonly string[] | undefined>;
  set(key: string, lines: readonly string[]): Promise<void>;
}

export interface GeneratePass {
  readonly rows: readonly PromptRow[];
  readonly candidates: readonly PrioritisedCandidate[];
  readonly rejected: readonly RejectedCandidate[];
  readonly coverage: readonly ArchetypeCoverage[];
  readonly summary: GenerationSummary;
  readonly cached: boolean;
  readonly topicNorm: string;
}

function conflictingId(existing: ExistingHashes, hash: string): string | null {
  if (existing instanceof Map) return existing.get(hash) ?? null;
  return null;
}

function has(existing: ExistingHashes, hash: string): boolean {
  return existing instanceof Map ? existing.has(hash) : existing.has(hash);
}

/** The archetypes this pass covers, in §4's table order. */
function effectiveArchetypes(input: GeneratePassInput) {
  const include = new Set<GeneratableArchetype>(input.includeArchetypes ?? ARCHETYPES.map((a) => a.key));
  const exclude = new Set<GeneratableArchetype>(input.excludeArchetypes ?? []);
  const ordered = (input.includeArchetypes ?? ARCHETYPES.map((a) => a.key)).filter(
    (key) => include.has(key) && !exclude.has(key),
  );
  return ordered.map((key) => ARCHETYPE_BY_KEY[key]);
}

/**
 * Emits, dedupes, and backfills until nothing more can be accepted.
 *
 * `FR-FAN-01a` — "Exactly 15 accepted variants per pass unless dedupe rejects
 * some, in which case the engine backfills from secondary templates until 15
 * are accepted or all templates are exhausted — then it returns fewer and
 * reports `rejected_duplicate`."
 *
 * THE LOOP HAS TO TERMINATE, and the guard is that every round adds at least
 * one id to `skip` or ends. A round which rejects nothing is done; a round
 * which rejects something has strictly fewer surfaces available next time,
 * and each archetype has at most four. Without that a pathological set of
 * existing hashes would spin on the request path.
 *
 * Dedupe is applied WITHIN the batch as well as against the project: two
 * archetypes can emit identical text from different surfaces, and the second
 * INSERT would violate `ux_prompts_project_hash` and fail the whole pass.
 */
function emitWithBackfill(input: GeneratePassInput): { accepted: readonly Candidate[]; rejected: RejectedCandidate[]; coverage: readonly ArchetypeCoverage[] } {
  const archetypes = effectiveArchetypes(input);
  const skip = new Set<string>();
  const rejected: RejectedCandidate[] = [];
  const rejectedHashes = new Set<string>();

  for (;;) {
    const emitted = emitCandidates({ bag: resolveSlots(input.context), archetypes, batchSize: input.batchSize, skipTemplateIds: skip });

    const accepted: Candidate[] = [];
    const batchHashes = new Set<string>();
    let newlySkipped = 0;

    for (const candidate of emitted.candidates) {
      const hash = promptTextHash(candidate.text);
      const hex = hash.bytes.toString("hex");
      const collides = has(input.existingHashes, hex) || batchHashes.has(hex);

      if (!collides) {
        batchHashes.add(hex);
        accepted.push(candidate);
        continue;
      }

      skip.add(candidate.templateId);
      newlySkipped += 1;
      // One row per distinct duplicate, so re-emitting the same archetype
      // across rounds does not report the same collision repeatedly.
      if (rejectedHashes.has(hex)) continue;
      rejectedHashes.add(hex);
      rejected.push({
        text: candidate.text,
        text_hash: hash.wire,
        intent_archetype: candidate.archetype,
        template_id: candidate.templateId,
        reason: "rejected_duplicate",
        conflicting_prompt_id: conflictingId(input.existingHashes, hex),
      });
    }

    // Nothing was rejected this round, so this is the final set. Coverage is
    // recomputed from the accepted candidates rather than taken from
    // `emitted`, because a rejected candidate must not count as represented.
    if (newlySkipped === 0) {
      return { accepted, rejected, coverage: coverageFor(archetypes, accepted, emitted.coverage) };
    }
  }
}

/**
 * Coverage over the ACCEPTED set.
 *
 * Taken from the accepted candidates and not from emit's own report, because
 * a candidate rejected as a duplicate was emitted but is not represented —
 * counting it would put a coverage chip against an archetype that has no
 * prompt in the project.
 */
function coverageFor(
  archetypes: readonly { key: GeneratableArchetype }[],
  accepted: readonly Candidate[],
  emitted: readonly ArchetypeCoverage[],
): readonly ArchetypeCoverage[] {
  return archetypes.map((archetype) => {
    const mine = accepted.filter((candidate) => candidate.archetype === archetype.key);
    const emittedRow = emitted.find((row) => row.intent_archetype === archetype.key);
    return {
      intent_archetype: archetype.key,
      represented: mine.length > 0,
      variant_count: mine.length,
      used_anonymous_fallback: mine.length > 0 && (emittedRow?.used_anonymous_fallback ?? false),
    };
  });
}

/**
 * A rewrite is a NEW text, so it has a new `text_hash` - and dedupe ran on the template text. Left unchecked, a rewrite equal to an
 * existing prompt (or to another line's text) violates `ux_prompts_project_hash` and fails the whole pass at INSERT.
 *
 * The template text of every candidate is already known to be unique, so it is the safe fallback: a rewrite is kept only if its hash
 * is not an existing prompt's, not another candidate's TEMPLATE hash, and not an earlier kept rewrite's. Otherwise that line (and only
 * that line) keeps its template text and is recorded as not naturalised.
 */
function keepDistinct(
  templates: readonly Candidate[],
  rewritten: readonly Candidate[],
  existing: ExistingHashes,
): readonly Candidate[] {
  const hexOf = (text: string): string => promptTextHash(text).bytes.toString("hex");
  const templateHexes = templates.map((candidate) => hexOf(candidate.text));
  const claimed = new Set<string>();
  return rewritten.map((candidate, index) => {
    if (!candidate.naturalized) return candidate;
    const hex = hexOf(candidate.text);
    const taken = has(existing, hex) || claimed.has(hex) || templateHexes.some((other, i) => i !== index && other === hex);
    if (taken) return { ...templates[index]!, naturalized: false };
    claimed.add(hex);
    return candidate;
  });
}

/**
 * One generation pass.
 *
 * Never charges anything — there is no wallet or ledger call in this file or
 * anywhere it reaches, which is what makes `FR-FAN-01g` true by construction
 * rather than by a test that happens to pass.
 */
export async function generatePass(input: GeneratePassInput): Promise<GeneratePass> {
  const topicNorm = normalizeTopic(input.topicHint ?? "");
  const requested = effectiveArchetypes(input).length * input.batchSize;

  const { accepted, rejected, coverage } = emitWithBackfill(input);

  // §4 step 4, with §8's L5 cache in front of it. The key is the NORMALISED
  // topic, so "Lead Management Platforms!" and "lead management platform"
  // share one entry — which is the whole point of step 1 feeding this.
  //
  // The key ends in a digest of the TEMPLATE lines being rewritten. Topic, locale, grammar version and batch size do not say whose
  // brand is in the text, and the cache is tenant-scoped, not project-scoped: keyed on those alone, a second project in the same
  // workspace would be served the first one's rewritten lines - its brand name inside another project's prompts. The digest makes a
  // hit mean "this exact input was rewritten before".
  const templateDigest = createHash("sha256").update(JSON.stringify(accepted.map((candidate) => candidate.text))).digest("hex").slice(0, 16);
  const cacheKey = `${topicNorm}|${input.locale ?? ""}|${GRAMMAR_VERSION}|${String(input.batchSize)}|${templateDigest}`;
  const cachedLines = await input.cache?.get(cacheKey);

  let naturalised: readonly Candidate[];
  let cached = false;

  if (cachedLines !== undefined && cachedLines.length === accepted.length) {
    naturalised = accepted.map((candidate, index) => ({ ...candidate, text: cachedLines[index]!, naturalized: true }));
    cached = true;
  } else {
    const result = await naturaliseCandidates(accepted, { naturaliser: input.naturaliser, temperature: input.temperature });
    naturalised = result.candidates;
    // ONLY a successful rewrite is cached. Storing the template text under
    // this key would make a transient model outage the permanent answer for
    // the cache's thirty days.
    if (result.naturalized && input.cache !== undefined) {
      await input.cache.set(cacheKey, result.candidates.map((candidate) => candidate.text));
    }
  }

  const candidates = prioritise(keepDistinct(accepted, naturalised, input.existingHashes), input.prioritySubsetSize);
  const rows = candidates.map((candidate) =>
    promptRowFromCandidate(candidate, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      generationBatchId: input.generationBatchId,
    }),
  );

  return {
    rows,
    candidates,
    rejected,
    coverage,
    summary: {
      requested,
      generated: accepted.length,
      accepted: accepted.length,
      rejected_duplicate: rejected.length,
      // STORY-046 owns activation. Zero here is the truth, not a placeholder —
      // and a caller who ASKS for activation is refused rather than shown it.
      activated: 0,
      priority_flagged: candidates.filter((candidate) => candidate.isPriority).length,
    },
    cached,
    topicNorm,
  };
}

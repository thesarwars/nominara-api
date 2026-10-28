// STORY-045 AC6 - the seam vector dedupe takes its candidate vectors from. Deliberately NOT the EMBEDDING_PROVIDER port.
//
// *** NOTHING BINDS THIS TOKEN, AND THAT IS A SPECIFICATION CONFLICT RATHER THAN AN OMISSION. ***
//
// §4 step 5 says "embed all 15 in one batched call" inside the generate pass, and `POST /v1/projects/{id}/prompts/generate` is a
// request handler. NFR-ARCH-01 (lint-enforced; eslint.config.js refuses the embedding-provider port outside the embed.batch handler)
// says no request handler may call an embedding provider, and NFR-ARCH-04 / ADR-0003 say no handler holds a transaction across an
// external call - which the ambient request transaction does for the whole handler. Building the bridge (an adapter importing the
// provider port into src/modules) would defeat the rule that exists to prevent exactly it.
//
// So the pass is written, tested against real pgvector with the stand-in embedder, and left unplugged, until the story's decision #5 is
// answered. Its options: (a) generation becomes a phased job (prepare / embed+rewrite outside any transaction / persist), the route
// answers 202 and the result is read back by `generation_batch_id` - a contract change; (b) NFR-ARCH-01 is amended to allow ONE bounded,
// breaker-guarded embedding call on this route; (c) vector dedupe moves after persistence, on embed.batch, and a near-duplicate is
// archived rather than refused - which changes `rejected[]` and the "keep the earlier prompt" guarantee.
//
// Until then: no embedder bound = exact `text_hash` dedupe and `novelty` null (not measured), exactly as before.

export const PROMPT_CANDIDATE_EMBEDDER = Symbol("PROMPT_CANDIDATE_EMBEDDER");

export interface CandidateEmbedder {
  /** The model the vectors are produced under; only stored prompts embedded under the same model are neighbours (EC-23). */
  readonly model: string;
  /** ONE call for the whole batch; one vector per text, in order. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

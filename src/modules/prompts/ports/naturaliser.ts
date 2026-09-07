// STORY-045 — the seam a real model-backed naturaliser fills behind, without
// PromptsService ever importing a provider SDK directly. Same port-plus-
// adapter precedent as EMAIL_SENDER (src/modules/identity/ports/
// email-sender.ts), OAUTH_CLIENT and DEK_PROVISIONER.
//
// Interface-only — no logic, no adapter, no DI wiring here.
//
// *** NO ADAPTER EXISTS, AND THAT IS A DECISION, NOT AN OMISSION. ***
//
// Which model naturalises prompt text is a dependency choice, and
// development-workflow.md §6 puts adding a dependency outside what an agent
// may decide. It is the same conversation as dev-plan.md §11.2's embedding
// provider and STORY-001's vendor accounts. Until it is answered every pass
// runs §4's `template_only` path — which is not a degraded mode but
// FR-FAN-01d's determinism guarantee and the documented fallback for an open
// circuit.
//
// TWO THINGS TO SETTLE BEFORE AN ADAPTER IS WIRED, both flagged in the story:
//
//   1. WHERE IT RUNS. `POST /v1/projects/{id}/prompts/generate` is documented
//      as synchronous, returning `variants[]` — so a naturaliser call would
//      sit on the request path. NFR-ARCH-01 forbids a request handler calling
//      "an engine, an embedding provider, or a crawl target", and a
//      naturaliser is none of those three, so the letter permits it. KAD-06 —
//      "nothing expensive on the request path; everything external is
//      enqueued" — points the other way. Resolving it may mean the endpoint
//      becomes 202-and-poll like project creation, which is a contract
//      change and belongs with whoever picks the model.
//
//   2. WHAT IT COSTS. Generation "never charges" (FR-FAN-01g), so the model
//      call is absorbed. It therefore needs metering on the internal-cost
//      path the way `embed_tokens` is metered — absorbed, never billed, but
//      visible so a runaway is not silent. No metric exists for it:
//      USAGE_METRICS holds `embed_tokens` and `arbiter_tokens` and nothing
//      for naturalisation, and adding one is a change to
//      schemas/billing-and-credits.md first.

export const PROMPT_NATURALISER = Symbol("PROMPT_NATURALISER");

export interface NaturaliseRequest {
  /**
   * The filled template lines, in order — and the ONLY content the model
   * receives (FR-FAN-01e). Already sanitised by
   * src/lib/promptgen/naturalise.ts: single-line, control characters
   * removed, individually length-bounded.
   */
  readonly lines: readonly string[];
  readonly temperature: number;
}

export interface PromptNaturaliser {
  /**
   * Rewrites each line to read like something a real buyer would type,
   * preserving every slot value, returning exactly as many lines as it was
   * given — §4 step 4's instruction verbatim.
   *
   * An implementation MAY throw or return something off-schema; the caller
   * treats both as a fallback to template text rather than as an error to
   * surface. It must NOT return a partial array believing the caller will
   * cope: a short array is discarded entirely, because pairing survivors
   * against the original candidates attaches the wrong archetype and slots to
   * real prompt text.
   */
  naturalise(request: NaturaliseRequest): Promise<readonly string[]>;
}

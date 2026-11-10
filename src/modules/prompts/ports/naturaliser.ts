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
// WHERE IT RUNS (settled, owner decision 95(a), 2026-11-10): in the `prompt.generate` job, outside any transaction. The route answers 202 and
// never awaits a model (KAD-06, NFR-ARCH-04); src/lib/queue/handlers/prompt-generate.handler.ts selects the adapter by configuration.
//
// WHAT IT COSTS (STILL OPEN): generation "never charges" (FR-FAN-01g), so the model call is absorbed. It needs metering on the internal-cost
// path the way `embed_tokens` is metered - absorbed, never billed, but visible so a runaway is not silent. No metric exists for it:
// USAGE_METRICS holds `embed_tokens` and `arbiter_tokens` and nothing for naturalisation, and adding one is a change to
// schemas/billing-and-credits.md first. It also draws from no engine rate-limit bucket yet.

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

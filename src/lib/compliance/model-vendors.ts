// STORY-111 / NFR-CMP-11 - "No training on customer data: no training pipeline exists, and prompts sent to the arbiter and the naturalizer
// are sent with vendor training opt-out enabled and documented per vendor."
//
// THE REGISTRY OF EVERY MODEL CALL THE PRODUCT MAKES, per vendor host. `model-vendors.spec.ts` scans src for the hosts model calls go to and
// FAILS if one is missing here, so a new vendor cannot be added without a recorded training-opt-out position. The position is a fact about the
// vendor ACCOUNT, which code cannot see: a status of `confirmed` requires an `evidence` reference; until the owner supplies it the status is
// `pending_owner_confirmation`, and that is what the registry says. It is never rounded up to "enabled".

export type TrainingOptOutStatus = "confirmed" | "pending_owner_confirmation";

export interface ModelVendor {
  readonly host: string;
  readonly vendor: string;
  /** Which product call sites send text to this host. */
  readonly calls: readonly string[];
  /** What is sent: public prompts and public engine answers only, or something else. */
  readonly sends: string;
  readonly trainingOptOut: TrainingOptOutStatus;
  /** Where the opt-out is documented (contract clause, dashboard setting, ticket). Required when `confirmed`. */
  readonly evidence: string | null;
}

export const MODEL_VENDORS: readonly ModelVendor[] = [
  {
    host: "generativelanguage.googleapis.com",
    vendor: "Google (Gemini API)",
    calls: ["src/lib/engines/gemini/gemini-api-adapter.ts - the Gemini answer engine"],
    sends: "Tracked prompt text (the customer's own search questions) to obtain the engine's public answer. No document bodies, no personal data by design.",
    trainingOptOut: "pending_owner_confirmation",
    evidence: null,
  },
  {
    host: "openrouter.ai",
    vendor: "OpenRouter (chat completions and embeddings; routes to downstream model providers)",
    calls: ["src/lib/engines/openrouter/openrouter-chat.ts - answer engines", "src/lib/embedding/embed-batch.ts - prompt embeddings"],
    sends: "Tracked prompt text, and prompt text for embedding. Downstream providers are chosen by OpenRouter; its account-level data-collection policy applies.",
    trainingOptOut: "pending_owner_confirmation",
    evidence: null,
  },
  {
    host: "api.openai.com",
    vendor: "OpenAI (embeddings API)",
    calls: ["src/lib/embedding/embed-batch.ts - prompt embeddings"],
    sends: "Tracked prompt text for embedding.",
    trainingOptOut: "pending_owner_confirmation",
    evidence: null,
  },
];

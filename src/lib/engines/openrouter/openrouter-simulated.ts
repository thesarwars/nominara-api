import type { OpenRouterEngineKey } from "./openrouter-adapter.js";

// Owner decision 43 - SIMULATED ENGINES, DEVELOPMENT ONLY. The chatgpt / claude / perplexity slots may be backed by free OpenRouter models
// so the multi-engine features run locally with no credit. Every result carries the `simulated` flag and the free model's id
// (answer_captures.flags / model_fingerprint, exposed in the result document), so the UI can label it ("ChatGPT (simulated · nemotron-3-ultra)").
//
// THE GUARD, in four independent places (a guard that can be refactored away is the failure this codebase keeps finding):
//   1. env.schema.ts refuses ENGINE_SIMULATION under NODE_ENV=production at boot: production config cannot set the flag.
//   2. registry.ts calls assertSimulationAllowed() before binding a simulated adapter (fail closed: it throws, it never falls back).
//   3. OpenRouterAdapter's constructor calls it again with the nodeEnv it is given.
//   4. The configured model must be a ':free' id, so a simulated slot can never spend credit under a "free" label.

export const ENGINE_SIMULATION_MODE = "openrouter-free";

/** Owner decision 43's slot models. Override per slot with OPENROUTER_SIMULATED_MODEL_<ENGINE>. */
export const SIMULATED_DEFAULT_MODELS: Readonly<Record<OpenRouterEngineKey, string>> = {
  chatgpt: "nvidia/nemotron-3-ultra-550b-a55b:free",
  claude: "google/gemma-4-31b-it:free",
  perplexity: "thinkingmachines/inkling:free",
};

export class SimulationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationRefusedError";
  }
}

export interface SimulationEnv {
  readonly NODE_ENV?: string | undefined;
  readonly ENGINE_SIMULATION?: string | undefined;
}

/** Whether the mode was asked for. Says nothing about whether it is allowed: pair it with assertSimulationAllowed. */
export function simulationEnabled(env: SimulationEnv): boolean {
  return env.ENGINE_SIMULATION === ENGINE_SIMULATION_MODE;
}

/** Throws unless the process is development or test. Not asked for => nothing to refuse. An unknown or absent NODE_ENV fails closed. */
export function assertSimulationAllowed(env: SimulationEnv): void {
  if (!simulationEnabled(env)) return;
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
    throw new SimulationRefusedError("simulated engines (ENGINE_SIMULATION) run in development only and are refused outside it");
  }
}

export function assertSimulatedModel(model: string): void {
  if (!model.endsWith(":free")) {
    throw new SimulationRefusedError("a simulated engine slot accepts only a ':free' OpenRouter model id");
  }
}

import { Logger } from "@nestjs/common";
import { GeminiNaturaliser } from "./adapters/gemini-naturaliser.js";
import type { PromptNaturaliser } from "./ports/naturaliser.js";

// STORY-045 AC3 - which PromptNaturaliser this process runs with. Same shape as embedding-provider.selector.ts.
//
//   PROMPT_NATURALISER=none (default)          -> null: every pass is the template-only path (FR-FAN-01d).
//   PROMPT_NATURALISER=gemini and a key        -> the Gemini adapter (a Flash-class model, owner decision 2026-10-28 #3).
//   PROMPT_NATURALISER=gemini and NO key       -> null, with one warning. A naturaliser is an optimisation of the text, never a
//                                                precondition of generating it, so a missing credential must not fail boot or a request.
//
// The key is read from the validated env passed in and is never logged.

export interface NaturaliserSelectionEnv {
  readonly PROMPT_NATURALISER: "none" | "gemini";
  readonly PROMPT_NATURALISER_MODEL: string;
  readonly PROMPT_NATURALISER_TIMEOUT_MS: number;
  readonly GEMINI_API_KEY?: string | undefined;
}

export function selectNaturaliser(env: NaturaliserSelectionEnv): PromptNaturaliser | null {
  if (env.PROMPT_NATURALISER === "none") return null;
  if (env.GEMINI_API_KEY === undefined || env.GEMINI_API_KEY.length === 0) {
    new Logger("prompts.naturaliser").warn({ event: "prompts.naturaliser.unconfigured", provider: env.PROMPT_NATURALISER });
    return null;
  }
  return new GeminiNaturaliser({ apiKey: env.GEMINI_API_KEY, model: env.PROMPT_NATURALISER_MODEL, timeoutMs: env.PROMPT_NATURALISER_TIMEOUT_MS });
}
